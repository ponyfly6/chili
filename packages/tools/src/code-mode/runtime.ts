/// <reference path="./wasm-asset.d.ts" />
import { readFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import type { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { CODE_MODE_LIMITS } from "./protocol.js";
import type { CodeModeHostMessage, CodeModeToolInfo, CodeModeWorkerData, CodeModeWorkerMessage } from "./protocol.js";

export { CODE_MODE_LIMITS } from "./protocol.js";

export interface CodeModeCall {
  id: number;
  name: string;
  status: "queued" | "running" | "ok" | "error" | "cancelled" | "cancellation_requested";
}

export interface CodeModeError {
  kind: "script" | "sandbox" | "timeout" | "aborted" | "limit" | "cleanup";
  message: string;
}

export interface CodeModeResult {
  ok: boolean;
  output: string;
  calls: CodeModeCall[];
  error?: CodeModeError;
}

export interface CodeModeOptions {
  code: string;
  tools: readonly CodeModeToolInfo[];
  invokeTool(name: string, input: unknown, signal: AbortSignal): Promise<unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const encoder = new TextEncoder();
let wasmPromise: Promise<WebAssembly.Module> | undefined;

function loadWasm(): Promise<WebAssembly.Module> {
  const resolvePath = async (): Promise<string> => process.versions.bun
    ? (await import("quickjs-wasi/quickjs.wasm", { with: { type: "file" } })).default
    : createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
  wasmPromise ??= resolvePath().then((path) => readFile(path))
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((error: unknown) => {
      wasmPromise = undefined;
      throw error;
    });
  return wasmPromise;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 8192);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkerMessage(value: unknown): value is CodeModeWorkerMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "done": return true;
    case "output": return typeof value.text === "string";
    case "error": return ["script", "sandbox", "limit"].includes(String(value.kind)) && typeof value.message === "string";
    case "call": return Number.isSafeInteger(value.id) && Number(value.id) > 0 && typeof value.name === "string" && (value.args === undefined || typeof value.args === "string");
    default: return false;
  }
}

interface PendingCall {
  record: CodeModeCall;
  args: unknown;
  controller: AbortController;
}

/** One isolated VM per call. Only explicitly registered tools can cross the host boundary. */
export async function executeCodeMode(options: CodeModeOptions): Promise<CodeModeResult> {
  // Bun Worker message callbacks do not retain the caller's async context.
  // Bind the capability bridge before crossing that boundary so session
  // ownership, concurrency permits, and other host scopes remain attached.
  const invokeTool = AsyncLocalStorage.bind(options.invokeTool);
  const failure = (kind: CodeModeError["kind"], message: string): CodeModeResult => ({ ok: false, output: "", calls: [], error: { kind, message } });
  if (typeof options.code !== "string" || !options.code.trim()) return failure("script", "code must be a non-empty string");
  if (encoder.encode(options.code).byteLength > CODE_MODE_LIMITS.scriptBytes) return failure("limit", `Script exceeds ${CODE_MODE_LIMITS.scriptBytes} bytes`);
  const timeoutMs = options.timeoutMs ?? CODE_MODE_LIMITS.defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CODE_MODE_LIMITS.maxTimeoutMs) {
    return failure("limit", `timeoutMs must be an integer from 1 to ${CODE_MODE_LIMITS.maxTimeoutMs}`);
  }
  if (options.signal?.aborted) return failure("aborted", "Script aborted before execution");
  // Catalog entries contain metadata only. Do not expose host objects or functions to the VM.
  const tools = options.tools.map((tool) => ({ name: tool.name, description: tool.description.slice(0, 1024) }));
  if (encoder.encode(JSON.stringify(tools)).byteLength > CODE_MODE_LIMITS.catalogBytes) return failure("limit", "Tool catalog exceeds the code mode catalog budget");
  const names = new Set(tools.map((tool) => tool.name));
  if (names.size !== tools.length) return failure("sandbox", "Duplicate code mode tool names");

  return new Promise<CodeModeResult>((resolve) => {
    const interrupt = new SharedArrayBuffer(4);
    const output: string[] = [];
    const calls: CodeModeCall[] = [];
    const pending = new Map<number, PendingCall>();
    const running = new Set<Promise<void>>();
    let worker: Worker | undefined;
    let outputBytes = 0;
    let finished = false;
    let active = 0;
    const abort = (): void => finish({ kind: "aborted", message: "Script aborted" });
    const timer = setTimeout(() => finish({ kind: "timeout", message: `Script exceeded ${timeoutMs} ms` }), timeoutMs);

    function finish(error?: CodeModeError): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      Atomics.store(new Int32Array(interrupt), 0, 1);
      for (const call of pending.values()) {
        call.record.status = call.record.status === "queued" ? "cancelled" : "cancellation_requested";
        call.controller.abort(new Error("Code mode execution ended"));
      }
      pending.clear();
      // Give cooperative tools time to release resources without allowing a broken handler to
      // keep the turn alive forever. Aborted calls cannot enqueue another invocation or reply.
      const drain = async (): Promise<void> => {
        await worker?.terminate().catch(() => undefined);
        if (running.size > 0) {
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            Promise.allSettled([...running]),
            new Promise<void>((done) => { cleanupTimer = setTimeout(done, CODE_MODE_LIMITS.cleanupMs); }),
          ]);
          clearTimeout(cleanupTimer);
        }
        if (running.size > 0) {
          const message = "Some host tool calls did not settle after cancellation; termination is unconfirmed and side effects may still finish";
          error = error ? { ...error, message: `${error.message}. ${message}` } : { kind: "cleanup", message };
        }
        resolve({
          ok: error === undefined,
          output: output.join("\n"),
          calls: calls.map((call) => ({ ...call })),
          ...(error ? { error } : {}),
        });
      };
      void drain();
    }

    function pump(): void {
      if (finished) return;
      for (const [id, call] of pending) {
        if (active >= CODE_MODE_LIMITS.concurrency) break;
        if (call.record.status !== "queued") continue;
        call.record.status = "running";
        active++;
        const task = runCall(id, call).finally(() => {
          running.delete(task);
          active--;
          pump();
        });
        running.add(task);
      }
    }

    async function runCall(id: number, call: PendingCall): Promise<void> {
      let reply: CodeModeHostMessage;
      try {
        // Recheck at the last boundary before invoking any host capability.
        if (finished || call.controller.signal.aborted) return;
        const value = await invokeTool(call.record.name, call.args, call.controller.signal);
        call.record.status = "ok";
        pending.delete(id);
        if (finished) return;
        const payload = value === undefined ? undefined : JSON.stringify(value);
        if (payload !== undefined && encoder.encode(payload).byteLength > CODE_MODE_LIMITS.resultBytes) {
          finish({ kind: "limit", message: `Tool ${call.record.name} returned more than ${CODE_MODE_LIMITS.resultBytes} bytes` });
          return;
        }
        call.record.status = "ok";
        reply = { type: "result", id, ok: true, payload };
      } catch (error) {
        if (finished) { call.record.status = call.controller.signal.aborted ? "cancelled" : "error"; return; }
        call.record.status = "error";
        reply = { type: "result", id, ok: false, payload: errorMessage(error) };
      }
      pending.delete(id);
      if (!finished) worker?.postMessage(reply);
    }

    function onMessage(message: unknown): void {
      if (finished) return;
      if (!isWorkerMessage(message)) {
        finish({ kind: "sandbox", message: "Invalid message from code mode worker" });
        return;
      }
      switch (message.type) {
        case "done": finish(); break;
        case "error": finish({ kind: message.kind, message: message.message.slice(0, 8192) }); break;
        case "output":
          outputBytes += encoder.encode(message.text).byteLength + 1;
          if (output.length >= CODE_MODE_LIMITS.outputItems) finish({ kind: "limit", message: `Script output exceeds ${CODE_MODE_LIMITS.outputItems} text items` });
          else if (outputBytes > CODE_MODE_LIMITS.outputBytes) finish({ kind: "limit", message: `Script output exceeds ${CODE_MODE_LIMITS.outputBytes} bytes` });
          else output.push(message.text);
          break;
        case "call": {
          if (calls.length >= CODE_MODE_LIMITS.calls || pending.has(message.id) || calls.some((call) => call.id === message.id)) {
            finish({ kind: "limit", message: "Script exceeded its tool call budget or repeated a call id" });
            return;
          }
          if (!names.has(message.name)) {
            finish({ kind: "sandbox", message: `Tool is unavailable in code mode: ${message.name}` });
            return;
          }
          if (message.args !== undefined && encoder.encode(message.args).byteLength > CODE_MODE_LIMITS.argumentBytes) {
            finish({ kind: "limit", message: `Tool arguments exceed ${CODE_MODE_LIMITS.argumentBytes} bytes` });
            return;
          }
          let args: unknown;
          try { args = message.args === undefined ? undefined : JSON.parse(message.args); }
          catch { finish({ kind: "sandbox", message: "Tool arguments were not valid JSON" }); return; }
          const record: CodeModeCall = { id: message.id, name: message.name, status: "queued" };
          calls.push(record);
          pending.set(message.id, { record, args, controller: new AbortController() });
          pump();
          break;
        }
      }
    }

    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    void loadWasm().then((wasm) => {
      if (finished) return;
      const workerData: CodeModeWorkerData = { code: options.code, tools, wasm, interrupt };
      // Explicit extra entrypoints retain their repository-relative source specifiers in
      // Bun's embedded module graph, including Windows' virtual filesystem.
      const isCompiled = ["$bunfs", "~BUN", "%7EBUN"].some((part) => import.meta.url.includes(part));
      const workerUrl = isCompiled
        ? "./packages/tools/src/code-mode/worker.ts"
        : new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
      worker = new Worker(workerUrl, { workerData });
      // Worker is an EventEmitter on both supported hosts. Bun's and Node 25's ambient
      // declarations currently disagree about its inherited event methods.
      const events = worker as unknown as EventEmitter;
      events.on("message", onMessage);
      events.on("error", (error: unknown) => finish({ kind: "sandbox", message: errorMessage(error) }));
      events.on("exit", (code: number) => finish({ kind: "sandbox", message: `Code mode worker exited before completion (${code})` }));
    }).catch((error: unknown) => finish({ kind: "sandbox", message: errorMessage(error) }));
  });
}
