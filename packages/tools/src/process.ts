import { spawn } from "node:child_process";

export interface RunProcessOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  const started = Date.now();
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: normalizeEnv(options.env),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let timedOut = false;
  let aborted = false;
  const maxOutputBytes = options.maxOutputBytes ?? 256_000;

  const timeout = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs)
    : undefined;

  const abort = () => {
    aborted = true;
    child.kill("SIGTERM");
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

    if (timedOut) {
      throw abortError(`Process timed out after ${options.timeoutMs}ms`);
    }
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
      durationMs: Date.now() - started,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
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

async function collect(stream: AsyncIterable<Buffer>, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  for await (const chunk of stream) {
    if (bytes >= maxBytes) {
      truncated = true;
      continue;
    }

    const remaining = maxBytes - bytes;
    const next = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    chunks.push(next);
    bytes += next.byteLength;
    if (chunk.byteLength > remaining) truncated = true;
  }

  return {
    text: Buffer.concat(chunks).toString("utf8"),
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
