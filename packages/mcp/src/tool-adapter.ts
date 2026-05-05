import type { ToolRisk, ToolResult } from "@chili/protocol";
import type { ChiliToolDefinition, ChiliToolExecutionContext, ToolApprovalSpec } from "@chili/tools";
import type { McpServerConfig } from "./config.js";
import type { McpCallToolResult, McpTool, McpToolAnnotations } from "./client.js";
import type { McpClientManager } from "./manager.js";
import { createMcpModelToolName } from "./names.js";

export interface McpToolMetadata {
  rawServerName: string;
  rawToolName: string;
  serverName: string;
  toolName: string;
  modelName: string;
}

export interface McpChiliToolDefinition extends ChiliToolDefinition {
  mcp: McpToolMetadata;
}

export interface McpToolAdapterOptions {
  server: McpServerConfig;
  tool: McpTool;
  manager: Pick<McpClientManager, "callTool">;
  modelName?: string;
}

export function createMcpChiliTool(options: McpToolAdapterOptions): McpChiliToolDefinition {
  const names = createMcpModelToolName(options.server.name, options.tool.name);
  const modelName = options.modelName ?? names.modelName;
  const annotations = options.tool.annotations ?? {};
  const isReadOnly = annotations.readOnlyHint === true;
  const isConcurrencySafe = inferConcurrencySafe(annotations);

  return {
    name: modelName,
    description: options.tool.description ?? `MCP tool ${options.server.name}/${options.tool.name}`,
    risk: inferRisk(annotations),
    inputSchema: options.tool.inputSchema ?? { type: "object" },
    shouldDefer: true,
    isReadOnly,
    isConcurrencySafe,
    isDestructive: annotations.destructiveHint === true,
    mcp: {
      rawServerName: options.server.name,
      rawToolName: options.tool.name,
      serverName: names.serverName,
      toolName: names.toolName,
      modelName,
    },
    approval(): ToolApprovalSpec {
      return {
        permission: "mcp",
        patterns: [`${options.server.name}/${options.tool.name}`],
        metadata: {
          server: options.server.name,
          tool: options.tool.name,
          modelName,
          annotations,
        },
      };
    },
    async execute(input: unknown, context: ChiliToolExecutionContext): Promise<ToolResult> {
      const result = await options.manager.callTool(options.server.name, options.tool.name, input, context.signal);
      if (result.isError) throw new Error(formatMcpToolOutput(result));
      return {
        title: `${options.server.name}/${options.tool.name}`,
        output: formatMcpToolOutput(result),
        metadata: {
          server: options.server.name,
          tool: options.tool.name,
          modelName,
          isError: Boolean(result.isError),
          structuredContent: result.structuredContent,
        },
      };
    },
  };
}

export function createMcpChiliTools(
  server: McpServerConfig,
  tools: readonly McpTool[],
  manager: Pick<McpClientManager, "callTool">,
): McpChiliToolDefinition[] {
  const modelNames = uniqueModelNames(server, tools);
  return tools.map((tool, index) => {
    const modelName = modelNames[index];
    return createMcpChiliTool(modelName ? { server, tool, manager, modelName } : { server, tool, manager });
  });
}

export function inferRisk(annotations: McpToolAnnotations): ToolRisk {
  if (annotations.destructiveHint === true) return "dangerous";
  if (annotations.openWorldHint === true) return "network";
  if (annotations.readOnlyHint === true) return "read";
  return "network";
}

export function inferConcurrencySafe(annotations: McpToolAnnotations): boolean {
  if (annotations.destructiveHint === true) return false;
  return annotations.readOnlyHint === true || annotations.idempotentHint === true;
}

function formatMcpToolOutput(result: McpCallToolResult): string {
  const content = result.content ?? [];
  const rendered = content.map(renderContent).filter((item) => item.length > 0);
  if (result.structuredContent !== undefined) {
    rendered.push(JSON.stringify(result.structuredContent, null, 2));
  }
  if (rendered.length > 0) return rendered.join("\n");
  return JSON.stringify(result, null, 2);
}

function renderContent(content: unknown): string {
  if (!isRecord(content)) return stringify(content);
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (content.type === "image") return `[image${typeof content.mimeType === "string" ? ` ${content.mimeType}` : ""}]`;
  if (content.type === "resource") return stringify(content.resource ?? content);
  return stringify(content);
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function uniqueModelNames(server: McpServerConfig, tools: readonly McpTool[]): string[] {
  const baseNames = tools.map((tool) => createMcpModelToolName(server.name, tool.name).modelName);
  const counts = new Map<string, number>();
  for (const name of baseNames) counts.set(name, (counts.get(name) ?? 0) + 1);

  const used = new Set<string>();
  return tools.map((tool, index) => {
    const baseName = baseNames[index] ?? createMcpModelToolName(server.name, tool.name).modelName;
    if ((counts.get(baseName) ?? 0) === 1 && !used.has(baseName)) {
      used.add(baseName);
      return baseName;
    }

    const suffix = shortHash(`${server.name}/${tool.name}`);
    let candidate = `${baseName}__${suffix}`;
    let collisionIndex = 2;
    while (used.has(candidate)) {
      candidate = `${baseName}__${suffix}_${collisionIndex}`;
      collisionIndex += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}
