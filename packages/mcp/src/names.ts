export interface McpSanitizedName {
  raw: string;
  sanitized: string;
}

export interface McpModelToolName {
  rawServerName: string;
  rawToolName: string;
  serverName: string;
  toolName: string;
  modelName: string;
}

const EMPTY_SERVER_NAME = "server";
const EMPTY_TOOL_NAME = "tool";

export function sanitizeMcpServerName(name: string): string {
  return sanitizeIdentifier(name, EMPTY_SERVER_NAME);
}

export function sanitizeMcpToolName(name: string): string {
  return sanitizeIdentifier(name, EMPTY_TOOL_NAME);
}

export function createMcpModelToolName(rawServerName: string, rawToolName: string): McpModelToolName {
  const serverName = sanitizeMcpServerName(rawServerName);
  const toolName = sanitizeMcpToolName(rawToolName);
  return {
    rawServerName,
    rawToolName,
    serverName,
    toolName,
    modelName: toMcpModelToolName(serverName, toolName),
  };
}

export function toMcpModelToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeMcpServerName(serverName)}__${sanitizeMcpToolName(toolName)}`;
}

function sanitizeIdentifier(name: string, fallback: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const safe = normalized.length > 0 ? normalized : fallback;
  return /^[a-z]/.test(safe) ? safe : `${fallback}_${safe}`;
}
