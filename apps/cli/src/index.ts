#!/usr/bin/env bun
import { waitForMcpAuthorization } from "./mcp-auth.js";
import { stat } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import { addChiliMemoryEntry, listChiliMemoryEntries } from "@chili/core";
import { resolveHostExecutionIdentity } from "@chili/host";
import type {
  RuntimeMcpAddServerRequest,
  RuntimeMcpAuthRequest,
  RuntimeMcpAuthResponse,
  RuntimeMcpListResponse,
  RuntimeMcpLogoutResponse,
  RuntimeMcpReloadResponse,
  RuntimeMcpRemoveServerResponse,
  RuntimeMcpServerDescriptor,
  RuntimeMcpStatusResponse,
  SessionId,
  SnapshotId,
} from "@chili/protocol";
import { startRuntimeHttpServer } from "@chili/server";
import { loadSkillSettings, loadSkills, updateSkillDisabledSetting, type Skill } from "@chili/skills";
import { inspectSqliteEventStore } from "@chili/store";
import { parseArgs, usage } from "./args.js";
import { applyCliEnvironmentDefaults, cliEnvironmentDefaults } from "./environment-defaults.js";
import { createCliHarness } from "./harness.js";
import { formatPromptDebugJson, formatPromptDebugText, type CliPromptDebugOutput } from "./prompt-debug.js";
import { createCliReplCommandRegistry, dispatchCliReplCommand, type CliReplCommandContext } from "./repl-commands.js";
import { runSessionCommand, runSessionPrompt } from "./runner.js";
import { resolveSession } from "./session.js";
import { revertSessionSnapshot } from "./session-recovery.js";
import { formatStoreDoctorText } from "./store-doctor.js";

async function main(): Promise<void> {
  if (process.argv[2] === "--chili-mcp-stdio-guardian") {
    const { runMcpStdioGuardianEntrypoint } = await import("@chili/mcp");
    runMcpStdioGuardianEntrypoint();
    return;
  }
  if (process.argv[2] === "--chili-process-guardian") {
    const { runProcessGuardianEntrypoint } = await import("@chili/tools");
    runProcessGuardianEntrypoint();
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    console.log(usage());
    return;
  }

  if (args.command === "skills-list" || args.command === "skills-enable" || args.command === "skills-disable") {
    await handleSkillsCommand(args);
    return;
  }

  if (args.command === "store-doctor") {
    await handleStoreDoctorCommand(args);
    return;
  }

  if (args.command === "memory-show" || args.command === "memory-add") {
    await handleMemoryCommand(args);
    return;
  }

  const mcpConnectMode: "eager" | "background" | "manual" = args.command === "mcp"
    ? "eager"
    : args.command === "serve"
      ? args.mcpMode === "off" ? "manual" : "background"
      : args.mcpMode === "eager" ? "eager" : "manual";
  const harnessInput: Parameters<typeof createCliHarness>[0] = {
    cwd: args.cwd,
    ...(args.chiliHome !== undefined ? { chiliHome: args.chiliHome } : {}),
    yes: args.yes,
    quiet: args.command === "sessions" || args.command === "prompt-debug" || args.command === "mcp" || args.json,
    mcpConnectMode,
  };
  const envDefaults = cliEnvironmentDefaults(process.env);
  const modelDefaults = applyCliEnvironmentDefaults({
    ...(args.provider !== undefined ? { provider: args.provider } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.reasoningLevel !== undefined ? { reasoningLevel: args.reasoningLevel } : {}),
  }, envDefaults);
  if (modelDefaults.provider !== undefined) harnessInput.provider = modelDefaults.provider;
  if (modelDefaults.model !== undefined) harnessInput.model = modelDefaults.model;
  if (modelDefaults.reasoningLevel !== undefined) harnessInput.reasoningLevel = modelDefaults.reasoningLevel;
  if (modelDefaults.serviceTier !== undefined) harnessInput.serviceTier = modelDefaults.serviceTier;
  const signalLifecycle = createCliShutdownLifecycle({
    signalSource: process,
    forceExit: ({ exitCode }) => process.exit(exitCode),
    onFirstSignal: ({ signal, exitCode }) => {
      const currentExitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
      process.exitCode = Math.max(currentExitCode, exitCode);
      console.log(`\n[interrupt] ${signal} received; shutting down...`);
    },
  });
  let harness: Awaited<ReturnType<typeof createCliHarness>>;
  try {
    harness = await createCliHarness(harnessInput);
    signalLifecycle.attachHarness(harness);
  } catch (error) {
    signalLifecycle.dispose();
    throw error;
  }
  let lifecycleOwnsHarness = true;

  try {
    if (signalLifecycle.signal.aborted) {
      await signalLifecycle.close();
      return;
    }
    if (args.command === "serve") {
      lifecycleOwnsHarness = false;
      signalLifecycle.dispose();
      await serve({ harness, host: args.host, port: args.port });
      return;
    }

    if (args.command === "mcp") {
      await handleMcpCommand(harness, args, signalLifecycle.signal);
      return;
    }

    if (args.command === "sessions") {
      await printSessions(harness.store);
      return;
    }

    if (args.command === "agents") {
      if (!args.resume) throw new Error("agents requires --resume <session-id>");
      await printAgents(harness, args.resume as SessionId, args.json);
      return;
    }

    if (args.command === "agent-stop" || args.command === "agent-resume") {
      if (!args.resume) throw new Error(`${args.command} requires --resume <session-id>`);
      if (!args.agentId) throw new Error(`${args.command} requires an agent id`);
      const agents = harness.agents.forSession(args.resume as SessionId);
      const input = { agentId: args.agentId as SessionId };
      const result = args.command === "agent-stop"
        ? await agents.stopAgent(input)
        : await agents.resumeAgent(input);
      console.log(jsonStringify(result));
      return;
    }

    if (args.command === "prompt-debug") {
      await printPromptDebug(harness, args);
      return;
    }

    if (args.command === "revert") {
      if (!args.resume) throw new Error("revert requires --resume <session-id>");
      if (!args.snapshotId) throw new Error("revert requires a snapshot id");
      await revertSessionSnapshot({
        service: harness.service,
        store: harness.store,
        recovery: harness.recovery,
        cwd: harness.cwd,
        resume: args.resume,
        snapshotId: args.snapshotId as SnapshotId,
      });
      console.log(`Reverted snapshot ${args.snapshotId}`);
      return;
    }

    const sessionInput = {
      service: harness.service,
      store: harness.store,
      cwd: harness.cwd,
    };
    const session = await resolveSession(args.resume ? { ...sessionInput, resume: args.resume } : sessionInput);

    console.log(`[session] ${session.sessionId}${session.isNew ? " (new)" : " (resumed)"}`);
    if (args.prompt) {
      await runSessionPrompt({
        harness,
        sessionId: session.sessionId,
        prompt: args.prompt,
        maxTurns: args.maxTurns,
        signal: signalLifecycle.signal,
      });
      // Let active agent inputs settle before closing this process.
      if (!signalLifecycle.signal.aborted) await harness.waitForAgents();
      return;
    }

    // Readline owns interactive SIGINT semantics. Keep SIGTERM under the host
    // lifecycle so service-manager shutdown still drains detached tool groups.
    signalLifecycle.releaseSigint();
    await repl({
      harness,
      sessionId: session.sessionId,
      maxTurns: args.maxTurns,
      shutdownSignal: signalLifecycle.signal,
    });
  } finally {
    try {
      if (lifecycleOwnsHarness) await signalLifecycle.close();
      else await harness.close();
    } finally {
      signalLifecycle.dispose();
    }
  }
}

