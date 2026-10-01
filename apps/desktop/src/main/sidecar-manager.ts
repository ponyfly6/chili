import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";
import { isTransientEvent, type ChiliEvent } from "@chili/protocol";
import {
  EventCursorResyncRequiredError,
  EventTransportResyncRequiredError,
  HttpRuntimeClient,
  type RuntimeClient,
} from "@chili/sdk";
import type { DesktopState } from "../shared/contracts.js";
import { SIDECAR_GRACEFUL_SHUTDOWN_FRAME } from "../sidecar/parent-loss-watchdog.js";
import {
  processGroupExists,
  terminateProcessGroup,
  type TerminateProcessGroupOptions,
} from "./process-groups.js";
import {
  encodeSidecarCredentialFrame,
  observeSidecarControlStream,
  observeSidecarTermination,
  redactControlLog,
  SIDECAR_CREDENTIAL_FD,
  SIDECAR_CREDENTIAL_HANDSHAKE_TIMEOUT_MS,
  type SidecarExitInfo as ChildExitInfo,
  type SidecarReadyMessage,
} from "./sidecar-control-stream.js";
import { safeDesktopErrorMessage } from "../shared/safe-error.js";
import { gitSupervisorLaunch, type GitSupervisorLaunch } from "./git-supervisor-launch.js";

const CONTAINMENT_DEADLINE_MS = 9_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 2_500;
const CONTROL_DRAIN_TIMEOUT_MS = 250;
const MAX_RESTARTS = 3;
const RESTART_DELAYS_MS = [250, 750, 2_000] as const;
const STABLE_HEALTH_WINDOW_MS = 30_000;

class SidecarContainmentError extends Error {
  override readonly name = "SidecarContainmentError";
}

export interface SidecarProcessGroupOperations {
  terminate(leaderPid: number, options: TerminateProcessGroupOptions): Promise<void>;
  exists(leaderPid: number): boolean;
}

const DEFAULT_PROCESS_GROUP_OPERATIONS: SidecarProcessGroupOperations = {
  terminate: terminateProcessGroup,
  exists: processGroupExists,
};

export interface SidecarManagerOptions {
  repositoryRoot: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  spawnSidecar?(input: {
    workspace: string;
    token: string;
    env: NodeJS.ProcessEnv;
  }): ChildProcessWithoutNullStreams;
  healthCheck?(input: {
    endpoint: URL;
    token: string;
    exit: Promise<ChildExitInfo>;
  }): Promise<void>;
  processGroups?: SidecarProcessGroupOperations;
  onState?(state: DesktopState, generation: number): void;
  onEvent?(event: ChiliEvent, generation: number): void;
  onResync?(reason: string): void;
  onLog?(stream: "stdout" | "stderr", text: string): void;
}

export class SidecarManager {
  private workspace: string | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private client: RuntimeClient | undefined;
  private token: string | undefined;
  private endpoint: URL | undefined;
  private phase: DesktopState["sidecar"]["phase"] = "idle";
  private error: string | undefined;
  private attempt = 0;
  private consecutiveFailures = 0;
  private generation = 0;
  private stopping = false;
  private terminallyStopped = false;
  private eventController: AbortController | undefined;
  private queuedBySession: Record<string, number> = Object.create(null) as Record<string, number>;
  private restartPromise: Promise<void> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveRestartTimer: (() => void) | undefined;
  private stabilityTimer: ReturnType<typeof setTimeout> | undefined;
  private sidecarPid: number | undefined;
  private toolProcessGroups = new Set<number>();
  private disposeOutput: (() => void) | undefined;
  private childExit: Promise<ChildExitInfo> | undefined;
  private childClosed: Promise<ChildExitInfo> | undefined;
  private lifecycleActor: Promise<void> = Promise.resolve();
  private lifecycleIntent = 0;
  private activeLifecycleCancellation: AbortController | undefined;

  constructor(private readonly options: SidecarManagerOptions) {}

  gitSupervisorLaunch(): Promise<GitSupervisorLaunch> {
    return gitSupervisorLaunch(this.options);
  }

  state(): DesktopState {
    const state: DesktopState = {
      sidecar: { phase: this.phase, attempt: this.attempt },
      queuedBySession: Object.fromEntries(Object.entries(this.queuedBySession)),
    };
    if (this.workspace) state.workspace = this.workspace;
    if (this.error) state.sidecar.error = this.error;
    return state;
  }

