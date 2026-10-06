import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv2019 } from "ajv/dist/2019.js";

const MAX_CACHE_ENTRIES = 128;
const MAX_CACHE_KEY_BYTES = 2 * 1024 * 1024;
const cache = new Map<string, ValidateFunction>();
let cacheBytes = 0;

export type SchemaValidationResult = { ok: true } | { ok: false; message: string };

/** Used on the host only for trusted, built-in schemas; external schemas use a worker. */
export function validateSchema(schema: object | boolean, input: unknown): SchemaValidationResult {
  let key: string;
  try {
    key = JSON.stringify(schema);
  } catch {
    return { ok: false, message: "Tool input schema could not be compiled" };
  }
  let check = cache.get(key);
  if (!check) {
    try {
      // Each tool owns its $id namespace. MCP servers may legitimately reuse IDs.
      const dialect = typeof schema === "object" && "$schema" in schema ? schema.$schema : undefined;
      const SchemaValidator = typeof dialect === "string" && dialect.includes("2020-12") ? Ajv2020
        : typeof dialect === "string" && dialect.includes("2019-09") ? Ajv2019 : Ajv;
      const validator = new SchemaValidator({ strict: false, allErrors: false, validateFormats: false, ownProperties: true });
      check = validator.compile(schema);
    } catch {
      return { ok: false, message: "Tool input schema could not be compiled" };
    }
    const keyBytes = Buffer.byteLength(key);
    if (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + keyBytes > MAX_CACHE_KEY_BYTES) {
      cache.clear();
      cacheBytes = 0;
    }
    if (keyBytes <= MAX_CACHE_KEY_BYTES) {
      cache.set(key, check);
      cacheBytes += keyBytes;
    }
  }
  if (!check(input)) {
    const error = check.errors?.[0];
    return { ok: false, message: `${error?.instancePath || "input"} ${error?.message ?? "does not match its schema"}` };
  }
  return { ok: true };
}