async function printPromptDebug(
  harness: Awaited<ReturnType<typeof createCliHarness>>,
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  const sessionInput: Parameters<typeof resolveSession>[0] = {
    service: harness.service,
    store: harness.store,
    cwd: harness.cwd,
  };
  if (args.resume) sessionInput.resume = args.resume;
  const session = await resolveSession(sessionInput);
  const persistedSession = (await harness.store.sessions()).find((candidate) => (
    candidate.id === session.sessionId
  ));
  if (!persistedSession) throw new Error(`Session not found: ${session.sessionId}`);
  const cwd = persistedSession.cwd;

  if (args.content) {
    const inspected = await harness.service.inspectPrompt({
      sessionId: session.sessionId,
      ...(args.prompt !== undefined ? { text: args.prompt } : {}),
      includeContent: true,
    });
    const output: CliPromptDebugOutput = {
      sessionId: session.sessionId,
      cwd,
      created: session.isNew,
      debug: inspected.debug,
      fragments: inspected.fragments,
    };
    console.log(args.json ? formatPromptDebugJson(output) : formatPromptDebugText(output));
    return;
  }

  const debug = await harness.service.inspectPrompt({
    sessionId: session.sessionId,
    ...(args.prompt !== undefined ? { text: args.prompt } : {}),
  });
  const output: CliPromptDebugOutput = {
    sessionId: session.sessionId,
    cwd,
    created: session.isNew,
    debug,
  };
  console.log(args.json ? formatPromptDebugJson(output) : formatPromptDebugText(output));
}

async function serve(input: {
  harness: Awaited<ReturnType<typeof createCliHarness>>;
  host: string;
  port: number;
}): Promise<void> {
  const mcp = mcpControl(input.harness);
  const server = startRuntimeHttpServer({
    service: input.harness.service,
    store: input.harness.events,
    agents: input.harness.agents,
    permissions: input.harness.permissions,
    commands: input.harness.commands,
    ...(mcp ? { mcp } : {}),
    hostname: input.host,
    port: input.port,
  });
  console.log(`[server] ${server.url}`);
  console.log("Press Ctrl+C to stop.");

  await waitForServeShutdown({
    signalSource: process,
    closeServer: () => server.close(),
    closeHarness: () => input.harness.close(),
    forceExit: ({ exitCode }) => process.exit(exitCode),
  });
}

export type ServeShutdownSignal = "SIGINT" | "SIGTERM";
export type ServeShutdownForceReason = "deadline" | "repeated_signal";

