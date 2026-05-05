export type McpConfigSource = "user" | "project";
export type McpTransportType = "stdio" | "http" | "sse";
export type McpDiagnosticSeverity = "warning" | "error";

export interface McpDiagnostic {
  severity: McpDiagnosticSeverity;
  code: string;
  message: string;
  path: string;
  source: McpConfigSource;
}

export interface McpCommonServerConfig {
  name: string;
  enabled: boolean;
  required: boolean;
  trust: boolean;
  includeTools?: string[];
  excludeTools?: string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  supportsParallelToolCalls?: boolean;
  source: McpConfigSource;
  raw: Record<string, unknown>;
}

export interface McpStdioTransportConfig {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpTransportConfig {
  type: "http";
  url: string;
  headers: Record<string, string>;
  oauth?: McpOAuthConfig;
}

export interface McpSseTransportConfig {
  type: "sse";
  url: string;
  headers: Record<string, string>;
  oauth?: McpOAuthConfig;
}

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  authorizationUrl?: string;
  tokenUrl?: string;
  redirectUri?: string;
}

export type McpTransportConfig = McpStdioTransportConfig | McpHttpTransportConfig | McpSseTransportConfig;
export type McpServerConfig = McpCommonServerConfig & McpTransportConfig;

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export interface McpConfigParseResult {
  config: McpConfig;
  diagnostics: McpDiagnostic[];
}

interface RawServerEntry {
  name: string;
  value: Record<string, unknown>;
  path: string;
  source: McpConfigSource;
}

export function parseMcpConfig(userRaw?: unknown, projectRaw?: unknown): McpConfigParseResult {
  const diagnostics: McpDiagnostic[] = [];
  const merged = new Map<string, RawServerEntry>();

  for (const entry of readRawServers(userRaw, "user", diagnostics)) {
    merged.set(entry.name, entry);
  }
  for (const entry of readRawServers(projectRaw, "project", diagnostics)) {
    const previous = merged.get(entry.name);
    merged.set(entry.name, previous ? mergeServerEntries(previous, entry) : entry);
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const entry of merged.values()) {
    const parsed = parseServer(entry, diagnostics);
    if (parsed) servers[parsed.name] = parsed;
  }

  return { config: { servers }, diagnostics };
}

function readRawServers(raw: unknown, source: McpConfigSource, diagnostics: McpDiagnostic[]): RawServerEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!isRecord(raw)) {
    diagnostics.push(diagnostic(source, "$", "invalid_config", "MCP config must be an object.", "error"));
    return [];
  }

  const container = readServerContainer(raw);
  if (!container) return [];
  if (!isRecord(container.value)) {
    diagnostics.push(diagnostic(source, container.path, "invalid_servers", "MCP servers must be an object.", "error"));
    return [];
  }

  const entries: RawServerEntry[] = [];
  for (const [name, value] of Object.entries(container.value)) {
    if (!isRecord(value)) {
      diagnostics.push(diagnostic(source, `${container.path}.${name}`, "invalid_server", "MCP server config must be an object.", "error"));
      continue;
    }
    entries.push({ name, value, path: `${container.path}.${name}`, source });
  }
  return entries;
}

function readServerContainer(raw: Record<string, unknown>): { value: unknown; path: string } | undefined {
  if ("mcpServers" in raw) return { value: raw.mcpServers, path: "mcpServers" };
  if ("servers" in raw) return { value: raw.servers, path: "servers" };
  return { value: raw, path: "$" };
}

function mergeServerEntries(user: RawServerEntry, project: RawServerEntry): RawServerEntry {
  return {
    name: project.name,
    value: { ...user.value, ...project.value },
    path: project.path,
    source: project.source,
  };
}

