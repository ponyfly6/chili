import { normalizePersistedError, type NormalizedPersistedError } from "@chili/protocol";

export class UnknownToolError extends Error {
  constructor(toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = "UnknownToolError";
  }
}

export class ToolValidationError extends Error {
  constructor(toolName: string, message: string) {
    super(`Invalid ${toolName} input: ${message}`);
    this.name = "ToolValidationError";
  }
}

export class ToolDeniedError extends Error {
  constructor(toolName: string, feedback?: string) {
    super(feedback ? `Tool denied: ${toolName}. ${feedback}` : `Tool denied: ${toolName}`);
    this.name = "ToolDeniedError";
  }
}

export function isAbortError(error: unknown): boolean {
  const name = safeErrorProperty(error, "name");
  const message = safeErrorProperty(error, "message");
  return name === "AbortError" || (typeof message === "string" && message.toLowerCase().includes("aborted"));
}

export function toError(error: unknown): NormalizedPersistedError {
  return normalizePersistedError(error);
}

function safeErrorProperty(error: unknown, key: string): unknown {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return undefined;
  try {
    return Reflect.get(error, key);
  } catch {
    return undefined;
  }
}