export interface ServeShutdownForceExit {
  signal: ServeShutdownSignal;
  reason: ServeShutdownForceReason;
  exitCode: number;
}

export interface ServeShutdownDeadline {
  cancel(): void;
}

export interface ServeShutdownSignalSource {
  on(signal: ServeShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ServeShutdownSignal, listener: () => void): unknown;
}

const SERVE_SHUTDOWN_DEADLINE_MS = 12_000;
const CLI_SHUTDOWN_DEADLINE_MS = 12_000;

export interface CliShutdownLifecycle {
  readonly signal: AbortSignal;
  attachHarness(harness: { close(): Promise<void> }): void;
  close(): Promise<void>;
  releaseSigint(): void;
  dispose(): void;
}

export function createCliShutdownLifecycle(input: {
  signalSource: ServeShutdownSignalSource;
  forceExit(input: ServeShutdownForceExit): void;
  shutdownDeadlineMs?: number;
  armDeadline?(callback: () => void, delayMs: number): ServeShutdownDeadline;
  onFirstSignal?(input: { signal: ServeShutdownSignal; exitCode: number }): void;
}): CliShutdownLifecycle {
  const shutdownDeadlineMs = input.shutdownDeadlineMs ?? CLI_SHUTDOWN_DEADLINE_MS;
  if (!Number.isSafeInteger(shutdownDeadlineMs) || shutdownDeadlineMs <= 0) {
    throw new RangeError("CLI shutdown deadline must be a positive safe integer");
  }

  const controller = new AbortController();
  let harness: { close(): Promise<void> } | undefined;
  let closeStarted = false;
  let closePromise: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  let rejectClose: ((error: unknown) => void) | undefined;
  let deadline: ServeShutdownDeadline | undefined;
  let firstSignal: ServeShutdownSignal | undefined;
  let settled = false;
  let disposed = false;
  let sigintReleased = false;

  const removeSignalListeners = (): void => {
    input.signalSource.removeListener("SIGINT", onSigint);
    input.signalSource.removeListener("SIGTERM", onSigterm);
  };
  const cancelDeadline = (): void => {
    deadline?.cancel();
    deadline = undefined;
  };
  const publishClosePromise = (): Promise<void> => {
    if (!closePromise) {
      closePromise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolveClose = resolvePromise;
        rejectClose = rejectPromise;
      });
      // A signal can force shutdown while harness construction is still
      // pending and before main has a chance to await this promise.
      void closePromise.catch(() => undefined);
    }
    return closePromise;
  };
  const finish = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    disposed = true;
    cancelDeadline();
    removeSignalListeners();
    if (error === undefined) resolveClose?.();
    else rejectClose?.(error);
  };
  const startHarnessClose = (): void => {
    if (closeStarted || !harness) return;
    closeStarted = true;
    const cleanup = invokeServeShutdownOperation(() => harness?.close() ?? Promise.resolve());
    void cleanup.then(
      () => finish(),
      (error: unknown) => finish(error),
    );
  };
  const forceShutdown = (signal: ServeShutdownSignal, reason: ServeShutdownForceReason): void => {
    if (settled) return;
    settled = true;
    disposed = true;
    cancelDeadline();
    removeSignalListeners();
    const exitCode = signal === "SIGINT" ? 130 : 143;
    const error = new Error(
      reason === "deadline"
        ? `CLI shutdown exceeded ${shutdownDeadlineMs}ms`
        : `CLI shutdown was forced by repeated ${signal}`,
    );
    try {
      input.forceExit({ signal, reason, exitCode });
    } catch (forceError) {
      rejectClose?.(forceError);
      return;
    }
    rejectClose?.(error);
  };
  const armDeadline = (signal: ServeShutdownSignal): void => {
    const arm = input.armDeadline ?? armServeShutdownDeadline;
    try {
      const armedDeadline = arm(
        () => forceShutdown(signal, "deadline"),
        shutdownDeadlineMs,
      );
      if (settled) armedDeadline.cancel();
      else deadline = armedDeadline;
    } catch {
      forceShutdown(signal, "deadline");
    }
  };
  const stop = (signal: ServeShutdownSignal): void => {
    if (firstSignal) {
      forceShutdown(signal, "repeated_signal");
      return;
    }
    firstSignal = signal;
    if (signal === "SIGTERM" && sigintReleased) {
      // Readline owns Ctrl+C while the REPL is healthy. Once host shutdown
      // starts, restore SIGINT as an immediate forced-escape path.
      input.signalSource.on("SIGINT", onSigint);
      sigintReleased = false;
    }
    const exitCode = signal === "SIGINT" ? 130 : 143;
    publishClosePromise();
    try {
      input.onFirstSignal?.({ signal, exitCode });
    } catch {
      // An observer must not prevent abort or cleanup admission from closing.
    }
    controller.abort(new Error(`CLI received ${signal}`));
    startHarnessClose();
    if (!settled) armDeadline(signal);
  };
  const onSigint = (): void => stop("SIGINT");
  const onSigterm = (): void => stop("SIGTERM");

  input.signalSource.on("SIGINT", onSigint);
  input.signalSource.on("SIGTERM", onSigterm);

  return {
    signal: controller.signal,
    attachHarness(attachedHarness) {
      if (harness && harness !== attachedHarness) throw new Error("CLI shutdown harness is already attached");
      harness = attachedHarness;
      if (closePromise) startHarnessClose();
    },
    close() {
      const promise = publishClosePromise();
      startHarnessClose();
      return promise;
    },
    releaseSigint() {
      if (sigintReleased || disposed) return;
      sigintReleased = true;
      input.signalSource.removeListener("SIGINT", onSigint);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelDeadline();
      removeSignalListeners();
      if (closePromise && !settled && !closeStarted) {
        settled = true;
        resolveClose?.();
      }
    },
  };
}

