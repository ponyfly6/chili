import { parentPort, workerData } from "node:worker_threads";
import { JSException, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
import { CODE_MODE_PRELUDE } from "./prelude.js";
import { CODE_MODE_LIMITS } from "./protocol.js";
import type { CodeModeHostMessage, CodeModeWorkerData, CodeModeWorkerMessage } from "./protocol.js";

function post(message: CodeModeWorkerMessage): void {
  parentPort?.postMessage(message);
}

function errorText(error: unknown): string {
  if (error instanceof JSException) return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function run(data: CodeModeWorkerData): Promise<void> {
  const interrupt = new Int32Array(data.interrupt);
  const encoder = new TextEncoder();
  let outputBytes = 0;
  let outputItems = 0;
  let calls = 0;
  let stopped = false;
  const limit = (message: string): void => {
    if (stopped) return;
    stopped = true;
    post({ type: "error", kind: "limit", message });
    Atomics.store(interrupt, 0, 1);
  };
  const vm = await QuickJS.create({
    wasm: data.wasm,
    memoryLimit: CODE_MODE_LIMITS.memoryBytes,
    maxStackSize: MAX_STACK_SIZE,
    interruptHandler: () => Atomics.load(interrupt, 0) !== 0,
    wasi: (memory) => ({
      fd_write(_fd: number, iovs: number, count: number, written: number): number {
        const view = new DataView(memory.buffer);
        let bytes = 0;
        for (let index = 0; index < count; index++) bytes += view.getUint32(iovs + index * 8 + 4, true);
        view.setUint32(written, bytes, true);
        return 0;
      },
    }),
  });
  const bridge = vm.newFunction("bridge", (kind, first, second, third) => {
    if (stopped) return vm.undefined;
    switch (kind.toString()) {
      case "call": {
        const args = third === undefined || third.isUndefined ? undefined : third.toString();
        if (++calls > CODE_MODE_LIMITS.calls) {
          limit(`Script exceeded ${CODE_MODE_LIMITS.calls} tool calls`);
        } else if (args !== undefined && encoder.encode(args).byteLength > CODE_MODE_LIMITS.argumentBytes) {
          limit(`Tool arguments exceed ${CODE_MODE_LIMITS.argumentBytes} bytes`);
        } else {
          post({ type: "call", id: first.toNumber(), name: second.toString(), args });
        }
        break;
      }
      case "output": {
        const text = first.toString();
        outputBytes += encoder.encode(text).byteLength + 1;
        if (++outputItems > CODE_MODE_LIMITS.outputItems) limit(`Script output exceeds ${CODE_MODE_LIMITS.outputItems} text items`);
        else if (outputBytes > CODE_MODE_LIMITS.outputBytes) limit(`Script output exceeds ${CODE_MODE_LIMITS.outputBytes} bytes`);
        else post({ type: "output", text });
        break;
      }
      case "error":
        stopped = true;
        post({ type: "error", kind: "script", message: first.toString().slice(0, 8192) });
        break;
      case "done":
        stopped = true;
        post({ type: "done" });
        break;
    }
    return vm.undefined;
  });
  // The worker is destroyed after this one execution; retained VM handles live until then.
  const api = vm.withScope((scope) => scope.escape(vm.callFunction(
    vm.evalCode(CODE_MODE_PRELUDE, "code-mode-prelude.js"),
    vm.undefined,
    bridge,
    vm.newString(JSON.stringify(data.tools)),
  )));
  const start = api.getProp("run");
  const settle = api.getProp("settle");
  const checkStalled = api.getProp("drain");
  const drain = (): void => {
    vm.executePendingJobs();
    vm.callFunction(checkStalled, api).dispose();
  };
  parentPort?.on("message", (message: CodeModeHostMessage) => {
    if (stopped || message.type !== "result") return;
    try {
      vm.withScope(() => vm.callFunction(
        settle,
        api,
        vm.newNumber(message.id),
        message.ok ? vm.true : vm.false,
        message.payload === undefined ? vm.undefined : vm.newString(message.payload),
      ));
      drain();
    } catch (error) {
      post({ type: "error", kind: "sandbox", message: errorText(error) });
    }
  });
  try {
    // Keep the prefix on the first line so stack trace line numbers match the source.
    const fn = vm.evalCode(`(async () => {${data.code}\n})`, "code-mode.js");
    vm.callFunction(start, api, fn).dispose();
    fn.dispose();
    drain();
  } catch (error) {
    if (!stopped) post({ type: "error", kind: error instanceof JSException ? "script" : "sandbox", message: errorText(error) });
  }
}

if (parentPort) {
  void run(workerData as CodeModeWorkerData).catch((error: unknown) => {
    post({ type: "error", kind: "sandbox", message: errorText(error) });
  });
}
