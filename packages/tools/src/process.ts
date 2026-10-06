import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import type { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { spawnGuardedProcess } from "./process-guardian.js";
export { PROCESS_GUARDIAN_MODE, runProcessGuardianEntrypoint } from "./process-guardian.js";

export type RunProcessOutputStream = "stdout" | "stderr";

export interface RunProcessOutputChunk {
  stream: RunProcessOutputStream;
  delta: string;
  bytes?: number;
  truncated?: boolean;
}

export interface RunProcessRawOutputChunk {
  stream: RunProcessOutputStream;
  chunk: Buffer;
}

export interface RunProcessOptions {
  /** Last authority check before the guardian receives permission to execute. */
  beforeSpawn?: () => Promise<void>;
  cwd: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  onOutput?: (chunk: RunProcessOutputChunk) => void | Promise<void>;
  onRawOutput?: (chunk: RunProcessRawOutputChunk) => void | Promise<void>;
  outputFlushIntervalMs?: number;
  outputFlushBytes?: number;
  maxLiveOutputBytes?: number;
}

export interface RunProcessLifecycleEvent {
  type: "started" | "finished";
  pid: number;
}

export type RunProcessLifecycleObserver = (event: RunProcessLifecycleEvent) => void;

export interface ProcessGuardianLifecycleEvent {
  type: "started" | "finished";
  pid: number;
  cwd: string;
  ownerId?: string;
}

const processOwner = new AsyncLocalStorage<string>();

export function withProcessOwner<T>(ownerId: string, operation: () => T): T {
  return processOwner.run(ownerId, operation);
}

const guardianLifecycleObservers = new Set<(event: ProcessGuardianLifecycleEvent) => void>();

/** Started is a required durable registration barrier, before any tool can run. */
export function observeProcessGuardianLifecycle(observer: (event: ProcessGuardianLifecycleEvent) => void): () => void {
  guardianLifecycleObservers.add(observer);
  return () => guardianLifecycleObservers.delete(observer);
}

/** Register before the helper receives permission to start; release only after its OS exit. */
export function registerProcessGuardian(input: { pid: number; cwd: string }): () => void {
  const ownerId = processOwner.getStore();
  const event = { ...input, type: "started" as const, ...(ownerId ? { ownerId } : {}) };
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    for (const observer of guardianLifecycleObservers) {
      try { observer({ ...event, type: "finished" }); } catch { /* A stale registration fails closed on recovery. */ }
    }
  };
  try { for (const observer of guardianLifecycleObservers) observer(event); }
  catch (error) { release(); throw error; }
  return release;
}

const processLifecycleObservers = new Set<RunProcessLifecycleObserver>();

export function observeRunProcessLifecycle(observer: RunProcessLifecycleObserver): () => void {
  processLifecycleObservers.add(observer);
  return () => processLifecycleObservers.delete(observer);
}

const DEFAULT_OUTPUT_FLUSH_INTERVAL_MS = 75;
const DEFAULT_LIVE_OUTPUT_PENDING_BYTES = 64 * 1024;
const DEFAULT_LIVE_OUTPUT_DELTA_BYTES = 8 * 1024;
const DEFAULT_LIVE_OUTPUT_TOTAL_BYTES = 64 * 1024;

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  outputLimitBytes: number;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