export function waitForServeShutdown(input: {
  signalSource: ServeShutdownSignalSource;
  closeServer(): Promise<void>;
  closeHarness(): Promise<void>;
  forceExit(input: ServeShutdownForceExit): void;
  shutdownDeadlineMs?: number;
  armDeadline?(callback: () => void, delayMs: number): ServeShutdownDeadline;
}): Promise<void> {
  const shutdownDeadlineMs = input.shutdownDeadlineMs ?? SERVE_SHUTDOWN_DEADLINE_MS;
  if (!Number.isSafeInteger(shutdownDeadlineMs) || shutdownDeadlineMs <= 0) {
    throw new RangeError("Serve shutdown deadline must be a positive safe integer");
  }

  return new Promise<void>((resolvePromise, rejectPromise) => {
    let stopping = false;
    let settled = false;
    let deadline: ServeShutdownDeadline | undefined;
    const removeSignalListeners = (): void => {
      input.signalSource.removeListener("SIGINT", onSigint);
      input.signalSource.removeListener("SIGTERM", onSigterm);
    };
    const forceShutdown = (signal: ServeShutdownSignal, reason: ServeShutdownForceReason): void => {
      if (settled) return;
      settled = true;
      deadline?.cancel();
      deadline = undefined;
      removeSignalListeners();
      const exitCode = signal === "SIGINT" ? 130 : 143;
      const error = new Error(
        reason === "deadline"
          ? `Runtime server shutdown exceeded ${shutdownDeadlineMs}ms`
          : `Runtime server shutdown was forced by repeated ${signal}`,
      );
      try {
        input.forceExit({ signal, reason, exitCode });
      } catch (forceError) {
        rejectPromise(forceError);
        return;
      }
      // The production hook does not return. Settling here keeps injected unit
      // test hooks deterministic without pretending the shutdown was graceful.
      rejectPromise(error);
    };
    const stop = (signal: ServeShutdownSignal): void => {
      if (stopping) {
        forceShutdown(signal, "repeated_signal");
        return;
      }
      stopping = true;

      const errors: unknown[] = [];
      // Calling closeServer synchronously closes HTTP admission. Calling
      // closeHarness immediately afterwards closes runtime admission and aborts
      // in-flight prompts, allowing Bun's force-stop drain to finish.
      const serverClose = invokeServeShutdownOperation(input.closeServer);
      const harnessClose = invokeServeShutdownOperation(input.closeHarness);
      void Promise.allSettled([serverClose, harnessClose]).then((results) => {
        for (const result of results) {
          if (result.status === "rejected") errors.push(result.reason);
        }
        if (settled) return;
        settled = true;
        deadline?.cancel();
        deadline = undefined;
        removeSignalListeners();
        if (errors.length === 1) rejectPromise(errors[0]);
        else if (errors.length > 1) {
          rejectPromise(new AggregateError(errors, "Runtime server shutdown encountered multiple errors"));
        } else {
          resolvePromise();
        }
      });

      const armDeadline = input.armDeadline ?? armServeShutdownDeadline;
      try {
        const armedDeadline = armDeadline(
          () => forceShutdown(signal, "deadline"),
          shutdownDeadlineMs,
        );
        if (settled) armedDeadline.cancel();
        else deadline = armedDeadline;
      } catch {
        // Failure to install the only bound must itself fail closed.
        forceShutdown(signal, "deadline");
      }
    };
    const onSigint = (): void => stop("SIGINT");
    const onSigterm = (): void => stop("SIGTERM");

    input.signalSource.on("SIGINT", onSigint);
    input.signalSource.on("SIGTERM", onSigterm);
  });
}

function armServeShutdownDeadline(callback: () => void, delayMs: number): ServeShutdownDeadline {
  const timer = setTimeout(callback, delayMs);
  return { cancel: () => clearTimeout(timer) };
}

function invokeServeShutdownOperation(operation: () => Promise<void>): Promise<void> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

interface CliMcpControl {
  list(input?: { cwd?: string }): Promise<RuntimeMcpListResponse>;
  status?(input?: { cwd?: string }): Promise<RuntimeMcpStatusResponse>;
  reload?(input?: { cwd?: string }): Promise<RuntimeMcpReloadResponse>;
  add?(input: RuntimeMcpAddServerRequest): Promise<RuntimeMcpServerDescriptor>;
  remove?(server: string): Promise<RuntimeMcpRemoveServerResponse>;
  auth?(server: string, input?: RuntimeMcpAuthRequest, scope?: { cwd?: string }): Promise<RuntimeMcpAuthResponse>;
  logout?(server: string, scope?: { cwd?: string }): Promise<RuntimeMcpLogoutResponse>;
}

