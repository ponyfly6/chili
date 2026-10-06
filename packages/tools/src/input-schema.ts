import { Ajv, type ValidateFunction } from "ajv";
import { ToolValidationError } from "./errors.js";
import type { ChiliToolDefinition } from "./types.js";

const validator = new Ajv({ strict: false, allErrors: false, ownProperties: true, validateFormats: false, addUsedSchema: false });
const compiled = new WeakMap<object, ValidateFunction>();

/** Custom validators normalize compatibility aliases; schema validates the prepared arguments. */
export function validateToolSchema(tool: ChiliToolDefinition, input: unknown): void {
  const schema = tool.inputSchema;
  if (typeof schema !== "boolean" && (schema === null || typeof schema !== "object")) {
    throw new ToolValidationError(tool.name, "Tool inputSchema must be a JSON Schema object or boolean.");
  }
  let validate = typeof schema === "object" ? compiled.get(schema) : undefined;
  try {
    if (!validate) {
      validate = validator.compile(schema);
      if (typeof schema === "object") compiled.set(schema, validate);
    }
    if ((validate as ValidateFunction & { $async?: boolean }).$async) {
      throw new ToolValidationError(tool.name, "Asynchronous JSON Schema extensions are unsupported.");
    }
    if (!validate(input)) {
      throw new ToolValidationError(tool.name, validator.errorsText(validate.errors));
    }
  } catch (error) {
    if (error instanceof ToolValidationError) throw error;
    throw new ToolValidationError(tool.name, `Invalid inputSchema: ${error instanceof Error ? error.message : String(error)}`);
  }
}
