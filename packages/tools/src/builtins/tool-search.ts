import type { ChiliToolDefinition, ToolRegistry, ValidationResult } from "../types.js";

export interface ToolSearchInput {
  query: string;
  maxResults?: number;
}

export function createToolSearchTool(registry: ToolRegistry): ChiliToolDefinition<ToolSearchInput> {
  return {
    name: "tool_search",
    aliases: ["toolsearch"],
    searchHint: "Search available tool names, aliases, descriptions, and search hints.",
    alwaysLoad: true,
    description: "Search available tools by capability or name.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultOutputBytes: 20_000,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
      },
    },
    validate(input): ValidationResult<ToolSearchInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      if (typeof input.query !== "string" || input.query.trim().length === 0) {
        return { ok: false, message: "query must be a non-empty string" };
      }
      if (input.maxResults !== undefined && !isPositiveInteger(input.maxResults)) {
        return { ok: false, message: "maxResults must be a positive integer" };
      }
      const value: ToolSearchInput = { query: input.query };
      if (input.maxResults !== undefined) value.maxResults = input.maxResults;
      return { ok: true, value };
    },
    approval: () => false,
    async execute(input, context) {
      const tools = context.visibleTools ? await context.visibleTools() : registry.list();
      const results = searchTools(tools, input.query, input.maxResults ?? 8);
      const output = results.length
        ? results.map((tool) => `${tool.name}: ${tool.description}`).join("\n")
        : "(no matching tools)";
      return {
        title: `tool search ${input.query}`,
        output,
        metadata: {
          query: input.query,
          count: results.length,
          tools: results.map((tool) => tool.name),
        },
      };
    },
  };
}

function searchTools(
  tools: readonly ChiliToolDefinition[],
  query: string,
  maxResults: number,
): ChiliToolDefinition[] {
  const selected = selectedTools(query);
  if (selected.length > 0) {
    const names = new Set(selected.map((name) => name.toLowerCase()));
    return tools.filter((tool) => names.has(tool.name.toLowerCase()) || tool.aliases?.some((alias) => names.has(alias.toLowerCase()))).slice(0, maxResults);
  }

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  return tools
    .filter((tool) => tool.name !== "tool_search")
    .map((tool) => ({ tool, score: scoreTool(tool, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, maxResults)
    .map((entry) => entry.tool);
}

function selectedTools(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed.toLowerCase().startsWith("select:")) return [];
  return trimmed
    .slice("select:".length)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function scoreTool(tool: ChiliToolDefinition, terms: readonly string[]): number {
  const haystacks = [
    tool.name,
    ...(tool.aliases ?? []),
    tool.description,
    tool.searchHint ?? "",
  ].map((value) => value.toLowerCase());
  let score = 0;
  for (const term of terms) {
    for (const haystack of haystacks) {
      if (haystack === term) score += 6;
      else if (haystack.includes(term)) score += 2;
    }
  }
  return score;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