type ChildProcessExitEvents = Pick<EventEmitter<{
  error: [error: Error];
  exit: [exitCode: number | null, signal: NodeJS.Signals | null];
  close: [exitCode: number | null, signal: NodeJS.Signals | null];
}>, "once">;

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  if (options.signal?.aborted) throw abortError("Process aborted");
  if (process.platform === "win32") {
    await awaitProcessAuthorization(options);
    if (options.signal?.aborted) throw abortError("Process aborted");
  }

  const started = Date.now();
  const killGraceMs = options.killGraceMs ?? 1_000;
  const guarded = process.platform !== "win32" ? spawnGuardedProcess(command, args, {
    cwd: options.cwd,
    env: normalizeEnv(options.env),
    killGraceMs,
  }) : undefined;
  const child = guarded?.child ?? spawn(command, [...args], {
    cwd: options.cwd,
    env: normalizeEnv(options.env),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let releaseGuardian: (() => void) | undefined;
  const finishGuardian = async (): Promise<void> => {
    if (!guarded) return;
    guarded.stop();
    await guarded.closed;
    if (child.pid && !await waitForProcessGroupExit(child.pid, Math.max(250, killGraceMs))) {
      throw new Error(`Process group ${child.pid} remained alive after guardian cleanup`);
    }
    releaseGuardian?.();
  };
  if (guarded && child.pid) {
    try {
      releaseGuardian = registerProcessGuardian({ pid: child.pid, cwd: options.cwd });
      await awaitProcessAuthorization(options);
      if (options.signal?.aborted) throw abortError("Process aborted");
      guarded.start();
    } catch (error) {
      guarded.stop();
      await finishGuardian();
      throw error;
    }
  }
  let childPid: number | undefined;
  const abortStartup = (): void => { if (guarded) terminateProcessGroup(child, "SIGKILL"); };
  let startupTimedOut = false;
  const startupTimer = guarded ? setTimeout(() => {
    startupTimedOut = true;
    abortStartup();
  }, Math.min(options.timeoutMs || 10_000, 10_000)) : undefined;
  options.signal?.addEventListener("abort", abortStartup, { once: true });
  try { childPid = guarded ? await guarded.started : child.pid; }
  catch (error) {
    await finishGuardian();
    if (options.signal?.aborted) throw abortError("Process aborted");
    if (startupTimedOut) throw new Error("Process guardian startup timed out before command readiness");
    throw error;
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
    options.signal?.removeEventListener("abort", abortStartup);
  }
  if (childPid) publishProcessLifecycle({ type: "started", pid: childPid });

  let timedOut = false;
  let aborted = false;
  let exited = false;
  let escalation: NodeJS.Timeout | undefined;
  const maxOutputBytes = options.maxOutputBytes ?? 256_000;
  const outputDispatcher = options.onOutput
    ? new OutputDeltaDispatcher(options.onOutput, {
        flushIntervalMs: options.outputFlushIntervalMs ?? DEFAULT_OUTPUT_FLUSH_INTERVAL_MS,
        maxPendingBytes: DEFAULT_LIVE_OUTPUT_PENDING_BYTES,
        maxDeltaBytes: Math.max(1024, options.outputFlushBytes ?? DEFAULT_LIVE_OUTPUT_DELTA_BYTES),
        maxTotalBytes: Math.max(0, options.maxLiveOutputBytes ?? DEFAULT_LIVE_OUTPUT_TOTAL_BYTES),
      })
    : undefined;

  const timeout = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        if (guarded) guarded.stop();
        else {
          terminateProcessGroup(child, "SIGTERM");
          escalation = setTimeout(() => {
            if (!exited) terminateProcessGroup(child, "SIGKILL");
          }, killGraceMs);
        }
      }, Math.max(1, options.timeoutMs - (Date.now() - started)))
    : undefined;

  const abort = () => {
    aborted = true;
    if (guarded) guarded.stop();
    else {
      terminateProcessGroup(child, "SIGTERM");
      escalation = setTimeout(() => {
        if (!exited) terminateProcessGroup(child, "SIGKILL");
      }, killGraceMs);
    }
  };

  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }

  try {
    const statusPromise = (guarded?.status ?? waitForExit(child)).then(async (status) => {
      exited = true;
      if (!guarded && childPid) await terminateResidualProcessGroup(childPid, killGraceMs);
      return status;
    });
    const [stdout, stderr, status] = await Promise.all([
      collect(guarded?.stdout ?? child.stdout, maxOutputBytes, "stdout", outputDispatcher, options.onRawOutput),
      collect(guarded?.stderr ?? child.stderr, maxOutputBytes, "stderr", outputDispatcher, options.onRawOutput),
      statusPromise,
    ]);
    await outputDispatcher?.flushAll();

    if (aborted) {
      throw abortError("Process aborted");
    }

    return {
      exitCode: status.exitCode,
      signal: status.signal,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      outputLimitBytes: maxOutputBytes,
      durationMs: Date.now() - started,
      timedOut,
      aborted,
    };
  } catch (error) {
    if (guarded && childPid) await terminateResidualProcessGroup(childPid, killGraceMs);
    await outputDispatcher?.flushAll();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (escalation) clearTimeout(escalation);
    options.signal?.removeEventListener("abort", abort);
    if (guarded) {
      await finishGuardian();
    }
    else if (childPid) await terminateResidualProcessGroup(childPid, killGraceMs);
    if (childPid && !processGroupStillExists(childPid)) {
      publishProcessLifecycle({ type: "finished", pid: childPid });
    }
  }
}