async function handleMcpCommand(
  harness: Awaited<ReturnType<typeof createCliHarness>>,
  args: ReturnType<typeof parseArgs>,
  signal: AbortSignal,
): Promise<void> {
  const control = mcpControl(harness);
  const action = args.mcpAction ?? "list";
  if (!control) {
    printMcpUnavailable(action, args.json);
    return;
  }

  if (action === "list") {
    const result = await control.list({ cwd: harness.cwd });
    printMcpList(result, args.json);
    return;
  }
  if (action === "status") {
    const scope = { cwd: harness.cwd };
    const result = control.status ? await control.status(scope) : statusFromMcpList(await control.list(scope));
    if (args.mcpServer) {
      const server = result.servers.find((item) => item.name === args.mcpServer);
      if (!server) throw new Error(`MCP server not found: ${args.mcpServer}`);
      printMcpServer(server, args.json);
      return;
    }
    printMcpStatus(result, args.json);
    return;
  }
  if (action === "reload") {
    if (!control.reload) throw new Error("MCP reload is not supported by the configured manager");
    const result = await control.reload({ cwd: harness.cwd });
    printMcpReload(result, args.json);
    return;
  }
  if (action === "add") {
    if (!control.add) throw new Error("MCP add is not supported by the configured manager");
    const result = await control.add(mcpAddInput(args));
    printMcpServer(result, args.json);
    return;
  }
  if (action === "remove") {
    if (!args.mcpServer) throw new Error("mcp remove requires a server name");
    if (!control.remove) throw new Error("MCP remove is not supported by the configured manager");
    const result = await control.remove(args.mcpServer);
    printMcpMutation("remove", result, args.json);
    return;
  }
  if (action === "auth") {
    if (!args.mcpServer) throw new Error("mcp auth requires a server name");
    if (!control.auth) throw new Error("MCP auth is not supported by the configured manager");
    const result = await control.auth(args.mcpServer, mcpAuthInput(args), { cwd: harness.cwd });
    printMcpMutation("auth", result, args.json);
    if (result.status === "pending") {
      await waitForMcpAuthorization(control, args.mcpServer, harness.cwd, signal);
      printMcpMutation("auth", { server: args.mcpServer, status: "authenticated" }, args.json);
    }
    return;
  }
  if (action === "logout") {
    if (!args.mcpServer) throw new Error("mcp logout requires a server name");
    if (!control.logout) throw new Error("MCP logout is not supported by the configured manager");
    const result = await control.logout(args.mcpServer, { cwd: harness.cwd });
    printMcpMutation("logout", result, args.json);
  }
}

function mcpControl(harness: unknown): CliMcpControl | undefined {
  if (!isRecord(harness)) return undefined;
  const mcp = harness.mcp;
  if (!isRecord(mcp) || typeof mcp.list !== "function") return undefined;
  return mcp as unknown as CliMcpControl;
}

function printMcpUnavailable(action: string, asJson: boolean): void {
  const message = "MCP manager is not configured. TODO: wire createCliHarness().mcp to the runtime MCP manager.";
  if (asJson) {
    console.log(jsonStringify({ action, supported: false, error: { message } }));
    return;
  }
  console.log(`[mcp] ${message}`);
}

function printMcpList(result: RuntimeMcpListResponse, asJson: boolean): void {
  if (asJson) {
    console.log(jsonStringify(result));
    return;
  }
  if (result.servers.length === 0) {
    console.log("No MCP servers configured.");
    return;
  }
  for (const server of result.servers) console.log(formatMcpServerLine(server));
}

function printMcpStatus(result: RuntimeMcpStatusResponse, asJson: boolean): void {
  if (asJson) {
    console.log(jsonStringify(result));
    return;
  }
  const summary = result.summary;
  console.log(
    `[mcp] total=${summary.total}\trunning=${summary.running}\tdisabled=${summary.disabled}\tauth_required=${summary.authRequired}\terrored=${summary.errored}`,
  );
  for (const server of result.servers) console.log(formatMcpServerLine(server));
}

function printMcpReload(result: RuntimeMcpReloadResponse, asJson: boolean): void {
  if (asJson) {
    console.log(jsonStringify(result));
    return;
  }
  console.log(`[mcp] reloaded=${result.reloaded}\tservers=${result.servers.length}\terrors=${result.errors.length}`);
  for (const error of result.errors) console.log(`[mcp:error]\t${error.server ?? "-"}\t${error.message}`);
  for (const server of result.servers) console.log(formatMcpServerLine(server));
}

function printMcpServer(server: RuntimeMcpServerDescriptor, asJson: boolean): void {
  console.log(asJson ? jsonStringify(server) : formatMcpServerLine(server));
}

function printMcpMutation(label: string, value: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(jsonStringify(value));
    return;
  }
  if (isRecord(value) && typeof value.server === "string") {
    console.log(`[mcp:${label}]\t${value.server}\t${JSON.stringify(value)}`);
    return;
  }
  console.log(`[mcp:${label}]\t${JSON.stringify(value)}`);
}