function parseServer(entry: RawServerEntry, diagnostics: McpDiagnostic[]): McpServerConfig | undefined {
  const raw = entry.value;
  const common: McpCommonServerConfig = {
    name: entry.name,
    enabled: readBoolean(raw.enabled, true, entry, "enabled", diagnostics),
    required: readBoolean(raw.required, false, entry, "required", diagnostics),
    trust: readBoolean(raw.trust ?? raw.trusted, false, entry, "trust", diagnostics),
    source: entry.source,
    raw,
  };

  assignOptionalArray(common, "includeTools", raw.includeTools ?? raw.include_tools, entry, "includeTools", diagnostics);
  assignOptionalArray(common, "excludeTools", raw.excludeTools ?? raw.exclude_tools, entry, "excludeTools", diagnostics);
  assignOptionalPositiveInteger(common, "startupTimeoutMs", raw.startupTimeoutMs ?? raw.startup_timeout_ms, entry, "startupTimeoutMs", diagnostics);
  assignOptionalPositiveInteger(common, "toolTimeoutMs", raw.toolTimeoutMs ?? raw.tool_timeout_ms, entry, "toolTimeoutMs", diagnostics);
  assignOptionalBoolean(common, "supportsParallelToolCalls", raw.supportsParallelToolCalls ?? raw.supports_parallel_tool_calls, entry, "supportsParallelToolCalls", diagnostics);

  const transport = parseTransport(raw, entry, diagnostics);
  if (!transport) return undefined;
  return { ...common, ...transport };
}

function parseTransport(raw: Record<string, unknown>, entry: RawServerEntry, diagnostics: McpDiagnostic[]): McpTransportConfig | undefined {
  const type = readTransportType(raw);
  if (type === "stdio") return parseStdio(raw, entry, diagnostics);
  if (type === "http") return parseHttpLike("http", raw, entry, diagnostics);
  if (type === "sse") return parseHttpLike("sse", raw, entry, diagnostics);

  diagnostics.push(diagnostic(entry.source, entry.path, "missing_transport", "MCP server must define stdio(command), http(url), or sse(url) transport.", "error"));
  return undefined;
}

function readTransportType(raw: Record<string, unknown>): McpTransportType | undefined {
  const explicit = raw.type ?? raw.transport;
  if (explicit === "stdio" || explicit === "http" || explicit === "sse") return explicit;
  if (typeof raw.command === "string") return "stdio";
  if (typeof raw.url === "string" && raw.url.length > 0) return raw.sse === true ? "sse" : "http";
  return undefined;
}

function parseStdio(raw: Record<string, unknown>, entry: RawServerEntry, diagnostics: McpDiagnostic[]): McpStdioTransportConfig | undefined {
  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    diagnostics.push(diagnostic(entry.source, `${entry.path}.command`, "invalid_command", "stdio MCP server command must be a non-empty string.", "error"));
    return undefined;
  }
  const args = readStringArray(raw.args, [], entry, "args", diagnostics);
  const transport: McpStdioTransportConfig = { type: "stdio", command: raw.command, args };
  const env = readStringRecord(raw.env, entry, "env", diagnostics);
  if (env) transport.env = env;
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd === "string" && raw.cwd.trim().length > 0) transport.cwd = raw.cwd;
    else diagnostics.push(diagnostic(entry.source, `${entry.path}.cwd`, "invalid_cwd", "cwd must be a non-empty string.", "error"));
  }
  return transport;
}

function parseHttpLike(
  type: "http" | "sse",
  raw: Record<string, unknown>,
  entry: RawServerEntry,
  diagnostics: McpDiagnostic[],
): McpHttpTransportConfig | McpSseTransportConfig | undefined {
  if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
    diagnostics.push(diagnostic(entry.source, `${entry.path}.url`, "invalid_url", `${type} MCP server url must be a non-empty string.`, "error"));
    return undefined;
  }
  const headers = readStringRecord(raw.headers, entry, "headers", diagnostics) ?? {};
  const oauth = readOAuth(raw.oauth, entry, diagnostics);
  return oauth ? { type, url: raw.url, headers, oauth } : { type, url: raw.url, headers };
}