function publishProcessLifecycle(event: RunProcessLifecycleEvent): void {
  for (const observer of processLifecycleObservers) {
    try {
      observer(event);
    } catch {
      // Lifecycle reporting must never change tool process behavior.
    }
  }
}

function processGroupStillExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function normalizeEnv(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    GIT_TERMINAL_PROMPT: "0",
  };

  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) base[key] = value;
  }

  return base;
}

async function collect(
  stream: AsyncIterable<Buffer>,
  maxBytes: number,
  outputStream: RunProcessOutputStream,
  outputDispatcher: OutputDeltaDispatcher | undefined,
  onRawOutput: RunProcessOptions["onRawOutput"],
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let storedBytes = 0;
  let bytes = 0;
  let truncated = false;

  for await (const chunk of stream) {
    outputDispatcher?.push(outputStream, chunk, false);
    await onRawOutput?.({ stream: outputStream, chunk });
    bytes += chunk.byteLength;
    if (storedBytes >= maxBytes) {
      truncated = true;
      continue;
    }

    const remaining = maxBytes - storedBytes;
    const next = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    chunks.push(next);
    storedBytes += next.byteLength;
    if (chunk.byteLength > remaining) truncated = true;
  }
  outputDispatcher?.finish(outputStream);

  return {
    text: Buffer.concat(chunks).toString("utf8"),
    bytes,
    truncated,
  };
}

class OutputDeltaDispatcher {
  private readonly stdout = createOutputState();
  private readonly stderr = createOutputState();
  private publishQueue: Promise<void> = Promise.resolve();
  private publishError: unknown;

  constructor(
    private readonly onOutput: (chunk: RunProcessOutputChunk) => void | Promise<void>,
    private readonly options: { flushIntervalMs: number; maxPendingBytes: number; maxDeltaBytes: number; maxTotalBytes: number },
  ) {}

  push(stream: RunProcessOutputStream, chunk: Buffer, truncated: boolean): void {
    const state = this.state(stream);
    if (state.liveLimitReached) {
      state.decoder.write(chunk);
      return;
    }

    const delta = state.decoder.write(chunk);
    state.pending += delta;
    state.truncated = state.truncated || truncated;
    this.trimPending(state);
    if (state.pending.length === 0) return;
    this.schedule(stream);
  }

  finish(stream: RunProcessOutputStream): void {
    const state = this.state(stream);
    state.pending += state.decoder.end();
    this.trimPending(state);
    this.flush(stream);
  }

  async flushAll(): Promise<void> {
    this.finish("stdout");
    this.finish("stderr");
    await this.publishQueue;
    if (this.publishError) throw this.publishError;
  }

  private schedule(stream: RunProcessOutputStream): void {
    const state = this.state(stream);
    if (state.timer || state.pending.length === 0) return;
    state.timer = setTimeout(() => this.flush(stream), Math.max(0, this.options.flushIntervalMs));
  }

