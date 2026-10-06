import { parentPort, workerData } from "node:worker_threads";
import { validateSchema } from "./input-schema-validator.js";
import type { SchemaWorkerInput } from "./input-schema.js";

const data = workerData as SchemaWorkerInput;
try {
  const schema = JSON.parse(data.schema) as object | boolean;
  const input: unknown = data.input === undefined ? undefined : JSON.parse(data.input);
  parentPort?.postMessage(validateSchema(schema, input));
} catch {
  parentPort?.postMessage({ ok: false, message: "Tool input schema could not be validated" });
}
parentPort?.close();
