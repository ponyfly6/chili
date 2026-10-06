import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";

export const PROCESS_GUARDIAN_MODE = "--chili-process-guardian";

/** Entry for compiled application executables, which cannot interpret `-e`. */
export function runProcessGuardianEntrypoint(): void {
  new Function("require", GUARDIAN_SOURCE)(createRequire(import.meta.url));
}

export interface GuardedProcess {
  child: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
  stderr: PassThrough;
  started: Promise<number>;
  status: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  closed: Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * The guardian launches the command, rather than registering an already-running
 * PID. Only the owner holds its control pipe; EOF therefore also handles SIGKILL.
 * Tool children never inherit that pipe. No persisted PID is used for signaling.
 */
export function spawnGuardedProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; killGraceMs: number },
): GuardedProcess {
  const compiled = typeof Bun !== "undefined" && Bun.main.startsWith("/$bunfs/");
  const child = spawn(process.execPath, compiled ? [PROCESS_GUARDIAN_MODE] : ["-e", GUARDIAN_SOURCE], {
    // Never evaluate the helper in a project directory or inherit a tool's
    // NODE_OPTIONS/BUN_OPTIONS/preload environment before sandbox activation.
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", HOME: "/", TMPDIR: process.env.TMPDIR },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveStarted!: (pid: number) => void;
  let rejectStarted!: (error: Error) => void;
  let resolveStatus!: (status: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  let rejectStatus!: (error: Error) => void;
  const started = new Promise<number>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  const status = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    resolveStatus = resolve;
    rejectStatus = reject;
  });
  // Both promises are observed even when launch fails before the caller awaits status.
  void started.catch(() => undefined);
  void status.catch(() => undefined);
  let reported = false;
  let pending = "";
  const fail = (error: Error): void => { rejectStarted(error); rejectStatus(error); };
  const events = child.stdout;
  events.setEncoding("utf8");
  events.on("data", (chunk: string) => {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const event = JSON.parse(line) as {
          type: string; pid?: number; exitCode?: number | null; signal?: NodeJS.Signals | null; message?: string;
          stream?: "stdout" | "stderr"; data?: string;
        };
        if (event.type === "output" && event.data) {
          const output = event.stream === "stderr" ? stderr : stdout;
          if (!output.write(Buffer.from(event.data, "base64"))) {
            events.pause();
            output.once("drain", () => events.resume());
          }
        }
        if (event.type === "started" && event.pid) resolveStarted(event.pid);
        if (event.type === "error") fail(new Error(event.message ?? "Process launch failed"));
        if (event.type === "finished") {
          reported = true;
          // Let the helper retain group ownership until this terminal frame
          // has actually reached its owner, then allow its final group kill.
          child.stdin.write("finish\n");
          stdout.end();
          stderr.end();
          resolveStatus({ exitCode: event.exitCode ?? null, signal: event.signal ?? null });
        }
      } catch (error) {
        fail(new Error(`Invalid process guardian response: ${String(error)}`));
      }
    }
  });
  const childEvents = child as typeof child & Pick<EventEmitter<{
    error: [error: Error]; close: [code: number | null, signal: NodeJS.Signals | null];
  }>, "once">;
  childEvents.once("error", fail);
  const closed = new Promise<void>((resolve) => childEvents.once("close", () => resolve()));
  childEvents.once("close", () => {
    stdout.end();
    stderr.end();
    if (!reported) fail(new Error("Process guardian exited before confirming process cleanup"));
  });
  events.once("error", fail);
  events.once("end", () => {
    if (!reported) fail(new Error("Process guardian exited before confirming process cleanup"));
  });
  child.stdin.on("error", () => undefined);
  let launched = false;
  return {
    child,
    stdout,
    stderr,
    started,
    status,
    closed,
    start: () => { launched = true; child.stdin.write(`${JSON.stringify({ command, args, ...options })}\n`); },
    stop: () => { if (launched) child.stdin.write("stop\n"); else child.stdin.end(); },
  };
}

// Deliberately plain JavaScript: the same bundled source runs under Node and Bun.
// The guardian remains the group leader until its final group-wide kill, so
// the group identity cannot be recycled while cleanup is pending.
const GUARDIAN_SOURCE = String.raw`
const { spawn } = require("node:child_process");
let input;
let child;
let stopping = false;
let finished = false;
let exitCode = null;
let exitSignal = null;
let timer;
let frame = "";
function report(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}
function signal(value) {
  try { process.kill(-process.pid, value); } catch { process.exit(1); }
}
function complete() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  report({ type: "finished", exitCode, signal: exitSignal });
  timer = setTimeout(() => signal("SIGKILL"), 250);
}
function stop() {
  if (finished) { signal("SIGKILL"); return; }
  if (stopping) return;
  stopping = true;
  if (!child) { process.exit(0); return; }
  signal("SIGTERM");
  timer = setTimeout(() => { exitSignal = "SIGKILL"; complete(); }, Math.max(0, input.killGraceMs));
}
process.stdout.on("error", stop);
process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (finished) { signal("SIGKILL"); return; }
  if (child) { stop(); return; }
  if (stopping) return;
  frame += chunk.toString("utf8");
  if (Buffer.byteLength(frame) > 2 * 1024 * 1024) { process.exit(1); return; }
  if (!frame.endsWith("\n")) return;
  try { input = JSON.parse(frame); } catch { process.exit(1); return; }
  launch();
});
process.stdin.resume();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
function launch() {
child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, detached: false, stdio: ["ignore", "pipe", "pipe"] });
for (const stream of ["stdout", "stderr"]) {
  child[stream].on("data", (chunk) => {
    child[stream].pause();
    process.stdout.write(JSON.stringify({ type: "output", stream, data: chunk.toString("base64") }) + "\n",
      () => child[stream].resume());
  });
}
child.once("error", (error) => {
  report({ type: "error", message: error.message });
  process.exit(1);
});
child.once("spawn", () => report({ type: "started", pid: process.pid }));
child.once("exit", (code, sig) => {
  exitCode = code;
  exitSignal = sig;
  if (!stopping) {
    stopping = true;
    signal("SIGTERM");
    timer = setTimeout(complete, Math.max(0, input.killGraceMs));
  }
});
child.once("close", complete);
}
`;
