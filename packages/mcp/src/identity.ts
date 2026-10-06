import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { McpServerConfig } from "./config.js";

/** Identity is the configured execution target, never the display name. */
export function mcpServerIdentity(server: McpServerConfig): string {
  const target = server.type === "stdio"
    ? { type: server.type, command: resolvedCommand(server), args: server.args, cwd: canonicalPath(server.cwd ?? process.cwd()), env: server.env ?? {} }
    : { type: server.type, url: canonicalUrl(server.url), oauth: server.oauth ? {
      clientId: server.oauth.clientId ?? null,
      authorizationUrl: server.oauth.authorizationUrl ?? null,
      tokenUrl: server.oauth.tokenUrl ?? null,
      redirectUri: server.oauth.redirectUri ?? null,
      scopes: server.oauth.scopes ?? [],
    } : null };
  return `mcp:v1:${mcpDefinitionFingerprint(target)}`;
}

export function mcpDefinitionFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function canonicalUrl(value: string): string {
  try { return new URL(value).href; } catch { return value; }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}


function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function resolvedCommand(server: Extract<McpServerConfig, { type: "stdio" }>): string {
  const cwd = canonicalPath(server.cwd ?? process.cwd());
  if (isAbsolute(server.command) || server.command.includes("/")) return canonicalPath(resolve(cwd, server.command));
  for (const directory of (server.env?.PATH ?? process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(cwd, directory, server.command);
    try {
      if (statSync(candidate).isFile()) return canonicalPath(candidate);
    } catch { /* The process launcher will report a missing executable. */ }
  }
  return server.command;
}
