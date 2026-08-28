import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import type { SessionId } from "@chili/protocol";
import { createRuntimeHttpHandler } from "@chili/server";
import { applyCliEnvironmentDefaults, cliEnvironmentDefaults } from "./environment-defaults.js";
import { createCliHarness, type CliHarness } from "./harness.js";
import {
  createCliShutdownLifecycle,
  waitForServeShutdown,
  type ServeShutdownSignal,
  type ServeShutdownSignalSource,
} from "./index.js";

test("CLI environment defaults configure Codex model, reasoning, and fast tier", () => {
  expect(cliEnvironmentDefaults({
    CHILI_PROVIDER: "openai-codex",
    CHILI_MODEL: "gpt-5.5",
    CHILI_REASONING_LEVEL: "xhigh",
    CHILI_SERVICE_TIER: "fast",
  })).toEqual({
    provider: "openai-codex",
    model: "gpt-5.5",
    reasoningLevel: "xhigh",
    serviceTier: "fast",
  });
});

test("CLI environment defaults accept OpenAI Codex aliases", () => {
  expect(cliEnvironmentDefaults({
    OPENAI_CODEX_REASONING_EFFORT: "high",
    OPENAI_CODEX_SERVICE_TIER: "standard",
  })).toEqual({
    reasoningLevel: "high",
    serviceTier: "standard",
  });
});

test("CLI environment defaults accept max and ultra reasoning", () => {
  expect(cliEnvironmentDefaults({ CHILI_REASONING_LEVEL: "max" })).toEqual({ reasoningLevel: "max" });
  expect(cliEnvironmentDefaults({ OPENAI_CODEX_REASONING_EFFORT: "ultra" })).toEqual({ reasoningLevel: "ultra" });
});

test("explicit CLI model ignores environment provider default", () => {
  expect(applyCliEnvironmentDefaults(
    { model: "fake" },
    { provider: "minimax", model: "MiniMax-M3", reasoningLevel: "high", serviceTier: "fast" },
  )).toEqual({
    model: "fake",
    reasoningLevel: "high",
    serviceTier: "fast",
  });
});

test("explicit CLI provider ignores an environment model from another provider", () => {
  expect(applyCliEnvironmentDefaults(
    { provider: "openai-codex" },
    { provider: "minimax", model: "MiniMax-M3", reasoningLevel: "high", serviceTier: "fast" },
  )).toEqual({
    provider: "openai-codex",
    reasoningLevel: "high",
    serviceTier: "fast",
  });
});

test("one-shot CLI SIGTERM aborts a real active prompt and closes the harness once", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-cli-one-shot-shutdown-"));
  const repo = join(root, "repo");
  const model = new AbortGateModel();
  const signals = new TestServeSignalSource();
  const sessionId = "session_cli_one_shot_shutdown" as SessionId;
  let harness: CliHarness | undefined;
  let harnessCloseCount = 0;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      chiliHome: join(root, "home"),
      quiet: true,
      yes: true,
      modelRouter: model,
      mcpConnectMode: "manual",
      staleTurnRecoveryIntervalMs: false,
    });
    const activeHarness = harness;
    const lifecycle = createCliShutdownLifecycle({
      signalSource: signals,
      forceExit: () => {
        throw new Error("graceful one-shot shutdown must not force exit");
      },
    });
    lifecycle.attachHarness({
      close() {
        harnessCloseCount += 1;
        return activeHarness.close();
      },
    });
    await activeHarness.service.createSession({ sessionId, cwd: repo });
    const prompt = activeHarness.service.submitPrompt({
      sessionId,
      text: "wait until one-shot shutdown",
      signal: lifecycle.signal,
    });
    await model.started.promise;

    signals.emit("SIGTERM");
    await model.abortObserved.promise;
    await withTimeout(lifecycle.close(), 1_000);
    const result = await prompt;

    expect(result.status).toBe("cancelled");
    expect(harnessCloseCount).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    lifecycle.dispose();
    harness = undefined;
  } finally {
    await harness?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 5_000);

test("one-shot CLI shutdown spans deferred harness initialization and publishes one close promise", async () => {
  const signals = new TestServeSignalSource();
  const harnessClose = deferred<void>();
  let closeCalls = 0;
  let deadlineCallback: (() => void) | undefined;
  let deadlineCancels = 0;
  const lifecycle = createCliShutdownLifecycle({
    signalSource: signals,
    armDeadline(callback) {
      deadlineCallback = callback;
      return {
        cancel() {
          deadlineCancels += 1;
        },
      };
    },
    forceExit: () => {
      throw new Error("deferred harness should close before its deadline");
    },
  });

  signals.emit("SIGINT");
  const first = lifecycle.close();
  const second = lifecycle.close();
  expect(second).toBe(first);
  expect(lifecycle.signal.aborted).toBe(true);
  expect(closeCalls).toBe(0);
  expect(deadlineCallback).toBeDefined();

  lifecycle.attachHarness({
    close() {
      closeCalls += 1;
      return harnessClose.promise;
    },
  });
  expect(closeCalls).toBe(1);
  harnessClose.resolve();
  await first;

  expect(closeCalls).toBe(1);
  expect(deadlineCancels).toBe(1);
  expect(signals.listenerCount("SIGINT")).toBe(0);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
  deadlineCallback?.();
});

