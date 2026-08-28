import { normalizePersistedError, type ToolResultContent, type ToolRisk, type ToolResult } from "@chili/protocol";
import type { ChiliToolDefinition, ChiliToolExecutionContext, ToolApprovalSpec } from "@chili/tools";
import type { McpServerConfig } from "./config.js";
import type { McpCallToolResult, McpTool, McpToolAnnotations } from "./client.js";
import type { McpClientManager } from "./manager.js";
import { createMcpModelToolName } from "./names.js";

const MAX_MCP_CONTENT_ITEMS = 64;
const MAX_MCP_TEXT_ITEM_BYTES = 256_000;
const MAX_MCP_IMAGE_ITEM_BYTES = 4_000_000;
const MAX_MCP_CONTENT_TOTAL_BYTES = 8_000_000;
const MAX_MCP_STRUCTURED_BYTES = 512_000;
const MAX_MCP_STRUCTURED_STRING_BYTES = 128_000;
const MAX_MCP_STRUCTURED_ITEMS = 128;
const MAX_MCP_STRUCTURED_DEPTH = 12;
const MAX_MCP_STRUCTURED_NODES = 2_048;

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
    description: sanitizeMcpToolDescription(
      options.tool.description ?? `MCP tool ${options.server.name}/${options.tool.name}`,
      options.server.name,
      options.tool.name,
    ),
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
      try {
        const rawResult = await options.manager.callTool(options.server.name, options.tool.name, input, context.signal);
        const result = boundMcpToolResult(rawResult);
        if (result.isError) {
          const error = new Error(formatMcpToolOutput(result)) as Error & { code?: string };
          error.name = "McpToolError";
          error.code = "MCP_TOOL_ERROR";
          throw error;
        }
        return {
          title: `${options.server.name}/${options.tool.name}`,
          output: formatMcpToolOutput(result),
          ...optionalContent(mcpToolResultContent(result)),
          metadata: {
            server: options.server.name,
            tool: options.tool.name,
            modelName,
            isError: Boolean(result.isError),
            structuredContent: result.structuredContent,
          },
        };
      } catch (error) {
        throw normalizePersistedError(error);
      }
    },
  };
}

export function sanitizeMcpToolDescription(description: string, serverName: string, toolName: string): string {
  const capability = description.trim() || `MCP tool ${serverName}/${toolName}`;
  const sanitized = capability
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0 && !isToolUseDirectiveParagraph(paragraph))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const body = sanitized || `MCP tool ${serverName}/${toolName}.`;
  return [
    "Use this MCP tool only when it is relevant to the current task and higher-priority instructions do not already provide the needed information.",
    body,
  ].join("\n\n");
}