  getClient(): RuntimeClient {
    if (this.phase !== "healthy" || !this.client) throw new Error("Chili sidecar is not ready");
    return this.client;
  }

  getClientContext(): { client: RuntimeClient; generation: number } {
    return { client: this.getClient(), generation: this.generation };
  }

  currentGeneration(): number {
    return this.generation;
  }

  currentWorkspace(): string | undefined {
    return this.workspace;
  }

  currentSidecarPidForSmoke(): number | undefined {
    return this.sidecarPid;
  }

  setQueuedCount(sessionId: string, count: number): void {
    if (count > 0) this.queuedBySession[sessionId] = count;
    else delete this.queuedBySession[sessionId];
    this.emitState();
  }

  async switchWorkspace(input: string, afterStop?: () => Promise<void>): Promise<void> {
    if (this.terminallyStopped) throw new Error("Sidecar manager has been stopped");
    const intent = ++this.lifecycleIntent;
    this.activeLifecycleCancellation?.abort(new Error("Sidecar lifecycle request was superseded"));
    const cancellation = new AbortController();
    this.activeLifecycleCancellation = cancellation;
    return this.withLifecycleActor(async () => {
      try {
        await this.switchWorkspaceInside(input, intent, cancellation.signal, afterStop);
      } finally {
        if (this.activeLifecycleCancellation === cancellation) this.activeLifecycleCancellation = undefined;
      }
    });
  }

