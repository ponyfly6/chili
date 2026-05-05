import type { PromptFragment, PromptFragmentLifecycle, PromptFragmentTrust } from "./fragment.js";

export interface McpServerInstructionsInput {
  serverName: string;
  instructions?: string;
  status?: string;
  trust?: PromptFragmentTrust;
  priority?: number;
  lifecycle?: PromptFragmentLifecycle;
  maxChars?: number;
  metadata?: Record<string, unknown>;
}

export interface McpServerStatusInput {
  serverName: string;
  status: string;
  detail?: string;
}

export interface McpStdioTrustInput {
  scope: "project" | "user" | "extension" | "builtin" | string;
  transport: "stdio" | "http" | "sse" | "websocket" | string;
  trustedByUser?: boolean;
  approvedByPolicy?: boolean;
}

export type McpEnvAllowlistRule = string | RegExp | ((key: string) => boolean);

export interface FilterMcpEnvironmentResult {
  env: Record<string, string>;
  redacted: Record<string, string>;
  rejectedKeys: string[];
}

const REDACTED = "[redacted]";
const SENSITIVE_ENV_KEY = /(?:TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|CREDENTIAL|AUTH|PRIVATE|SESSION|COOKIE)/i;
const EXTENSION_TRUST_KEYS = new Set(["trust", "trusted", "approved", "approval", "trustedByUser", "approvedByPolicy"]);

export function mcpServerInstructionsPromptFragment(input: McpServerInstructionsInput): PromptFragment | undefined {
  const instructions = input.instructions?.trim();
  const status = input.status?.trim();
  if (!instructions && !status) return undefined;

  const fragment: PromptFragment = {
    id: `mcp.server.${safeFragmentId(input.serverName)}.instructions`,
    layer: "developer",
    source: "mcp",
    priority: input.priority ?? 70,
    lifecycle: input.lifecycle ?? "session",
    trust: mcpPromptTrust(input.trust),
    content: [
      `MCP server: ${input.serverName}`,
      status ? `Status: ${status}` : undefined,
      instructions ? `Instructions:\n${instructions}` : undefined,
    ].filter(isString).join("\n\n"),
    marker: {
      open: "<mcp_server_instructions>",
      close: "</mcp_server_instructions>",
    },
    metadata: {
      serverName: input.serverName,
      ...(input.metadata ?? {}),
    },
  };
  if (input.maxChars !== undefined) fragment.maxChars = input.maxChars;
  return fragment;
}

export function mcpServerStatusPromptFragment(
  statuses: readonly McpServerStatusInput[],
  options: { priority?: number; lifecycle?: PromptFragmentLifecycle; maxChars?: number } = {},
): PromptFragment | undefined {
  const lines = statuses
    .map((status) => {
      const serverName = status.serverName.trim();
      const state = status.status.trim();
      const detail = status.detail?.trim();
      if (!serverName || !state) return undefined;
      return detail ? `- ${serverName}: ${state} (${detail})` : `- ${serverName}: ${state}`;
    })
    .filter(isString);

  if (lines.length === 0) return undefined;

  const fragment: PromptFragment = {
    id: "mcp.server.status",
    layer: "contextual_user",
    source: "mcp",
    priority: options.priority ?? 60,
    lifecycle: options.lifecycle ?? "turn",
    trust: "tool",
    content: ["MCP server status:", ...lines].join("\n"),
    marker: {
      open: "<mcp_server_status>",
      close: "</mcp_server_status>",
    },
    metadata: { serverCount: lines.length },
  };
  if (options.maxChars !== undefined) fragment.maxChars = options.maxChars;
  return fragment;
}

export function mcpPromptTrust(claimedTrust: PromptFragmentTrust | undefined): PromptFragmentTrust {
  if (claimedTrust === undefined || claimedTrust === "system") return "tool";
  return claimedTrust;
}

export function projectStdioServerRequiresApproval(input: McpStdioTrustInput): boolean {
  return input.scope === "project"
    && input.transport === "stdio"
    && input.trustedByUser !== true
    && input.approvedByPolicy !== true;
}

export function filterMcpEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  allowlist: readonly McpEnvAllowlistRule[],
): FilterMcpEnvironmentResult {
  const allowed: Record<string, string> = {};
  const redacted: Record<string, string> = {};
  const rejectedKeys: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!envKeyAllowed(key, allowlist)) {
      rejectedKeys.push(key);
      continue;
    }
    allowed[key] = value;
    redacted[key] = redactMcpEnvironmentValue(key, value);
  }

  rejectedKeys.sort();
  return { env: allowed, redacted, rejectedKeys };
}

export function redactMcpEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) output[key] = redactMcpEnvironmentValue(key, value);
  }
  return output;
}

export function redactMcpEnvironmentValue(key: string, value: string): string {
  if (!SENSITIVE_ENV_KEY.test(key)) return value;
  if (value.length === 0) return REDACTED;
  return REDACTED;
}

export function stripExtensionMcpTrustClaims<T extends Record<string, unknown>>(definition: T): Omit<T, keyof McpTrustClaimFields> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(definition)) {
    if (!EXTENSION_TRUST_KEYS.has(key)) output[key] = value;
  }
  return output as Omit<T, keyof McpTrustClaimFields>;
}

interface McpTrustClaimFields {
  trust?: unknown;
  trusted?: unknown;
  approved?: unknown;
  approval?: unknown;
  trustedByUser?: unknown;
  approvedByPolicy?: unknown;
}

function envKeyAllowed(key: string, allowlist: readonly McpEnvAllowlistRule[]): boolean {
  return allowlist.some((rule) => {
    if (typeof rule === "string") return rule === key;
    if (rule instanceof RegExp) return rule.test(key);
    return rule(key);
  });
}

function safeFragmentId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return id.length > 0 ? id : "unknown";
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}