function formatMcpServerLine(server: RuntimeMcpServerDescriptor): string {
  return [
    server.name,
    server.status,
    server.enabled ? "enabled" : "disabled",
    server.transport ?? "-",
    `auth=${server.auth?.required ? (server.auth.authenticated ? "authenticated" : "required") : "none"}`,
    `tools=${server.toolCount ?? "?"}`,
    server.url ?? server.command ?? "-",
    server.error ?? "",
  ].join("\t");
}

function statusFromMcpList(result: RuntimeMcpListResponse): RuntimeMcpStatusResponse {
  const summary = {
    total: result.servers.length,
    running: result.servers.filter((server) => server.status === "running").length,
    disabled: result.servers.filter((server) => !server.enabled || server.status === "disabled").length,
    authRequired: result.servers.filter((server) => server.status === "auth_required" || server.auth?.required && !server.auth.authenticated).length,
    errored: result.servers.filter((server) => server.status === "error").length,
  };
  return { servers: result.servers, summary };
}

function mcpAddInput(args: ReturnType<typeof parseArgs>): RuntimeMcpAddServerRequest {
  if (!args.mcpServer) throw new Error("mcp add requires a server name");
  const input: RuntimeMcpAddServerRequest = { name: args.mcpServer };
  if (args.mcpTransport) input.transport = args.mcpTransport;
  if (args.mcpCommand) input.command = args.mcpCommand;
  if (args.mcpArgs) input.args = args.mcpArgs;
  if (args.mcpEnv) input.env = args.mcpEnv;
  if (args.mcpUrl) input.url = args.mcpUrl;
  if (args.mcpDescription) input.description = args.mcpDescription;
  if (args.mcpEnabled !== undefined) input.enabled = args.mcpEnabled;
  return input;
}

function mcpAuthInput(args: ReturnType<typeof parseArgs>): RuntimeMcpAuthRequest {
  const input: RuntimeMcpAuthRequest = {};
  if (args.mcpCallbackUrl) input.callbackUrl = args.mcpCallbackUrl;
  if (args.mcpScopes) input.scopes = args.mcpScopes;
  return input;
}

async function printSessions(store: Awaited<ReturnType<typeof createCliHarness>>["store"]): Promise<void> {
  const sessions = await store.sessions();
  if (sessions.length === 0) {
    console.log("No sessions yet.");
    return;
  }
  for (const session of sessions) {
    console.log(`${session.id}\t${session.status}\t${new Date(session.updatedAt).toISOString()}\t${session.cwd}`);
  }
}

async function printAgents(
  harness: Awaited<ReturnType<typeof createCliHarness>>,
  sessionId: SessionId,
  asJson = false,
): Promise<void> {
  const agents = await harness.agents.forSession(sessionId).listAgents({});
  if (asJson) {
    console.log(jsonStringify(agents));
    return;
  }
  if (agents.length === 0) console.log("No agents yet.");
  for (const agent of agents) {
    console.log([agent.agentId, agent.state, agent.path, agent.name].join("\t"));
  }
}

async function handleStoreDoctorCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
  const dbPath = join(resolvePath(args.cwd), ".chili", "chili.sqlite");
  if (!(await fileExists(dbPath))) {
    const missing = { path: dbPath, exists: false };
    console.log(args.json ? jsonStringify(missing) : `No store database found at ${dbPath}`);
    return;
  }

  const report = await inspectSqliteEventStore(dbPath);
  console.log(args.json ? jsonStringify(report) : formatStoreDoctorText(report));
}

type MemoryScopeArg = "user" | "project" | "all" | undefined;
type CliMemoryContext = Pick<Parameters<typeof listChiliMemoryEntries>[0], "cwd" | "chiliHome" | "projectRoot" | "projectId">;

async function handleMemoryCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
  const context = await cliMemoryContext(args.cwd, args.chiliHome);
  if (args.command === "memory-add") {
    if (!args.prompt) throw new Error("memory add requires text");
    await addMemory(context, args.prompt, args.memoryScope);
    return;
  }
  await printMemory(context, args.memoryScope);
}

async function printMemory(
  context: CliMemoryContext,
  scope: MemoryScopeArg,
): Promise<void> {
  const entries = await listChiliMemoryEntries({ ...context, scope: scope ?? "all" });
  console.log("[memory] Explicit Markdown file inspection; Agents read Memory through file tools as needed.");
  if (entries.length === 0) {
    console.log("No Memory Markdown files found in the selected scope.");
    return;
  }

  for (const entry of entries) {
    console.log(`[memory] ${entry.scope}\t${entry.path}`);
    console.log(entry.text);
    console.log("");
  }
}

async function addMemory(
  context: CliMemoryContext,
  text: string,
  scope: MemoryScopeArg,
): Promise<void> {
  const result = await addChiliMemoryEntry({
    ...context,
    text,
    scope: memoryWriteScope(scope),
  });
  console.log(`[memory] saved ${result.scope}: ${result.path}`);
  console.log(result.text);
}