  private async switchWorkspaceInside(
    input: string,
    intent: number,
    signal: AbortSignal,
    afterStop?: () => Promise<void>,
  ): Promise<void> {
    const workspace = await canonicalDirectory(input);
    if (this.terminallyStopped || intent !== this.lifecycleIntent || signal.aborted) return;
    if (this.workspace === workspace && this.phase === "healthy") return;
    await this.stopChild();
    await afterStop?.();
    if (this.terminallyStopped || intent !== this.lifecycleIntent || signal.aborted) return;
    this.workspace = workspace;
    this.queuedBySession = Object.create(null) as Record<string, number>;
    this.consecutiveFailures = 0;
    this.attempt = 0;
    try {
      await this.launch(signal);
    } catch (error) {
      this.noteFailureAndSchedule(error, this.generation, workspace);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.terminallyStopped = true;
    ++this.lifecycleIntent;
    this.stopping = true;
    this.activeLifecycleCancellation?.abort(new Error("Sidecar stop requested"));
    if (this.child) requestGracefulSidecarShutdown(this.child);
    return this.withLifecycleActor(() => this.stopInside());
  }

  private async stopInside(): Promise<void> {
    this.workspace = undefined;
    this.queuedBySession = Object.create(null) as Record<string, number>;
    await this.stopChild();
    this.setPhase("idle");
  }

  private withLifecycleActor<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleActor.catch(() => undefined).then(operation);
    this.lifecycleActor = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async launch(signal?: AbortSignal): Promise<void> {
    const workspace = this.workspace;
    if (!workspace || signal?.aborted || this.terminallyStopped) return;
    const generation = ++this.generation;
    this.stopping = false;
    this.setPhase(this.consecutiveFailures === 0 ? "starting" : "recovering");
    const token = randomBytes(32).toString("base64url");
    const child = this.spawnSidecar(workspace, token);
    const credentialDelivery = deliverSidecarCredential(child, token);
    const termination = observeSidecarTermination(child);
    const toolProcessGroups = new Set<number>();
    let launchHealthy = false;
    let controlFatalError: Error | undefined;
    let rejectControlFatal: ((error: Error) => void) | undefined;
    let disposeControlStream = (): void => undefined;
    const controlFatal = new Promise<never>((_resolve, reject) => {
      rejectControlFatal = reject;
    });
    // A post-ready fatal can arrive before startup reaches its next await.
    // Keep the rejection observed while each startup stage races it below.
    void controlFatal.catch(() => undefined);
    const output = observeSidecarControlStream(child.stdout, termination.exit, token, {
      onProcess: (message) => {
        if (message.action === "started") toolProcessGroups.add(message.pid);
        else toolProcessGroups.delete(message.pid);
      },
      onLog: (text) => this.options.onLog?.("stdout", text),
      onFatal: (error) => {
        if (controlFatalError) return;
        controlFatalError = error;
        rejectControlFatal?.(error);
        if (launchHealthy) {
          void this.withLifecycleActor(
            () => this.handleControlStreamFatal(
              generation,
              workspace,
              child,
              toolProcessGroups,
              disposeControlStream,
              termination,
              error,
            ),
          );
        }
      },
    });
    disposeControlStream = output.dispose;
    this.child = child;
    this.childExit = termination.exit;
    this.childClosed = termination.closed;
    this.toolProcessGroups = toolProcessGroups;
    this.disposeOutput = output.dispose;
    this.token = token;
    let ready: SidecarReadyMessage;
    try {
      ready = await raceWithAbort(Promise.race([
        Promise.all([credentialDelivery, output.ready]).then(([, message]) => message),
        controlFatal,
      ]), signal);
      if (controlFatalError) throw controlFatalError;
      if (ready.pid !== child.pid) throw new Error("Sidecar ready PID did not match the spawned child");
      if (generation !== this.generation || this.stopping) throw new Error("Sidecar startup was superseded");
      const endpoint = requireLoopbackEndpoint(ready.url);
      if (this.options.healthCheck) {
        await raceWithAbort(
          Promise.race([
            this.options.healthCheck({ endpoint, token, exit: termination.exit }),
            controlFatal,
          ]),
          signal,
        );
      } else {
        await raceWithAbort(
          Promise.race([waitForHealth(endpoint, token, termination.exit), controlFatal]),
          signal,
        );
      }
      if (controlFatalError) throw controlFatalError;
      if (generation !== this.generation || this.stopping) throw new Error("Sidecar startup was superseded");
      this.endpoint = endpoint;
      this.sidecarPid = ready.pid;
      this.client = new HttpRuntimeClient({ baseUrl: endpoint.href, fetch: authenticatedFetch(token) });
      this.error = undefined;
      this.setPhase("healthy");
      this.armStableHealthWindow(generation, workspace, child);
      void this.consumeEvents(generation, this.client);
      launchHealthy = true;
    } catch (error) {
      await terminateManagedLaunch({
        child,
        toolProcessGroups,
        termination,
        disposeOutput: output.dispose,
        mode: "force",
        processGroups: this.options.processGroups ?? DEFAULT_PROCESS_GROUP_OPERATIONS,
      });
      this.clearLaunch(child);
      if (signal?.aborted || generation !== this.generation || this.stopping) return;
      this.error = safeErrorMessage(error);
      this.setPhase("error", this.error);
      throw error;
    }

    void termination.exit.then((info) => this.withLifecycleActor(
      () => this.handleUnexpectedClose(
        generation,
        workspace,
        child,
        toolProcessGroups,
        output.dispose,
        termination.closed,
        info,
      ),
    ));
  }

  private async handleControlStreamFatal(
    generation: number,
    workspace: string,
    child: ChildProcessWithoutNullStreams,
    toolProcessGroups: Set<number>,
    disposeOutput: () => void,
    termination: { exit: Promise<ChildExitInfo>; closed: Promise<ChildExitInfo> },
    error: Error,
  ): Promise<void> {
    if (generation !== this.generation || this.stopping || this.child !== child) return;
    this.options.onLog?.("stderr", `sidecar control stream failed: ${safeErrorMessage(error)}`);
    const cleanupGeneration = ++this.generation;
    this.cancelStableHealthWindow();
    this.client = undefined;
    this.endpoint = undefined;
    this.token = undefined;
    this.sidecarPid = undefined;
    this.eventController?.abort();
    this.eventController = undefined;
    this.setPhase("recovering");

    try {
      await terminateManagedLaunch({
        child,
        toolProcessGroups,
        termination,
        disposeOutput,
        mode: "force",
        processGroups: this.options.processGroups ?? DEFAULT_PROCESS_GROUP_OPERATIONS,
      });
    } catch (cleanupError) {
      this.noteFailureAndSchedule(cleanupError, cleanupGeneration, workspace);
      return;
    }
    if (cleanupGeneration !== this.generation || this.stopping || this.child !== child) return;
    this.clearLaunch(child);
    this.noteFailureAndSchedule(error, cleanupGeneration, workspace);
  }

  private spawnSidecar(workspace: string, token: string): ChildProcessWithoutNullStreams {
    const env = cleanChildEnvironment({
      CHILI_DESKTOP_PARENT_PID: String(process.pid),
      CHILI_DESKTOP_WORKSPACE: workspace,
    });
    const child = this.options.spawnSidecar
      ? this.options.spawnSidecar({ workspace, token, env })
      : spawn(
          this.options.isPackaged
            ? resolve(this.options.resourcesPath ?? process.resourcesPath, "chili-sidecar")
            : process.env.CHILI_BUN_PATH?.trim() || "bun",
          this.options.isPackaged
            ? []
            : ["run", resolve(this.options.repositoryRoot, "apps/desktop/src/sidecar/entry.ts")],
          {
            cwd: workspace,
            env,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe", "pipe"],
          },
        );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.options.onLog?.("stderr", redactControlLog(chunk, token)));
    return child;
  }