test("one-shot CLI shutdown deadline forces a bounded exit and observes late cleanup", async () => {
  const signals = new TestServeSignalSource();
  const harnessClose = deferred<void>();
  const forced: Array<{ signal: ServeShutdownSignal; reason: string; exitCode: number }> = [];
  const unhandled: unknown[] = [];
  let deadlineCallback: (() => void) | undefined;
  const onUnhandled = (error: unknown): void => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const lifecycle = createCliShutdownLifecycle({
      signalSource: signals,
      shutdownDeadlineMs: 25,
      armDeadline(callback, delayMs) {
        expect(delayMs).toBe(25);
        deadlineCallback = callback;
        return { cancel() {} };
      },
      forceExit: (input) => {
        forced.push(input);
      },
    });
    lifecycle.attachHarness({ close: () => harnessClose.promise });
    signals.emit("SIGTERM");
    const outcome = lifecycle.close().then(
      () => undefined,
      (error: unknown) => error,
    );
    deadlineCallback?.();

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("CLI shutdown exceeded 25ms");
    expect(forced).toEqual([{ signal: "SIGTERM", reason: "deadline", exitCode: 143 }]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);

    harnessClose.reject(new Error("late one-shot cleanup rejection"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("one-shot CLI repeated signal forces once and observes a late harness rejection", async () => {
  const signals = new TestServeSignalSource();
  const harnessClose = deferred<void>();
  const forced: Array<{ signal: ServeShutdownSignal; reason: string; exitCode: number }> = [];
  const unhandled: unknown[] = [];
  let closeCalls = 0;
  const onUnhandled = (error: unknown): void => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const lifecycle = createCliShutdownLifecycle({
      signalSource: signals,
      armDeadline: () => ({ cancel() {} }),
      forceExit: (input) => {
        forced.push(input);
      },
    });
    lifecycle.attachHarness({
      close() {
        closeCalls += 1;
        return harnessClose.promise;
      },
    });

    signals.emit("SIGINT");
    const closing = lifecycle.close();
    const outcome = closing.then(
      () => undefined,
      (error: unknown) => error,
    );
    signals.emit("SIGTERM");
    signals.emit("SIGINT");

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("CLI shutdown was forced by repeated SIGTERM");
    expect(forced).toEqual([{ signal: "SIGTERM", reason: "repeated_signal", exitCode: 143 }]);
    expect(closeCalls).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);

    harnessClose.reject(new Error("late one-shot harness close failure"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("one-shot CLI normal completion closes once and disposes both signal listeners", async () => {
  const signals = new TestServeSignalSource();
  const forced: unknown[] = [];
  let closeCalls = 0;
  const lifecycle = createCliShutdownLifecycle({
    signalSource: signals,
    forceExit: (input) => {
      forced.push(input);
    },
  });
  lifecycle.attachHarness({
    async close() {
      closeCalls += 1;
    },
  });

  const first = lifecycle.close();
  const second = lifecycle.close();
  expect(second).toBe(first);
  await first;
  lifecycle.dispose();
  signals.emit("SIGINT");
  signals.emit("SIGTERM");

  expect(closeCalls).toBe(1);
  expect(forced).toEqual([]);
  expect(signals.listenerCount("SIGINT")).toBe(0);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
});

test("REPL handoff releases healthy SIGINT but restores it as a forced shutdown escape", async () => {
  const signals = new TestServeSignalSource();
  const harnessClose = deferred<void>();
  const forced: Array<{ signal: ServeShutdownSignal; reason: string; exitCode: number }> = [];
  let closeCalls = 0;
  const lifecycle = createCliShutdownLifecycle({
    signalSource: signals,
    armDeadline: () => ({ cancel() {} }),
    forceExit: (input) => {
      forced.push(input);
    },
  });
  lifecycle.attachHarness({
    close() {
      closeCalls += 1;
      return harnessClose.promise;
    },
  });

  lifecycle.releaseSigint();
  expect(signals.listenerCount("SIGINT")).toBe(0);
  expect(signals.listenerCount("SIGTERM")).toBe(1);
  signals.emit("SIGINT");
  expect(lifecycle.signal.aborted).toBe(false);
  expect(closeCalls).toBe(0);

  signals.emit("SIGTERM");
  const outcome = lifecycle.close().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(lifecycle.signal.aborted).toBe(true);
  expect(closeCalls).toBe(1);
  expect(signals.listenerCount("SIGINT")).toBe(1);

  signals.emit("SIGINT");
  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("CLI shutdown was forced by repeated SIGINT");
  expect(forced).toEqual([{ signal: "SIGINT", reason: "repeated_signal", exitCode: 130 }]);
  expect(signals.listenerCount("SIGINT")).toBe(0);
  expect(signals.listenerCount("SIGTERM")).toBe(0);

  harnessClose.resolve();
  await Promise.resolve();
});

test("real idle REPL exits after one SIGTERM and preserves the signal exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-cli-repl-sigterm-"));
  const repo = join(root, "repo");
  const chiliHome = join(root, "home");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await mkdir(repo, { recursive: true });
    const spawned = Bun.spawn({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./index.ts", import.meta.url)),
        "--model",
        "fake",
        "--yes",
        "--no-mcp",
        "--cwd",
        repo,
      ],
      cwd: repo,
      env: { ...process.env, CHILI_HOME: chiliHome },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child = spawned;
    const stdout = observeTextStream(spawned.stdout, "chili> ");
    const stderr = new Response(spawned.stderr).text();

    await withTimeout(stdout.markerSeen, 5_000);
    spawned.kill("SIGTERM");
    const exitCode = await withTimeout(spawned.exited, 5_000);
    const output = await stdout.done;
    const errorOutput = await stderr;

    expect(exitCode).toBe(143);
    expect(output).toContain("[interrupt] SIGTERM received; shutting down...");
    expect(errorOutput).toBe("");
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("one serve shutdown signal aborts an in-flight synchronous prompt and drains exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-cli-serve-shutdown-"));
  const repo = join(root, "repo");
  const model = new AbortGateModel();
  const signals = new TestServeSignalSource();
  const sessionId = "session_cli_serve_shutdown" as SessionId;
  let harness: CliHarness | undefined;
  let serverCloseCount = 0;
  let harnessCloseCount = 0;
  let denyPendingCount = 0;
  try {
    await mkdir(repo, { recursive: true });
    harness = await createCliHarness({
      cwd: repo,
      chiliHome: join(root, "home"),
      quiet: true,
      yes: true,
      modelRouter: model,
      mcpConnectMode: "manual",
      staleTurnRecoveryIntervalMs: false,
    });
    await harness.service.createSession({ sessionId, cwd: repo });
    const handler = createRuntimeHttpHandler({
      service: harness.service,
      store: harness.events,
    });
    const response = handler(new Request(`http://chili.test/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "wait until serve shutdown" }),
    }));
    await model.started.promise;

    const closingHarness = harness;
    const shutdown = waitForServeShutdown({
      signalSource: signals,
      denyPending: () => {
        denyPendingCount += 1;
      },
      closeServer: () => {
        serverCloseCount += 1;
        // Bun's server.stop(true) waits for this in-flight handler. Model that
        // dependency without opening a real port so the regression is stable.
        return response.then(() => undefined);
      },
      closeHarness: () => {
        harnessCloseCount += 1;
        return closingHarness.close();
      },
      forceExit: () => {
        throw new Error("graceful serve shutdown must not force exit");
      },
    });

    signals.emit("SIGINT");
    await model.abortObserved.promise;
    await withTimeout(shutdown, 1_000);

    const promptResponse = await response;
    expect(promptResponse.status).toBe(200);
    expect(await promptResponse.json()).toMatchObject({ status: "cancelled" });
    expect(serverCloseCount).toBe(1);
    expect(harnessCloseCount).toBe(1);
    expect(denyPendingCount).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    harness = undefined;
  } finally {
    await harness?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 5_000);

test("serve shutdown observes both close failures without repeating cleanup", async () => {
  const signals = new TestServeSignalSource();
  let serverCloseCount = 0;
  let harnessCloseCount = 0;
  const shutdown = waitForServeShutdown({
    signalSource: signals,
    denyPending: () => undefined,
    closeServer: async () => {
      serverCloseCount += 1;
      throw new Error("server close failed");
    },
    closeHarness: async () => {
      harnessCloseCount += 1;
      throw new Error("harness close failed");
    },
    forceExit: () => {
      throw new Error("settled serve shutdown failures must not force exit");
    },
  });
  const outcome = shutdown.then(
    () => undefined,
    (error: unknown) => error,
  );

  signals.emit("SIGINT");

  const error = await outcome;
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors.map(String)).toEqual([
    "Error: server close failed",
    "Error: harness close failed",
  ]);
  expect(serverCloseCount).toBe(1);
  expect(harnessCloseCount).toBe(1);
  expect(signals.listenerCount("SIGINT")).toBe(0);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
});

test("serve shutdown deadline forces a bounded exit and observes late close rejections", async () => {
  const signals = new TestServeSignalSource();
  const serverClose = deferred<void>();
  const harnessClose = deferred<void>();
  const forced: Array<{ signal: ServeShutdownSignal; reason: string; exitCode: number }> = [];
  const unhandled: unknown[] = [];
  let deadlineCallback: (() => void) | undefined;
  let deadlineCancels = 0;
  const onUnhandled = (error: unknown): void => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const shutdown = waitForServeShutdown({
      signalSource: signals,
      denyPending: () => undefined,
      closeServer: () => serverClose.promise,
      closeHarness: () => harnessClose.promise,
      shutdownDeadlineMs: 25,
      armDeadline: (callback, delayMs) => {
        expect(delayMs).toBe(25);
        deadlineCallback = callback;
        return {
          cancel() {
            deadlineCancels += 1;
          },
        };
      },
      forceExit: (input) => {
        forced.push(input);
      },
    });
    const outcome = shutdown.then(
      () => undefined,
      (error: unknown) => error,
    );

    signals.emit("SIGTERM");
    expect(deadlineCallback).toBeDefined();
    deadlineCallback?.();

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Runtime server shutdown exceeded 25ms");
    expect(forced).toEqual([{ signal: "SIGTERM", reason: "deadline", exitCode: 143 }]);
    expect(deadlineCancels).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);

    serverClose.reject(new Error("late server close failure"));
    harnessClose.reject(new Error("late harness close failure"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("a repeated serve shutdown signal provides one immediate forced escape", async () => {
  const signals = new TestServeSignalSource();
  const serverClose = deferred<void>();
  const harnessClose = deferred<void>();
  const forced: Array<{ signal: ServeShutdownSignal; reason: string; exitCode: number }> = [];
  let serverCloseCount = 0;
  let harnessCloseCount = 0;
  let deadlineCallback: (() => void) | undefined;
  let deadlineCancels = 0;
  const shutdown = waitForServeShutdown({
    signalSource: signals,
    denyPending: () => undefined,
    closeServer: () => {
      serverCloseCount += 1;
      return serverClose.promise;
    },
    closeHarness: () => {
      harnessCloseCount += 1;
      return harnessClose.promise;
    },
    armDeadline: (callback) => {
      deadlineCallback = callback;
      return {
        cancel() {
          deadlineCancels += 1;
        },
      };
    },
    forceExit: (input) => {
      forced.push(input);
    },
  });
  const outcome = shutdown.then(
    () => undefined,
    (error: unknown) => error,
  );

  signals.emit("SIGTERM");
  signals.emit("SIGINT");
  signals.emit("SIGTERM");

  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("Runtime server shutdown was forced by repeated SIGINT");
  expect(forced).toEqual([{ signal: "SIGINT", reason: "repeated_signal", exitCode: 130 }]);
  expect(serverCloseCount).toBe(1);
  expect(harnessCloseCount).toBe(1);
  expect(deadlineCancels).toBe(1);
  expect(signals.listenerCount("SIGINT")).toBe(0);
  expect(signals.listenerCount("SIGTERM")).toBe(0);

  deadlineCallback?.();
  serverClose.resolve();
  harnessClose.resolve();
  await Promise.resolve();
  expect(forced).toHaveLength(1);
});

class AbortGateModel implements ModelRouter {
  readonly started = deferred<void>();
  readonly abortObserved = deferred<void>();

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    this.started.resolve();
    await new Promise<void>((resolvePromise) => {
      const onAbort = (): void => {
        this.abortObserved.resolve();
        resolvePromise();
      };
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const error = new Error("model aborted during serve shutdown");
    error.name = "AbortError";
    throw error;
  }
}

class TestServeSignalSource implements ServeShutdownSignalSource {
  private readonly listeners = new Map<ServeShutdownSignal, Set<() => void>>();

  on(signal: ServeShutdownSignal, listener: () => void): this {
    let listeners = this.listeners.get(signal);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(signal, listeners);
    }
    listeners.add(listener);
    return this;
  }

  removeListener(signal: ServeShutdownSignal, listener: () => void): this {
    this.listeners.get(signal)?.delete(listener);
    return this;
  }

  emit(signal: ServeShutdownSignal): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener();
  }

  listenerCount(signal: ServeShutdownSignal): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(error) {
      rejectPromise?.(error);
    },
  };
}

function observeTextStream(
  stream: ReadableStream<Uint8Array>,
  marker: string,
): { markerSeen: Promise<void>; done: Promise<string> } {
  const markerSeen = deferred<void>();
  const done = (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        output += decoder.decode(next.value, { stream: true });
        if (output.includes(marker)) markerSeen.resolve();
      }
      output += decoder.decode();
      if (output.includes(marker)) markerSeen.resolve();
      return output;
    } catch (error) {
      markerSeen.reject(error);
      throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  return { markerSeen: markerSeen.promise, done };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation did not settle within ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