async function handleSkillsCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
  const identity = await resolveHostExecutionIdentity({ cwd: args.cwd, ...(args.chiliHome !== undefined ? { chiliHome: args.chiliHome } : {}) });
  const context = { cwd: identity.workspaceRoot, chiliHome: identity.profilePath, projectRoot: identity.projectRoot };
  if (args.command === "skills-list") {
    await printSkills(context, args.json);
    return;
  }
  if (!args.skillName) throw new Error("skills enable/disable requires a skill name");
  const scope = args.skillScope ?? "project";
  const disabled = args.command === "skills-disable";
  const snapshot = await updateSkillDisabledSetting({
    ...context,
    scope,
    name: args.skillName,
    disabled,
  });
  const state = snapshot.disabledSkillNames.includes(args.skillName) ? "disabled" : "enabled";
  const path = scope === "user" ? snapshot.userPath : snapshot.projectPath;
  console.log(`[skills] ${args.skillName}\t${state}\t${scope}\t${path}`);
}

async function printSkills(context: Parameters<typeof loadSkillSettings>[0], asJson: boolean): Promise<void> {
  const settings = await loadSkillSettings(context);
  const result = await loadSkills({
    ...context,
    includeDisabled: true,
    disabledSkills: [],
  });
  const disabled = new Set(settings.disabledSkillNames);
  const skills = result.allSkills.map((skill) => skillListItem(skill, disabled));
  if (asJson) {
    console.log(jsonStringify({
      disabledSkillNames: settings.disabledSkillNames,
      userPath: settings.userPath,
      projectPath: settings.projectPath,
      skills,
    }));
    return;
  }
  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }
  for (const skill of skills) {
    console.log([
      skill.name,
      skill.disabled ? "disabled" : "enabled",
      skill.source,
      skill.filePath,
      skill.description,
    ].join("\t"));
  }
}

async function cliMemoryContext(cwd: string, chiliHome?: string) {
  const identity = await resolveHostExecutionIdentity({ cwd, ...(chiliHome !== undefined ? { chiliHome } : {}) });
  return { cwd: identity.workspaceRoot, chiliHome: identity.profilePath, projectRoot: identity.projectRoot, projectId: identity.projectId };
}

function skillListItem(skill: Skill, disabled: Set<string>): {
  name: string;
  disabled: boolean;
  source: Skill["source"];
  filePath: string;
  baseDir: string;
  description: string;
} {
  return {
    name: skill.name,
    disabled: disabled.has(skill.name),
    source: skill.source,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    description: skill.metadata.description,
  };
}

function memoryWriteScope(scope: MemoryScopeArg): "user" | "project" {
  if (!scope) return "project";
  if (scope === "user" || scope === "project") return scope;
  throw new Error("memory add requires --user or --project, not --all");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => {
      if (item instanceof Error) return item.message;
      return item;
    },
    2,
  );
}