  private noteFailureAndSchedule(error: unknown, generation: number, workspace: string): void {
    if (this.stopping || this.workspace !== workspace || this.generation !== generation) return;
    this.cancelStableHealthWindow();
    if (error instanceof SidecarContainmentError) {
      this.error = error.message;
      this.setPhase("error", this.error);
      return;
    }
    this.consecutiveFailures += 1;
    this.attempt = Math.min(this.consecutiveFailures, MAX_RESTARTS);
    this.error = safeErrorMessage(error);
    if (this.consecutiveFailures > MAX_RESTARTS) {
      this.error = `Sidecar stopped after ${MAX_RESTARTS} restart attempts`;
      this.setPhase("error", this.error);
      return;
    }
    this.setPhase("recovering");
    const delayMs = RESTART_DELAYS_MS[
      Math.min(this.consecutiveFailures - 1, RESTART_DELAYS_MS.length - 1)
    ] ?? 2_000;
    const expectedGeneration = this.generation;
    let timerPromise: Promise<void>;
    timerPromise = new Promise<void>((resolvePromise) => {
      this.resolveRestartTimer = resolvePromise;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.resolveRestartTimer = undefined;
        resolvePromise();
      }, delayMs);
    }).then(async () => {
      if (
        this.stopping
        || this.workspace !== workspace
        || this.generation !== expectedGeneration
      ) return;
      try {
        await this.launch();
      } catch (launchError) {
        this.noteFailureAndSchedule(launchError, this.generation, workspace);
      }
    }).finally(() => {
      if (this.restartPromise === timerPromise) this.restartPromise = undefined;
    });
    this.restartPromise = timerPromise;
  }

  private async handleUnexpectedClose(
    generation: number,
    workspace: string,
    child: ChildProcessWithoutNullStreams,
    toolProcessGroups: Set<number>,
    disposeOutput: () => void,
    closed: Promise<ChildExitInfo>,
    info: ChildExitInfo,
  ): Promise<void> {
    if (generation !== this.generation || this.stopping || this.child !== child) return;
    this.options.onLog?.(
      "stderr",
      `sidecar exited unexpectedly code=${info.code ?? "null"} signal=${info.signal ?? "null"}`,
    );
    this.cancelStableHealthWindow();
    this.client = undefined;
    this.endpoint = undefined;
    this.token = undefined;
    this.sidecarPid = undefined;
    this.eventController?.abort();
    this.setPhase("recovering");

    try {
      await terminateManagedLaunch({
        child,
        toolProcessGroups,
        termination: { exit: Promise.resolve(info), closed },
        disposeOutput,
        mode: "exited",
        processGroups: this.options.processGroups ?? DEFAULT_PROCESS_GROUP_OPERATIONS,
      });
    } catch (cleanupError) {
      this.noteFailureAndSchedule(cleanupError, generation, workspace);
      return;
    }
    if (generation !== this.generation || this.stopping || this.child !== child) return;
    this.clearLaunch(child);
    this.noteFailureAndSchedule(
      info.error ?? new Error(`sidecar exited code=${info.code ?? "null"} signal=${info.signal ?? "null"}`),
      generation,
      workspace,
    );
  }

  private armStableHealthWindow(
    generation: number,
    workspace: string,
    child: ChildProcessWithoutNullStreams,
  ): void {
    this.cancelStableHealthWindow();
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = undefined;
      if (
        this.stopping
        || this.generation !== generation
        || this.workspace !== workspace
        || this.child !== child
        || this.phase !== "healthy"
      ) return;
      this.consecutiveFailures = 0;
      this.attempt = 0;
      this.emitState();
    }, STABLE_HEALTH_WINDOW_MS);
    this.stabilityTimer.unref?.();
  }

  private cancelStableHealthWindow(): void {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = undefined;
  }

  private cancelRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.resolveRestartTimer?.();
    this.resolveRestartTimer = undefined;
  }

  private clearLaunch(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.childExit = undefined;
    this.childClosed = undefined;
    this.disposeOutput = undefined;
    this.toolProcessGroups = new Set<number>();
    this.client = undefined;
    this.endpoint = undefined;
    this.token = undefined;
    this.sidecarPid = undefined;
  }

  private async consumeEvents(generation: number, client: RuntimeClient): Promise<void> {
    let afterEventId: string | undefined;
    let retry = 0;
    while (generation === this.generation && !this.stopping && this.client === client) {
      const controller = new AbortController();
      this.eventController = controller;
      try {
        for await (const event of client.streamEvents({
          ...(afterEventId ? { afterEventId } : {}),
          signal: controller.signal,
        })) {
          if (generation !== this.generation || this.stopping) return;
          if (!isTransientEvent(event)) afterEventId = event.id;
          retry = 0;
          this.options.onEvent?.(event, generation);
        }
        // The server deliberately rotates long-lived streams at a durable
        // cursor boundary. A clean EOF reconnects immediately with that cursor;
        // transport failures still enter the retry path below.
        if (!controller.signal.aborted) continue;
      } catch (error) {
        if (controller.signal.aborted || generation !== this.generation || this.stopping) return;
        if (error instanceof EventTransportResyncRequiredError) {
          afterEventId = error.resumeAfterEventId;
          this.options.onResync?.(error.message);
        } else if (error instanceof EventCursorResyncRequiredError) {
          afterEventId = undefined;
          this.options.onResync?.(error.message);
        } else {
          retry += 1;
          this.options.onLog?.("stderr", `runtime event stream reconnect ${retry}: ${safeErrorMessage(error)}`);
          await delay(Math.min(250 * 2 ** Math.min(retry, 4), 4_000), controller.signal);
        }
      }
    }
  }

  private async stopChild(): Promise<void> {
    this.stopping = true;
    ++this.generation;
    this.cancelStableHealthWindow();
    this.cancelRestartTimer();
    this.eventController?.abort();
    this.eventController = undefined;
    const child = this.child;
    const childExit = this.childExit;
    const childClosed = this.childClosed;
    const toolProcessGroups = this.toolProcessGroups;
    const disposeOutput = this.disposeOutput;
    this.client = undefined;
    this.endpoint = undefined;
    this.token = undefined;
    this.sidecarPid = undefined;
    if (child) {
      this.setPhase("stopping");
      requestGracefulSidecarShutdown(child);
      await terminateManagedLaunch({
        child,
        toolProcessGroups,
        termination: {
          exit: childExit ?? onceExit(child),
          closed: childClosed ?? onceClose(child),
        },
        disposeOutput: disposeOutput ?? (() => undefined),
        mode: "graceful",
        processGroups: this.options.processGroups ?? DEFAULT_PROCESS_GROUP_OPERATIONS,
      });
      this.clearLaunch(child);
    }
    await this.restartPromise?.catch(() => undefined);
  }

  private setPhase(phase: DesktopState["sidecar"]["phase"], error?: string): void {
    this.phase = phase;
    this.error = error;
    this.emitState();
  }

  private emitState(): void {
    this.options.onState?.(this.state(), this.generation);
  }
}

