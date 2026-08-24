import { defineCommand } from "./registry.js";
import type { CommandDefinition, CommandSource } from "./types.js";

export function createPromptRoot(
  namespaces: readonly CommandDefinition[],
): CommandDefinition {
  return defineCommand({
    id: "prompt",
    name: "prompt",
    title: "Prompts",
    description: "Run reusable prompts",
    group: "prompt",
    source: "builtin",
    selectionMode: "drilldown",
    executionTarget: "prompt",
    children: namespaces,
  });
}

export function createPromptNamespace(
  source: CommandSource,
  children: readonly CommandDefinition[],
): CommandDefinition {
  return defineCommand({
    id: `prompt.${source}`,
    name: source,
    title: `${sourceLabel(source)} prompts`,
    description: `Run reusable prompts from ${sourceLabel(source).toLowerCase()}`,
    group: "prompt",
    source,
    selectionMode: "drilldown",
    executionTarget: "prompt",
    children,
  });
}

export function normalizeCommandSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function sourceLabel(source: CommandSource): string {
  switch (source) {
    case "builtin":
      return "Builtin";
    case "project":
      return "Project";
    case "user":
      return "User";
    case "mcp":
      return "MCP";
  }
}