function isToolUseDirectiveParagraph(paragraph: string): boolean {
  return /\b(?:you\s+)?must\s+use\s+this\s+tool\b/i.test(paragraph)
    || /\buse\s+this\s+tool\s+whenever\b/i.test(paragraph);
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

function boundMcpToolResult(result: McpCallToolResult): McpCallToolResult {
  let remainingContentBytes = MAX_MCP_CONTENT_TOTAL_BYTES;
  const rawContent = result.content ?? [];
  const content: unknown[] = [];
  const keptItems = rawContent.length > MAX_MCP_CONTENT_ITEMS
    ? MAX_MCP_CONTENT_ITEMS - 1
    : MAX_MCP_CONTENT_ITEMS;
  for (const item of rawContent.slice(0, keptItems)) {
    if (remainingContentBytes <= 0) break;
    const bounded = boundMcpContentItem(item, remainingContentBytes);
    content.push(bounded.value);
    remainingContentBytes -= bounded.bytes;
  }
  if (rawContent.length > MAX_MCP_CONTENT_ITEMS) {
    const text = truncateUtf8String(
      `[${rawContent.length - keptItems} MCP content items omitted: item limit exceeded]`,
      Math.max(0, remainingContentBytes),
    );
    if (text) content.push({ type: "text", text });
  }
  const structuredContent = result.structuredContent === undefined
    ? undefined
    : boundStructuredValue(result.structuredContent);
  return {
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

function boundMcpContentItem(value: unknown, remainingBytes: number): { value: unknown; bytes: number } {
  if (!isRecord(value)) {
    const bounded = boundStructuredValue(value, Math.min(remainingBytes, MAX_MCP_TEXT_ITEM_BYTES));
    return fitBoundedStructuredItem(bounded, remainingBytes);
  }
  if (value.type === "text" && typeof value.text === "string") {
    const limit = Math.max(0, Math.min(remainingBytes, MAX_MCP_TEXT_ITEM_BYTES));
    const text = truncateTextWithNotice(value.text, limit, "MCP text content");
    return { value: { type: "text", text }, bytes: utf8Bytes(text) };
  }
  if (value.type === "image" && typeof value.data === "string") {
    const encodedBytes = utf8Bytes(value.data);
    const rawMimeType = typeof value.mimeType === "string"
      ? truncateUtf8String(value.mimeType, 128)
      : "image/png";
    if (encodedBytes > MAX_MCP_IMAGE_ITEM_BYTES || encodedBytes + utf8Bytes(rawMimeType) > remainingBytes) {
      const text = truncateUtf8String(
        `[MCP image omitted: ${encodedBytes} encoded bytes exceeds content limit]`,
        Math.max(0, remainingBytes),
      );
      return { value: { type: "text", text }, bytes: utf8Bytes(text) };
    }
    return {
      value: { type: "image", data: value.data, mimeType: rawMimeType },
      bytes: encodedBytes + utf8Bytes(rawMimeType),
    };
  }
  const bounded = boundStructuredValue(value, Math.min(remainingBytes, MAX_MCP_TEXT_ITEM_BYTES));
  return fitBoundedStructuredItem(bounded, remainingBytes);
}

function fitBoundedStructuredItem(value: unknown, remainingBytes: number): { value: unknown; bytes: number } {
  const bytes = boundedJsonBytes(value);
  if (bytes <= remainingBytes) return { value, bytes };
  const text = truncateUtf8String("[MCP content omitted: aggregate content limit exceeded]", Math.max(0, remainingBytes));
  return { value: { type: "text", text }, bytes: utf8Bytes(text) };
}

function boundStructuredValue(value: unknown, maxBytes = MAX_MCP_STRUCTURED_BYTES): unknown {
  const state = {
    nodes: 0,
    seen: new WeakSet<object>(),
  };
  return visitStructuredValue(
    value,
    state,
    0,
    Math.max(0, Math.min(maxBytes, MAX_MCP_STRUCTURED_BYTES)),
  );
}

function visitStructuredValue(
  value: unknown,
  state: { nodes: number; seen: WeakSet<object> },
  depth: number,
  maxSerializedBytes: number,
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_MCP_STRUCTURED_NODES) {
    return fitStructuredJsonString("[omitted: structured content node limit exceeded]", maxSerializedBytes);
  }
  if (typeof value === "string") {
    return fitStructuredJsonString(
      value,
      Math.min(maxSerializedBytes, MAX_MCP_STRUCTURED_STRING_BYTES + 2),
      "structured string",
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") {
    return fitStructuredJsonString(safeStructuredString(value), maxSerializedBytes, "structured value");
  }
  if (depth >= MAX_MCP_STRUCTURED_DEPTH) {
    return fitStructuredJsonString("[omitted: structured content depth limit exceeded]", maxSerializedBytes);
  }
  if (state.seen.has(value)) {
    return fitStructuredJsonString("[omitted: circular structured content]", maxSerializedBytes);
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    let bytes = 2;
    const rawLength = safeStructuredArrayLength(value);
    const keptItems = Math.min(rawLength, MAX_MCP_STRUCTURED_ITEMS);
    for (let index = 0; index < keptItems; index += 1) {
      const separatorBytes = result.length === 0 ? 0 : 1;
      const childBudget = maxSerializedBytes - bytes - separatorBytes;
      if (childBudget < 2) break;
      const child = visitStructuredValue(
        safeStructuredValueAt(value, index),
        state,
        depth + 1,
        childBudget,
      );
      const childBytes = boundedJsonBytes(child);
      if (childBytes > childBudget) break;
      result.push(child);
      bytes += separatorBytes + childBytes;
    }
    if (rawLength > result.length) {
      appendStructuredArrayMarker(result, `[${rawLength - result.length} items omitted]`, maxSerializedBytes);
    }
    return result;
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let bytes = 2;
  let visitedEntries = 0;
  let omitted = false;
  try {
    for (const rawKey in value) {
      if (!safeStructuredHasOwn(value, rawKey)) continue;
      if (visitedEntries >= MAX_MCP_STRUCTURED_ITEMS) {
        omitted = true;
        break;
      }
      visitedEntries += 1;
      const key = truncateUtf8String(rawKey, 512);
      const separatorBytes = Object.keys(result).length === 0 ? 0 : 1;
      const entryPrefixBytes = separatorBytes + boundedJsonBytes(key) + 1;
      const childBudget = maxSerializedBytes - bytes - entryPrefixBytes;
      if (childBudget < 2) {
        omitted = true;
        break;
      }
      const child = visitStructuredValue(
        safeStructuredRecordValue(value, rawKey),
        state,
        depth + 1,
        childBudget,
      );
      const childBytes = boundedJsonBytes(child);
      if (childBytes > childBudget) {
        omitted = true;
        break;
      }
      result[key] = child;
      bytes += entryPrefixBytes + childBytes;
    }
  } catch {
    omitted = true;
  }
  if (omitted) appendStructuredRecordMarker(result, "additional structured keys omitted", maxSerializedBytes);
  return result;
}

function appendStructuredArrayMarker(result: unknown[], marker: string, maxBytes: number): void {
  const separatorBytes = result.length === 0 ? 0 : 1;
  const currentBytes = boundedJsonBytes(result);
  const budget = maxBytes - currentBytes - separatorBytes;
  if (budget < 2) return;
  const bounded = fitStructuredJsonString(marker, budget);
  if (boundedJsonBytes(bounded) <= budget) result.push(bounded);
}

function appendStructuredRecordMarker(result: Record<string, unknown>, marker: string, maxBytes: number): void {
  const key = Object.prototype.hasOwnProperty.call(result, "__omitted__")
    ? "__chili_omitted__"
    : "__omitted__";
  const separatorBytes = Object.keys(result).length === 0 ? 0 : 1;
  const currentBytes = boundedJsonBytes(result);
  const budget = maxBytes - currentBytes - separatorBytes - boundedJsonBytes(key) - 1;
  if (budget < 2) return;
  const bounded = fitStructuredJsonString(marker, budget);
  if (boundedJsonBytes(bounded) <= budget) result[key] = bounded;
}

function fitStructuredJsonString(value: string, maxSerializedBytes: number, label?: string): string {
  if (maxSerializedBytes < 2) return "";
  if (boundedJsonBytes(value) <= maxSerializedBytes) return value;
  const originalBytes = utf8Bytes(value);
  const marker = label ? `\n[${label} truncated from ${originalBytes} bytes]` : "";
  const boundedMarker = boundedJsonBytes(marker) <= maxSerializedBytes
    ? marker
    : structuredJsonStringPrefix(marker, maxSerializedBytes);
  if (!boundedMarker) return "";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const prefix = safeStructuredPrefix(value, middle);
    if (boundedJsonBytes(`${prefix}${boundedMarker}`) <= maxSerializedBytes) low = middle;
    else high = middle - 1;
  }
  return `${safeStructuredPrefix(value, low)}${boundedMarker}`;
}

function structuredJsonStringPrefix(value: string, maxSerializedBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (boundedJsonBytes(safeStructuredPrefix(value, middle)) <= maxSerializedBytes) low = middle;
    else high = middle - 1;
  }
  return safeStructuredPrefix(value, low);
}

function safeStructuredPrefix(value: string, end: number): string {
  let safeEnd = end;
  if (safeEnd > 0) {
    const code = value.charCodeAt(safeEnd - 1);
    if (code >= 0xd800 && code <= 0xdbff) safeEnd -= 1;
  }
  return value.slice(0, safeEnd);
}

function safeStructuredString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[omitted: structured value could not be read]";
  }
}