async function canonicalDirectory(input: string): Promise<string> {
  const path = await realpath(resolve(input));
  if (!(await stat(path)).isDirectory()) throw new Error(`Workspace is not a directory: ${path}`);
  return path;
}

function requireLoopbackEndpoint(input: string): URL {
  const url = new URL(input);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || !url.port || url.username || url.password) {
    throw new Error("Sidecar reported a non-loopback endpoint");
  }
  return url;
}

async function waitForHealth(endpoint: URL, token: string, exit: Promise<ChildExitInfo>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      fetch(new URL("health", endpoint), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_500),
      }).then(
        (response) => ({ type: "response" as const, response }),
        () => ({ type: "retry" as const }),
      ),
      exit.then((info) => ({ type: "exit" as const, info })),
    ]);
    if (outcome.type === "exit") {
      throw outcome.info.error ?? new Error("Sidecar exited during health check");
    }
    if (outcome.type === "response" && outcome.response.ok) return;
    const wait = await Promise.race([
      delay(100).then(() => false),
      exit.then(() => true),
    ]);
    if (wait) throw new Error("Sidecar exited during health check");
  }
  throw new Error("Sidecar health check timed out");
}

function authenticatedFetch(token: string): typeof fetch {
  return ((input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

function cleanChildEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.CHILI_DESKTOP_TOKEN;
  delete env.CHILI_DESKTOP_SMOKE_RENDERER_NEEDLES;
  delete env.CHILI_DESKTOP_SMOKE_SECRET_CANARY;
  delete env.CHILI_DESKTOP_SMOKE_PATH_CANARY;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  if (process.platform === "linux") delete env.LD_PRELOAD;
  return env;
}

function deliverSidecarCredential(
  child: ChildProcessWithoutNullStreams,
  token: string,
): Promise<void> {
  const credentialPipe = child.stdio[SIDECAR_CREDENTIAL_FD] as Writable | null | undefined;
  if (!credentialPipe || typeof credentialPipe.end !== "function") {
    return Promise.reject(new Error("Sidecar credential channel is unavailable"));
  }
  const frame = encodeSidecarCredentialFrame(token);
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    let writeStarted = false;
    let connectionPoll: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (connectionPoll) clearTimeout(connectionPoll);
      frame.fill(0);
      if (error) rejectPromise(new Error("Sidecar credential delivery failed"));
      else resolvePromise();
    };
    timeout = setTimeout(
      () => settle(new Error("Sidecar credential delivery timed out")),
      SIDECAR_CREDENTIAL_HANDSHAKE_TIMEOUT_MS,
    );
    const onError = (): void => settle(new Error("Sidecar credential delivery failed"));
    const onClose = (): void => {
      if (!settled) settle(new Error("Sidecar credential channel closed before delivery completed"));
    };
    credentialPipe.on("error", onError);
    credentialPipe.once("close", onClose);
    const writeFrame = (): void => {
      if (settled || writeStarted) return;
      writeStarted = true;
      try {
        credentialPipe.end(frame, settle);
      } catch {
        settle(new Error("Sidecar credential delivery failed"));
      }
    };
    const waitForConnection = (): void => {
      if (settled) return;
      // Bun exposes inherited pipes as asynchronously connecting sockets. Electron/Node
      // pipes are already connected, but writing a Bun pipe while `connecting` is true
      // can fail spuriously before the child has a chance to read fd 3.
      if ((credentialPipe as Writable & { connecting?: boolean }).connecting === true) {
        connectionPoll = setTimeout(waitForConnection, 1);
        return;
      }
      writeFrame();
    };
    waitForConnection();
  });
}

