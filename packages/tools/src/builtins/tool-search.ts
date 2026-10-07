import type { ChiliToolDefinition, ToolRegistry, ValidationResult } from "../types.js";
import { expandToolGroups } from "../tool-catalog.js";
import { searchTools } from "../tool-search-ranker.js";

export interface ToolSearchInput {
  query: string;
  maxResults?: number;
  load?: boolean;
}

export function createToolSearchTool(
  registry: ToolRegistry,
  options: { groups?: readonly (readonly string[])[] } = {},
): ChiliToolDefinition<ToolSearchInput> {
  return {
    name: "tool_search",
    codeMode: true,
    outputSchema: {
      type: "object",
      required: ["tools", "truncated", "loaded"],
      properties: {
        loaded: { type: "array", items: { type: "string" }, description: "Tools selected for subsequent direct model calls, including related control tools." },
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
    description: "Discover tools by capability or name. Direct calls load matches and related controls for the next model request in this session; script calls inspect without loading unless load=true. Returns complete parameter and structuredData schemas and exact JavaScript access expressions. JavaScript calls return a ToolResult envelope: read .structuredData for machine values and .output for display text. Tools may omit .structuredData. Use select:name1,name2 to inspect exact names or aliases, including already loaded tools. Search never grants permissions.",
    risk: "read",
    resourcePolicy: "internal",
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultOutputBytes: 20_000,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 20 },
        load: { type: "boolean", description: "Load definitions for subsequent model calls. Defaults to true for direct calls, false inside code_mode." },
      },
    },
    validate(input): ValidationResult<ToolSearchInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      if (typeof input.query !== "string" || input.query.trim().length === 0) {
        return { ok: false, message: "query must be a non-empty string" };
      }
      if (input.maxResults !== undefined && (!isPositiveInteger(input.maxResults) || input.maxResults > 20)) {
        return { ok: false, message: "maxResults must be an integer between 1 and 20" };
      }
      if (input.load !== undefined && typeof input.load !== "boolean") return { ok: false, message: "load must be a boolean" };
      const value: ToolSearchInput = { query: input.query };
      if (input.maxResults !== undefined) value.maxResults = input.maxResults;
      if (input.load !== undefined) value.load = input.load;
      return { ok: true, value };
    },
    resources: () => false,
    async execute(input, context) {
      const tools = context.visibleTools ? await context.visibleTools() : registry.list();
      const maxResults = input.maxResults ?? 8;
      const matches = searchTools(tools, input.query, maxResults + 1);
      const results = matches.slice(0, maxResults);
      const shouldLoad = input.load ?? context.invocationMode !== "code";
      const loaded = shouldLoad && context.loadTools
        ? await context.loadTools(expandToolGroups(results, tools, options.groups ?? [])) : [];
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
        structuredData: { tools: descriptions, truncated: matches.length > results.length, loaded },
        metadata: {
          query: input.query,
          count: results.length,
          tools: results.map((tool) => tool.name),
          loaded,
        },
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
