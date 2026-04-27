import { spawn } from "node:child_process";

export interface RunProcessOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
}

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
      collect(child.stdout, maxOutputBytes),
      collect(child.stderr, maxOutputBytes),
      waitForExit(child),
    ]);
    exited = true;

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

async function collect(stream: AsyncIterable<Buffer>, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let storedBytes = 0;
  let bytes = 0;
  let truncated = false;

  for await (const chunk of stream) {
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

  return {
    text: Buffer.concat(chunks).toString("utf8"),
    bytes,
    truncated,
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
