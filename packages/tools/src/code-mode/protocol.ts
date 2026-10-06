export const CODE_MODE_LIMITS = Object.freeze({
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  memoryBytes: 64 * 1024 * 1024,
  scriptBytes: 64 * 1024,
  argumentBytes: 256 * 1024,
  resultBytes: 1024 * 1024,
  outputBytes: 256 * 1024,
  outputItems: 1024,
  catalogBytes: 256 * 1024,
  calls: 64,
  concurrency: 8,
  cleanupMs: 100,
});

export interface CodeModeToolInfo {
  name: string;
  description: string;
}

export interface CodeModeWorkerData {
  code: string;
  tools: CodeModeToolInfo[];
  wasm: WebAssembly.Module;
  interrupt: SharedArrayBuffer;
}

export type CodeModeWorkerMessage =
  | { type: "call"; id: number; name: string; args: string | undefined }
  | { type: "output"; text: string }
  | { type: "done" }
  | { type: "error"; kind: "script" | "sandbox" | "limit"; message: string };

export interface CodeModeHostMessage {
  type: "result";
  id: number;
  ok: boolean;
  payload: string | undefined;
}
