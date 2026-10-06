import type { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { ToolDispatchScope } from "./dispatch-scope.js";
import { ToolValidationError } from "./errors.js";
import { validateSchema, type SchemaValidationResult } from "./input-schema-validator.js";
import type { ChiliToolDefinition } from "./types.js";

const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_EXTERNAL_INPUT_BYTES = 1024 * 1024;
const VALIDATION_TIMEOUT_MS = 2_000;
const MAX_PENDING_VALIDATIONS = 64;
const workers = new ToolDispatchScope({ maxConcurrentCalls: 8 });
let pendingValidations = 0;

export interface SchemaWorkerInput {
  schema: string;
  input: string | undefined;
}

/** External schemas run off-thread so pattern matching and compilation are interruptible. */
export async function validateToolSchema(
  tool: ChiliToolDefinition,
  input: unknown,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const schema = tool.inputSchema;
  if (typeof schema !== "boolean" && (schema === null || typeof schema !== "object")) {
    throw new ToolValidationError(tool.name, "Tool has no valid input schema");
  }
  const result = tool.inputSchemaSource === "external"
    ? await validateExternalSchema(tool.name, {
      schema: boundedJson(tool.name, schema, "schema", MAX_SCHEMA_BYTES)!,
      input: boundedJson(tool.name, input, "input", MAX_EXTERNAL_INPUT_BYTES),
    }, signal)
    : validateSchema(schema, input);
  if (!result.ok) throw new ToolValidationError(tool.name, result.message);
}

function boundedJson(toolName: string, value: unknown, label: string, maxBytes: number): string | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new ToolValidationError(toolName, `Tool ${label} is not serializable JSON`);
  }
  if (json !== undefined && Buffer.byteLength(json) > maxBytes) {
    throw new ToolValidationError(toolName, `Tool ${label} exceeds ${maxBytes} bytes`);
  }
  return json;
}

async function validateExternalSchema(
  toolName: string,
  workerData: SchemaWorkerInput,
  signal?: AbortSignal,
): Promise<SchemaValidationResult> {
  if (pendingValidations >= MAX_PENDING_VALIDATIONS) {
    throw new ToolValidationError(toolName, "Too many pending external schema validations");
  }
  pendingValidations++;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new DOMException("Validation aborted", "AbortError"));
  const deadline = setTimeout(() => {
    controller.abort(new ToolValidationError(toolName, `Tool input schema validation timed out after ${VALIDATION_TIMEOUT_MS} ms`));
  }, VALIDATION_TIMEOUT_MS);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let release: (() => void) | undefined;
  try {
    release = await workers.acquire(true, controller.signal);
    return await new Promise<SchemaValidationResult>((resolve, reject) => {
      let worker: Worker | undefined;
      let settled = false;
      const finish = (result: SchemaValidationResult | undefined, error?: unknown): void => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        const termination = worker?.terminate();
        // Await termination before releasing capacity, including for synchronous regex work.
        void Promise.resolve(termination).catch(() => undefined).then(() => {
          if (error !== undefined) reject(error);
          else if (result) resolve(result);
          else reject(new ToolValidationError(toolName, "Schema worker returned no validation result"));
        });
      };
      const onAbort = () => finish(undefined, controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) { onAbort(); return; }
      try {
        const compiled = ["$bunfs", "~BUN", "%7EBUN"].some((part) => import.meta.url.includes(part));
        const workerUrl = compiled
          ? "./packages/tools/src/input-schema-worker.ts"
          : new URL(import.meta.url.endsWith(".ts") ? "./input-schema-worker.ts" : "./input-schema-worker.js", import.meta.url);
        worker = new Worker(workerUrl, {
          workerData,
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        });
        const events = worker as unknown as EventEmitter;
        events.once("message", (result: SchemaValidationResult) => finish(result));
        events.once("error", () => finish(undefined, new ToolValidationError(toolName, "Schema validation worker failed")));
        events.once("exit", () => finish(undefined, new ToolValidationError(toolName, "Schema validation worker exited before completion")));
      } catch {
        finish(undefined, new ToolValidationError(toolName, "Schema validation worker could not start"));
      }
    });
  } finally {
    release?.();
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    pendingValidations--;
  }
}
