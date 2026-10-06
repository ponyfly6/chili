import type { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultEnvironment, type StdioServerParameters } from "@modelcontextprotocol/client/stdio";

export const MCP_STDIO_GUARDIAN_MODE = "--chili-mcp-stdio-guardian";
export interface McpGuardianLifecycleEvent { type: "started" | "finished"; pid: number; cwd: string }

/** Entry for compiled CLI/sidecar executables, which cannot interpret `-e`. */
export function runMcpStdioGuardianEntrypoint(): void {
  new Function("require", "settings", `const GUARDIAN_FUNCTION = ${JSON.stringify(STDIO_GUARDIAN_SOURCE_FUNCTION)}; ${STDIO_GUARDIAN_SOURCE}`)(createRequire(import.meta.url), process.argv.slice(3));
}

interface Run {
  outer: Socket;
  guardian?: Socket;
  pid?: number;
  cwd?: string;
  cleanup?: Promise<void>;
}

/** A host-owned control socket, separate from the server's protocol stdin. */
export class McpStdioGuardianOwner {
  private readonly capabilities = new Map<string, StdioServerParameters>();
  private readonly runs = new Map<string, Run>();
  private readonly sockets = new Set<Socket>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly server: Server,
    private readonly directory: string,
    private readonly path: string,
    private readonly lifecycle?: (event: McpGuardianLifecycleEvent) => void,
  ) {}

  static async create(lifecycle?: (event: McpGuardianLifecycleEvent) => void): Promise<McpStdioGuardianOwner> {
    if (process.platform === "win32") throw new Error("Managed MCP stdio requires a POSIX host");
    const directory = await mkdtemp(join(tmpdir(), "chili-mcp-"));
    await chmod(directory, 0o700);
    const path = join(directory, "owner.sock");
    const server = createServer((socket) => owner.accept(socket));
    const owner = new McpStdioGuardianOwner(server, directory, path, lifecycle);
    const serverEvents = server as Server & Pick<EventEmitter<{ error: [error: Error] }>, "once" | "removeListener">;
    try {
      await new Promise<void>((resolve, reject) => {
        serverEvents.once("error", reject);
        server.listen(path, () => { serverEvents.removeListener("error", reject); resolve(); });
      });
      await chmod(path, 0o600);
      return owner;
    } catch (error) {
      server.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  wrap(parameters: StdioServerParameters): { parameters: StdioServerParameters; revoke(): void } {
    if (this.closed) throw new Error("MCP process owner is closed");
    const capability = randomBytes(32).toString("hex");
    this.capabilities.set(capability, parameters);
    const settings = ["outer", this.path, capability];
    const compiled = typeof Bun !== "undefined" && Bun.main.startsWith("/$bunfs/");
    const args = compiled ? [MCP_STDIO_GUARDIAN_MODE, ...settings]
      : ["-e", `(${STDIO_GUARDIAN_SOURCE_FUNCTION})(${JSON.stringify(settings)})`];
    return {
      parameters: {
        command: process.execPath, args, cwd: "/",
        // Never let project preloads or bunfig execute in the trusted wrapper.
        env: { PATH: "/usr/bin:/bin", HOME: "/", NODE_OPTIONS: "", BUN_OPTIONS: "" },
        stderr: parameters.stderr ?? "ignore",
        ...(parameters.maxBufferSize === undefined ? {} : { maxBufferSize: parameters.maxBufferSize }),
      },
      revoke: () => { this.capabilities.delete(capability); },
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.capabilities.clear();
    this.closePromise = (async () => {
      const listenerClosed = new Promise<void>((resolve) => this.server.close(() => resolve()));
      for (const run of this.runs.values()) this.stop(run);
      for (const socket of this.sockets) socket.destroy();
      await Promise.all([...this.runs.entries()].map(([id, run]) => this.cleanup(id, run)));
      await listenerClosed;
      await rm(this.directory, { recursive: true, force: true });
    })();
    return this.closePromise;
  }

  private accept(socket: Socket): void {
    if (this.closed) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.sockets.delete(socket));
    let frame = "";
    const timeout = setTimeout(() => socket.destroy(), 5_000);
    const firstFrame = (chunk: Buffer): void => {
      frame += chunk.toString("utf8");
      if (Buffer.byteLength(frame) > 16_384) { socket.destroy(); return; }
      if (!frame.includes("\n")) return;
      clearTimeout(timeout);
      socket.removeListener("data", firstFrame);
      try {
        const request = JSON.parse(frame.slice(0, frame.indexOf("\n"))) as { role?: string; capability?: string; runId?: string; pid?: number };
        const config = request.capability ? this.capabilities.get(request.capability) : undefined;
        if (!config || !request.runId || !/^[a-f0-9]{64}$/.test(request.runId)) throw new Error("Invalid process capability");
        const id = `${request.capability}:${request.runId}`;
        if (request.role === "outer") {
          if (this.runs.has(id)) throw new Error("Duplicate process wrapper");
          const run: Run = { outer: socket };
          this.runs.set(id, run);
          socket.once("close", () => { this.stop(run); void this.cleanup(id, run).catch(() => undefined); });
          socket.once("end", () => this.stop(run));
          socket.write("ready\n");
          return;
        }
        const run = this.runs.get(id);
        if (request.role !== "guardian" || !run || run.outer.destroyed || run.guardian
          || !Number.isSafeInteger(request.pid) || request.pid! <= 0) throw new Error("Invalid guardian handshake");
        const pid = request.pid!;
        const cwd = config.cwd ?? process.cwd();
        // This synchronous callback is a required durable registration barrier.
        // No command config is sent and no server is launched if it rejects.
        this.lifecycle?.({ type: "started", pid, cwd });
        run.guardian = socket;
        run.pid = pid;
        run.cwd = cwd;
        socket.once("close", () => { void this.cleanup(id, run).catch(() => undefined); });
        socket.write(`${JSON.stringify({ command: config.command, args: config.args ?? [], cwd,
          env: { ...getDefaultEnvironment(), ...config.env }, killGraceMs: 250 })}\n`);
      } catch {
        socket.destroy();
      }
    };
    socket.on("data", firstFrame);
    socket.once("close", () => clearTimeout(timeout));
  }

  private stop(run: Run): void {
    run.guardian?.end("stop\n");
  }

  private cleanup(id: string, run: Run): Promise<void> {
    if (run.cleanup) return run.cleanup;
    run.cleanup = (async () => {
      if (run.pid) {
        const deadline = Date.now() + 5_000;
        while (groupMayBeAlive(run.pid)) {
          if (Date.now() >= deadline) throw new Error("MCP process group has not confirmed cleanup");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        this.lifecycle?.({ type: "finished", pid: run.pid, cwd: run.cwd! });
      }
      this.runs.delete(id);
    })();
    return run.cleanup;
  }
}

function groupMayBeAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

// This source is bundled into the compiled entrypoint as well as passed to a
// development interpreter. Only the host control socket supplies command data.
const STDIO_GUARDIAN_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { connect } = require("node:net");
const { randomBytes } = require("node:crypto");
const [mode, path, capability, inheritedRun] = settings;
const runId = inheritedRun || randomBytes(32).toString("hex");
const owner = connect(path);
let child;
let stopping = false;
let timer;
let frame = "";
function stop() {
  if (stopping) return;
  stopping = true;
  if (mode === "outer") {
    owner.end();
    if (!child) process.exit(0);
    else { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    return;
  }
  if (!child) process.exit(0);
  try { process.kill(-process.pid, "SIGTERM"); } catch { process.exit(1); }
  timer = setTimeout(() => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } }, 250);
}
owner.on("error", stop);
owner.on("end", stop);
owner.on("close", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
owner.on("connect", () => owner.write(JSON.stringify({ role: mode, capability, runId, pid: process.pid }) + "\n"));
owner.on("data", (chunk) => {
  if (stopping) return;
  if (child) { stop(); return; }
  frame += chunk.toString("utf8");
  if (Buffer.byteLength(frame) > 2 * 1024 * 1024) { stop(); return; }
  if (!frame.includes("\n")) return;
  if (mode === "outer") {
    if (frame !== "ready\n") { stop(); return; }
    const innerSettings = ["guardian", path, capability, runId];
    const compiled = typeof Bun !== "undefined" && Bun.main.startsWith("/$bunfs/");
    const args = compiled ? ["--chili-mcp-stdio-guardian", ...innerSettings]
      : ["-e", "(" + GUARDIAN_FUNCTION + ")(" + JSON.stringify(innerSettings) + ")"];
    child = spawn(process.execPath, args, { cwd: "/", env: { PATH: "/usr/bin:/bin", HOME: "/", NODE_OPTIONS: "", BUN_OPTIONS: "" },
      detached: true, stdio: ["pipe", "inherit", "inherit"] });
    process.stdin.on("end", stop);
    process.stdin.on("error", stop);
    child.stdin.on("error", stop);
    process.stdin.pipe(child.stdin);
    child.once("error", stop);
    child.once("close", () => process.exit(0));
    return;
  }
  let config;
  try { config = JSON.parse(frame.slice(0, frame.indexOf("\n"))); } catch { stop(); return; }
  child = spawn(config.command, config.args, { cwd: config.cwd, env: config.env, detached: false, stdio: "inherit" });
  child.once("error", stop);
  child.once("exit", stop);
});
`;
const STDIO_GUARDIAN_SOURCE_FUNCTION = `function(settings) { const GUARDIAN_FUNCTION = arguments.callee.toString(); ${STDIO_GUARDIAN_SOURCE} }`;
