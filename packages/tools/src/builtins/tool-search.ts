import type { ChiliToolDefinition, ToolRegistry, ValidationResult } from "../types.js";

export interface ToolSearchInput {
  query: string;
  maxResults?: number;
}

export function createToolSearchTool(registry: ToolRegistry): ChiliToolDefinition<ToolSearchInput> {
  return {
    name: "tool_search",
    codeMode: true,
    outputSchema: {
      type: "object",
      required: ["tools", "truncated"],
      properties: {
        tools: { type: "array", items: {
          type: "object", required: ["name", "description", "inputSchema", "outputSchema", "codeMode", "call"],
          properties: {
            name: { type: "string" }, description: { type: "string" }, inputSchema: {}, outputSchema: {},
            codeMode: { type: "boolean" },
            call: { type: ["string", "null"], description: "Exact JavaScript tools access expression, or null if this tool is unavailable in code mode." },
          },
        } },
        truncated: { type: "boolean", description: "More matching tools exist; refine the query." },
      },
    },
    aliases: ["toolsearch"],
    searchHint: "Search available tool names, aliases, descriptions, and search hints.",
    alwaysLoad: true,
    description: "Search available tools by capability or name. Returns parameter and structuredData schemas and the exact JavaScript access expression for code mode. JavaScript calls return a ToolResult envelope: read .structuredData for machine values and .output for display text; metadata.structuredDataUnavailable explains missing machine data. Use select:name1,name2 for exact names or aliases.",
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
      const maxResults = input.maxResults ?? 8;
      const matches = searchTools(tools, input.query, maxResults + 1);
      const results = matches.slice(0, maxResults);
      const descriptions = results.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? {},
        outputSchema: tool.outputSchema ?? {},
        codeMode: tool.codeMode === true,
        call: tool.codeMode === true ? `tools[${JSON.stringify(tool.name)}]` : null,
      }));
      const output = results.length
        ? descriptions.map((tool) => [
          `${tool.name}: ${tool.description}`,
          `Parameters: ${JSON.stringify(tool.inputSchema)}`,
          ...(tool.codeMode ? [`Code mode: await ${tool.call}(input)`, `Returns a ToolResult envelope; .structuredData schema: ${JSON.stringify(tool.outputSchema)}`] : []),
        ].join("\n")).join("\n\n")
        : "(no matching tools)";
      return {
        title: `tool search ${input.query}`,
        output,
        structuredData: { tools: descriptions, truncated: matches.length > results.length },
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
