import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type RunProcessOutputStream = "stdout" | "stderr";

export interface RunProcessOutputChunk {
  stream: RunProcessOutputStream;
  delta: string;
  bytes?: number;
  truncated?: boolean;
}

export interface RunProcessOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  onOutput?: (chunk: RunProcessOutputChunk) => void | Promise<void>;
  outputFlushIntervalMs?: number;
  outputFlushBytes?: number;
  maxLiveOutputBytes?: number;
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

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  if (options.signal?.aborted) throw abortError("Process aborted");

  const started = Date.now();
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: normalizeEnv(options.env),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let timedOut = false;
  let aborted = false;
  let exited = false;
  let escalation: NodeJS.Timeout | undefined;
  const maxOutputBytes = options.maxOutputBytes ?? 256_000;
  const killGraceMs = options.killGraceMs ?? 1_000;
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
        terminateProcessGroup(child, "SIGTERM");
        escalation = setTimeout(() => {
          if (!exited) terminateProcessGroup(child, "SIGKILL");
        }, killGraceMs);
      }, options.timeoutMs)
    : undefined;

  const abort = () => {
    aborted = true;
    terminateProcessGroup(child, "SIGTERM");
    escalation = setTimeout(() => {
      if (!exited) terminateProcessGroup(child, "SIGKILL");
    }, killGraceMs);
  };

  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }

  try {
    const [stdout, stderr, status] = await Promise.all([
      collect(child.stdout, maxOutputBytes, "stdout", outputDispatcher),
      collect(child.stderr, maxOutputBytes, "stderr", outputDispatcher),
      waitForExit(child),
    ]);
    exited = true;
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
    await outputDispatcher?.flushAll();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (escalation) clearTimeout(escalation);
    options.signal?.removeEventListener("abort", abort);
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
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let storedBytes = 0;
  let bytes = 0;
  let truncated = false;

  for await (const chunk of stream) {
    outputDispatcher?.push(outputStream, chunk, false);
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
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
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

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