function readOAuth(raw: unknown, entry: RawServerEntry, diagnostics: McpDiagnostic[]): McpOAuthConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    diagnostics.push(diagnostic(entry.source, `${entry.path}.oauth`, "invalid_oauth", "oauth must be an object.", "error"));
    return undefined;
  }

  const oauth: McpOAuthConfig = {};
  assignOptionalString(oauth, "clientId", raw.clientId ?? raw.client_id, entry, "oauth.clientId", diagnostics);
  assignOptionalString(oauth, "clientSecret", raw.clientSecret ?? raw.client_secret, entry, "oauth.clientSecret", diagnostics);
  assignOptionalArray(oauth, "scopes", raw.scopes, entry, "oauth.scopes", diagnostics);
  assignOptionalString(oauth, "authorizationUrl", raw.authorizationUrl ?? raw.authorization_url, entry, "oauth.authorizationUrl", diagnostics);
  assignOptionalString(oauth, "tokenUrl", raw.tokenUrl ?? raw.token_url, entry, "oauth.tokenUrl", diagnostics);
  assignOptionalString(oauth, "redirectUri", raw.redirectUri ?? raw.redirect_uri, entry, "oauth.redirectUri", diagnostics);
  return oauth;
}

function readBoolean(raw: unknown, fallback: boolean, entry: RawServerEntry, field: string, diagnostics: McpDiagnostic[]): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw === "boolean") return raw;
  diagnostics.push(diagnostic(entry.source, `${entry.path}.${field}`, "invalid_boolean", `${field} must be a boolean.`, "error"));
  return fallback;
}

function assignOptionalBoolean<T extends object>(
  target: T,
  key: keyof T,
  raw: unknown,
  entry: RawServerEntry,
  field: string,
  diagnostics: McpDiagnostic[],
): void {
  if (raw === undefined) return;
  if (typeof raw === "boolean") {
    target[key] = raw as T[keyof T];
    return;
  }
  diagnostics.push(diagnostic(entry.source, `${entry.path}.${field}`, "invalid_boolean", `${field} must be a boolean.`, "error"));
}

function assignOptionalPositiveInteger<T extends object>(
  target: T,
  key: keyof T,
  raw: unknown,
  entry: RawServerEntry,
  field: string,
  diagnostics: McpDiagnostic[],
): void {
  if (raw === undefined) return;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    target[key] = raw as T[keyof T];
    return;
  }
  diagnostics.push(diagnostic(entry.source, `${entry.path}.${field}`, "invalid_timeout", `${field} must be a positive integer.`, "error"));
}

function assignOptionalString<T extends object>(
  target: T,
  key: keyof T,
  raw: unknown,
  entry: RawServerEntry,
  field: string,
  diagnostics: McpDiagnostic[],
): void {
  if (raw === undefined) return;
  if (typeof raw === "string" && raw.length > 0) {
    target[key] = raw as T[keyof T];
    return;
  }
  diagnostics.push(diagnostic(entry.source, `${entry.path}.${field}`, "invalid_string", `${field} must be a non-empty string.`, "error"));
}

function assignOptionalArray<T extends object>(
  target: T,
  key: keyof T,
  raw: unknown,
  entry: RawServerEntry,
  field: string,
  diagnostics: McpDiagnostic[],
): void {
  if (raw === undefined) return;
  const value = readStringArray(raw, undefined, entry, field, diagnostics);
  if (value) target[key] = value as T[keyof T];
}

function readStringArray(raw: unknown, fallback: string[] | undefined, entry: RawServerEntry, field: string, diagnostics: McpDiagnostic[]): string[] {
  if (raw === undefined) return fallback ?? [];
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string" && item.length > 0)) {
    return [...raw];
  }
  diagnostics.push(diagnostic(entry.source, `${entry.path}.${field}`, "invalid_string_array", `${field} must be an array of non-empty strings.`, "error"));
  return fallback ?? [];
}

function readStringRecord(raw: unknown, entry: RawServerEntry, field: string, diagnostics: McpDiagnostic[]): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (isRecord(raw) && Object.values(raw).every((value) => typeof value === "string")) {
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value as string]));
  }
  diagnostics.push(diagnostic(entry.source, `${entry.path}.${field}`, "invalid_string_record", `${field} must be an object with string values.`, "error"));
  return undefined;
}

function diagnostic(source: McpConfigSource, path: string, code: string, message: string, severity: McpDiagnosticSeverity): McpDiagnostic {
  return { source, path, code, message, severity };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