  private flush(stream: RunProcessOutputStream): void {
    const state = this.state(stream);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.pending.length === 0) {
      return;
    }
    if (state.publishedBytes >= this.options.maxTotalBytes) {
      state.pending = "";
      state.truncated = true;
      state.liveLimitReached = true;
      return;
    }

    const delta = utf8Tail(state.pending, this.options.maxDeltaBytes);
    const remainingBytes = this.options.maxTotalBytes - state.publishedBytes;
    const bounded = utf8Head(delta.text, remainingBytes);
    const deltaBytes = Buffer.byteLength(bounded.text, "utf8");
    const update: RunProcessOutputChunk = {
      stream,
      delta: bounded.text,
      bytes: deltaBytes,
      ...(state.truncated || delta.truncated || bounded.truncated ? { truncated: true } : {}),
    };
    state.pending = "";
    state.truncated = false;
    state.publishedBytes += deltaBytes;
    if (bounded.truncated || state.publishedBytes >= this.options.maxTotalBytes) {
      state.liveLimitReached = true;
    }
    if (update.delta.length === 0) return;

    this.publishQueue = this.publishQueue.then(async () => {
      if (this.publishError) return;
      try {
        await this.onOutput(update);
      } catch (error) {
        this.publishError = error;
      }
    });
  }

  private state(stream: RunProcessOutputStream): OutputState {
    return stream === "stdout" ? this.stdout : this.stderr;
  }

  private trimPending(state: OutputState): void {
    const trimmed = utf8Tail(state.pending, this.options.maxPendingBytes);
    if (!trimmed.truncated) return;
    state.pending = trimmed.text;
    state.truncated = true;
  }
}

interface OutputState {
  decoder: StringDecoder;
  pending: string;
  truncated: boolean;
  timer: NodeJS.Timeout | undefined;
  publishedBytes: number;
  liveLimitReached: boolean;
}

function createOutputState(): OutputState {
  return {
    decoder: new StringDecoder("utf8"),
    pending: "",
    truncated: false,
    timer: undefined,
    publishedBytes: 0,
    liveLimitReached: false,
  };
}

function utf8Head(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  if (maxBytes <= 0) return { text: "", truncated: true };
  let end = Math.min(maxBytes, bytes.byteLength);
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return {
    text: bytes.subarray(0, end).toString("utf8"),
    truncated: true,
  };
}

function utf8Tail(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  let start = Math.max(0, bytes.byteLength - maxBytes);
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return {
    text: bytes.subarray(start).toString("utf8"),
    truncated: true,
  };
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const events = child as typeof child & ChildProcessExitEvents;
    events.once("error", reject);
    events.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    events.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

async function awaitProcessAuthorization(options: RunProcessOptions): Promise<void> {
  if (!options.beforeSpawn) return;
  if (options.signal?.aborted) throw abortError("Process aborted");
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => finish(abortError("Process aborted"));
    const timer = setTimeout(() => finish(new Error("Process authorization deadline exceeded before command startup")), options.timeoutMs || 10_000);
    const finish = (error?: unknown): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => options.beforeSpawn!()).then(() => finish(), finish);
  });
}

function terminateProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (!isNoSuchProcess(error)) {
        // Fall through to killing the direct child; this can happen when the OS
        // refuses process-group signaling for a process that is already exiting.
      }
    }
  }

  child.kill(signal);
}

async function terminateResidualProcessGroup(pid: number, graceMs: number): Promise<void> {
  if (process.platform === "win32" || !processGroupStillExists(pid)) return;
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid, graceMs)) return;
  signalProcessGroup(pid, "SIGKILL");
  await waitForProcessGroupExit(pid, Math.max(250, Math.min(graceMs, 1_000)));
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) {
      // A lifecycle observer keeps the group registered if signaling fails.
    }
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processGroupStillExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