async function terminateManagedLaunch(input: {
  child: ChildProcessWithoutNullStreams;
  toolProcessGroups: Set<number>;
  termination: { exit: Promise<ChildExitInfo>; closed: Promise<ChildExitInfo> };
  disposeOutput(): void;
  mode: "graceful" | "force" | "exited";
  processGroups: SidecarProcessGroupOperations;
}): Promise<void> {
  try {
    await terminateManagedLaunchUnsafe(input);
  } catch (error) {
    throw new SidecarContainmentError(
      `Refusing to restart while sidecar process cleanup is incomplete: ${safeErrorMessage(error)}`,
      { cause: error },
    );
  }
}

async function terminateManagedLaunchUnsafe(input: {
  child: ChildProcessWithoutNullStreams;
  toolProcessGroups: Set<number>;
  termination: { exit: Promise<ChildExitInfo>; closed: Promise<ChildExitInfo> };
  disposeOutput(): void;
  mode: "graceful" | "force" | "exited";
  processGroups: SidecarProcessGroupOperations;
}): Promise<void> {
  const deadline = Date.now() + CONTAINMENT_DEADLINE_MS;
  const leaderPid = input.child.pid;
  const cleanupErrors: unknown[] = [];
  let exited = input.mode === "exited";
  if (input.mode === "graceful") {
    exited = await settlesWithin(
      input.termination.exit,
      remainingBudget(deadline, GRACEFUL_EXIT_TIMEOUT_MS),
    );
  }
  if (!exited && leaderPid) {
    try {
      const timeouts = processGroupTimeouts(
        deadline,
        input.mode === "force" ? 250 : 750,
        1_000,
      );
      await terminateConfirmedProcessGroup(leaderPid, timeouts, input.processGroups);
    } catch (error) {
      cleanupErrors.push(error);
    }
    exited = await settlesWithin(input.termination.exit, remainingBudget(deadline, 1_000));
  } else if (!exited && process.platform === "win32" && input.child.exitCode === null) {
    input.child.kill("SIGKILL");
    exited = await settlesWithin(input.termination.exit, remainingBudget(deadline, 1_000));
  }

  // Keep the parser attached for a bounded drain after leader exit. A detached
  // descendant can inherit stdout forever, so cleanup must never wait solely on
  // ChildProcess "close".
  if (exited) {
    await settlesWithin(
      input.termination.closed,
      remainingBudget(deadline, CONTROL_DRAIN_TIMEOUT_MS),
    );
  }
  try {
    input.disposeOutput();
  } catch (error) {
    cleanupErrors.push(error);
  }

  // The parser is now frozen and every synchronously written started frame that
  // reached the pipe is represented in this launch-local set.
  const toolResults = await Promise.allSettled([...input.toolProcessGroups].map(async (pid) => {
    const timeouts = processGroupTimeouts(deadline, 500, 1_000);
    await terminateConfirmedProcessGroup(pid, timeouts, input.processGroups);
    input.toolProcessGroups.delete(pid);
  }));
  for (const result of toolResults) {
    if (result.status === "rejected") cleanupErrors.push(result.reason);
  }

  // Always clean the old sidecar group even when its leader exited: MCP or an
  // inherited-stdio descendant can still be a member of that PGID.
  if (leaderPid) {
    try {
      const timeouts = processGroupTimeouts(deadline, 250, 1_000);
      await terminateConfirmedProcessGroup(leaderPid, timeouts, input.processGroups);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!exited) {
    await settlesWithin(input.termination.exit, remainingBudget(deadline, 750));
  }
  await settlesWithin(
    input.termination.closed,
    remainingBudget(deadline, CONTROL_DRAIN_TIMEOUT_MS),
  );
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Sidecar process cleanup failed");
}

async function terminateConfirmedProcessGroup(
  leaderPid: number,
  options: TerminateProcessGroupOptions,
  processGroups: SidecarProcessGroupOperations,
): Promise<void> {
  let terminationError: unknown;
  try {
    await processGroups.terminate(leaderPid, options);
  } catch (error) {
    terminationError = error;
  }
  let exists: boolean;
  try {
    exists = processGroups.exists(leaderPid);
  } catch (error) {
    throw terminationError
      ? new AggregateError([terminationError, error], `Could not verify process group ${leaderPid} cleanup`)
      : error;
  }
  if (!exists) return;
  if (terminationError) throw terminationError;
  throw new Error(`Process group ${leaderPid} still exists after cleanup`);
}

function onceExit(child: ChildProcessWithoutNullStreams): Promise<ChildExitInfo> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise) => {
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    child.once("error", (error) => resolvePromise({ code: null, signal: null, error }));
  });
}