function safeStructuredArrayLength(value: unknown[]): number {
  try {
    const length = Reflect.get(value, "length");
    return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : 0;
  } catch {
    return 0;
  }
}

function safeStructuredValueAt(value: unknown[], index: number): unknown {
  try {
    return Reflect.get(value, index);
  } catch {
    return "[omitted: structured item getter threw]";
  }
}

function safeStructuredHasOwn(value: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    return false;
  }
}

function safeStructuredRecordValue(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return "[omitted: structured property getter threw]";
  }
}

function boundedJsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

function truncateTextWithNotice(value: string, maxBytes: number, label: string): string {
  const bytes = utf8Bytes(value);
  if (bytes <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  const notice = `\n[${label} truncated from ${bytes} bytes]`;
  const noticeBytes = utf8Bytes(notice);
  if (noticeBytes >= maxBytes) return truncateUtf8String(notice, maxBytes);
  return `${truncateUtf8String(value, maxBytes - noticeBytes)}${notice}`;
}

function truncateUtf8String(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function optionalContent(content: ToolResultContent[] | undefined): { content?: ToolResultContent[] } {
  return content ? { content } : {};
}

function mcpToolResultContent(result: McpCallToolResult): ToolResultContent[] | undefined {
  const content = (result.content ?? []).flatMap((item) => mcpContentPart(item));
  return content.length > 0 ? content : undefined;
}

function mcpContentPart(content: unknown): ToolResultContent[] {
  if (!isRecord(content)) return [];
  if (content.type === "text" && typeof content.text === "string") return [{ type: "text", text: content.text }];
  if (content.type !== "image" || typeof content.data !== "string") return [];
  const mimeType = typeof content.mimeType === "string" && content.mimeType.length > 0 ? content.mimeType : "image/png";
  return [{ type: "image", data: content.data, mimeType }];
}

function renderContent(content: unknown): string {
  if (!isRecord(content)) return stringify(content);
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (content.type === "image") return imagePlaceholder(content);
  if (content.type === "resource") return stringify(content.resource ?? content);
  return stringify(content);
}

function imagePlaceholder(content: Record<string, unknown>): string {
  const mime = typeof content.mimeType === "string" ? ` ${content.mimeType}` : "";
  const bytes = typeof content.data === "string" ? ` ${Math.ceil(content.data.length * 3 / 4)} bytes` : "";
  return `[image${mime}${bytes}]`;
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