async function repl(input: {
  harness: Awaited<ReturnType<typeof createCliHarness>>;
  sessionId: SessionId;
  maxTurns: number;
  shutdownSignal: AbortSignal;
}): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const persistedSession = (await input.harness.store.sessions()).find((session) => session.id === input.sessionId);
  if (!persistedSession) throw new Error(`Session not found: ${input.sessionId}`);
  const sessionCwd = persistedSession.cwd;
  const commandRegistry = createCliReplCommandRegistry(await input.harness.commands.list({ cwd: sessionCwd }));
  const commandContext: CliReplCommandContext = {
    sessionId: input.sessionId,
    cwd: sessionCwd,
    listSessions: async () => printSessions(input.harness.store),
    setModel: async (sessionId, selection) => {
      const config = await input.harness.service.setModel({ sessionId, modelSelection: selection });
      console.log(`[model] ${config.modelSelection?.provider ?? selection.provider}/${config.modelSelection?.model ?? selection.model}`);
    },
    setReasoning: async (sessionId, reasoningLevel) => {
      const config = await input.harness.service.setReasoning({ sessionId, reasoningLevel });
      console.log(`[thinking] ${config.reasoningLevel ?? reasoningLevel}`);
    },
    setServiceTier: async (sessionId, serviceTier) => {
      const config = await input.harness.service.setServiceTier({ sessionId, serviceTier });
      console.log(`[service] ${config.serviceTier ?? serviceTier}`);
    },
    compactSession: async (sessionId, focus) => {
      const interrupt = installReplInterruptHandler(input.shutdownSignal);
      const compactInput: {
        sessionId: SessionId;
        instructions?: string;
        signal: AbortSignal;
      } = {
        sessionId,
        signal: interrupt.signal,
      };
      if (focus) compactInput.instructions = focus;
      try {
        const result = await input.harness.service.compactSession(compactInput);
        if (result.status === "skipped") console.log(`[context] compact skipped: ${result.reason}`);
        else if (result.status === "failed" || result.status === "cancelled") console.error(`[context] compact ${result.status}: ${result.error.message}`);
      } finally {
        interrupt.dispose();
      }
    },
    revertSession: async (sessionId, snapshotId) => {
      await input.harness.recovery.revert({ sessionId, snapshotId: snapshotId as never });
      console.log(`Reverted snapshot ${snapshotId}`);
    },
    showDelegation: async (sessionId, policy) => {
      const config = policy
        ? await input.harness.service.setDelegationPolicy({ sessionId, policy })
        : await input.harness.service.getDelegationConfig(sessionId);
      console.log(`[delegation] ${config.policy} (${config.source})`);
    },
    showAgents: async (sessionId) => printAgents(input.harness, sessionId),
    stopAgent: async (sessionId, agentId) => {
      await input.harness.agents.forSession(sessionId).stopAgent({ agentId: agentId as SessionId });
      console.log(`[agent] stopped ${agentId}`);
    },
    resumeAgent: async (sessionId, agentId) => {
      const result = await input.harness.agents.forSession(sessionId).resumeAgent({ agentId: agentId as SessionId });
      console.log(jsonStringify(result));
    },
    showMemory: async (cwd, scope) => handleMemoryReplCommand(input.harness, `show ${scope}`.trim(), cwd),
    addMemory: async (cwd, value) => input.harness.service.withSessionOperation(input.sessionId,
      () => handleMemoryReplCommand(input.harness, `add ${value}`.trim(), cwd)),
    runPromptCommand: async (sessionId, commandId, args) => {
      const interrupt = installReplInterruptHandler(input.shutdownSignal);
      try {
        await runSessionCommand({
          harness: input.harness,
          sessionId,
          commandId,
          ...(args ? { args } : {}),
          maxTurns: input.maxTurns,
          signal: interrupt.signal,
        });
      } finally {
        interrupt.dispose();
      }
    },
  };
  console.log("Type /help for commands, /app exit to quit.");
  try {
    while (true) {
      if (input.shutdownSignal.aborted) return;
      let answer: string;
      try {
        answer = await rl.question("chili> ", { signal: input.shutdownSignal });
      } catch (error) {
        if (input.shutdownSignal.aborted) return;
        throw error;
      }
      if (input.shutdownSignal.aborted) return;
      const line = answer.trim();
      if (!line) continue;
      const command = await dispatchCliReplCommand(commandRegistry, commandContext, line);
      if (input.shutdownSignal.aborted) return;
      if (command.status === "exit") return;
      if (command.status === "handled") {
        if (command.output) console.log(command.output);
        continue;
      }
      if (command.status === "error") {
        console.error(command.output ?? "Command failed.");
        continue;
      }

      const interrupt = installReplInterruptHandler(input.shutdownSignal);
      try {
        await runSessionPrompt({
          harness: input.harness,
          sessionId: input.sessionId,
          prompt: line,
          maxTurns: input.maxTurns,
          signal: interrupt.signal,
        });
      } finally {
        interrupt.dispose();
      }
    }
  } finally {
    rl.close();
  }
}

async function handleMemoryReplCommand(
  harness: Awaited<ReturnType<typeof createCliHarness>>,
  command: string,
  cwd = harness.cwd,
): Promise<void> {
  const action = command.split(/\s+/, 1)[0] || "show";
  const rest = command.slice(action.length).trim();
  const context = await cliMemoryContext(cwd, harness.identity.profilePath);
  if (action === "show" || action === "list") {
    await printMemory(context, parseReplMemoryScope(rest));
    return;
  }
  if (action === "add") {
    const parsed = parseReplMemoryAdd(rest);
    if (!parsed.text) throw new Error("/memory add requires text");
    await addMemory(context, parsed.text, parsed.scope);
    return;
  }
  throw new Error(`Unknown /memory command: ${action}`);
}

function parseReplMemoryScope(input: string): MemoryScopeArg {
  if (!input) return undefined;
  if (input === "--user" || input === "user") return "user";
  if (input === "--project" || input === "project") return "project";
  if (input === "--all" || input === "all") return "all";
  throw new Error("memory scope must be user, project, or all");
}

function parseReplMemoryAdd(input: string): { scope: MemoryScopeArg; text: string } {
  const flag = input.split(/\s+/, 1)[0];
  if (flag === "--user" || flag === "--project") {
    return { scope: flag === "--user" ? "user" : "project", text: input.slice(flag.length).trim() };
  }
  if (flag?.startsWith("--")) throw new Error("memory add requires --user or --project followed by text");
  return { scope: "project", text: input.trim() };
}

function installReplInterruptHandler(shutdownSignal: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  let disposed = false;
  const onSigint = (): void => {
    console.log("\n[interrupt] cancelling current turn...");
    controller.abort(new Error("CLI received SIGINT"));
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    process.removeListener("SIGINT", onSigint);
    shutdownSignal.removeEventListener("abort", onShutdown);
  };
  const onShutdown = (): void => {
    controller.abort(shutdownSignal.reason ?? new Error("CLI is shutting down"));
  };
  process.once("SIGINT", onSigint);
  if (shutdownSignal.aborted) onShutdown();
  else shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  controller.signal.addEventListener("abort", dispose, { once: true });
  return { signal: controller.signal, dispose };
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`chili: ${err.message}`);
    const currentExitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    process.exitCode = Math.max(currentExitCode, 1);
  });
}