function onceClose(child: ChildProcessWithoutNullStreams): Promise<ChildExitInfo> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise) => {
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
    child.once("error", (error) => resolvePromise({ code: null, signal: null, error }));
  });
}

const gracefulShutdownRequests = new WeakSet<ChildProcessWithoutNullStreams>();

function requestGracefulSidecarShutdown(child: ChildProcessWithoutNullStreams): void {
  if (gracefulShutdownRequests.has(child)) return;
  gracefulShutdownRequests.add(child);
  try {
    // Keep the ownership pipe open after the request. EOF remains an
    // unambiguous signal that Electron disappeared during graceful shutdown.
    child.stdin.write(SIDECAR_GRACEFUL_SHUTDOWN_FRAME);
  } catch {
    // The lifecycle actor will still enforce process-group cleanup.
  }
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

function remainingBudget(deadline: number, maximumMs: number): number {
  return Math.max(0, Math.min(maximumMs, deadline - Date.now()));
}

function processGroupTimeouts(
  deadline: number,
  preferredTermGraceMs: number,
  preferredKillGraceMs: number,
): { termGraceMs: number; killGraceMs: number } {
  const remaining = remainingBudget(deadline, preferredTermGraceMs + preferredKillGraceMs);
  const termGraceMs = Math.min(preferredTermGraceMs, Math.floor(remaining / 2));
  return {
    termGraceMs,
    killGraceMs: Math.min(preferredKillGraceMs, Math.max(0, remaining - termGraceMs)),
  };
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation aborted"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      rejectPromise(signal.reason ?? new Error("Operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      finish();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function safeErrorMessage(error: unknown): string {
  return safeDesktopErrorMessage(error);
}
