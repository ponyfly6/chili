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
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
