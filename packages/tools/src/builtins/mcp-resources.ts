import type { ChiliToolDefinition, ChiliToolExecutionContext, ToolRegistryContext, ValidationResult } from "../types.js";

export interface McpResourcesListInput {
  serverName?: string;
}

export interface McpResourceReadInput {
  serverName: string;
  uri: string;
  /** Prepared by the host; model-provided values are never accepted. */
  resourceIdentity?: string;
  revision?: string;
}

export interface McpResourceSummary {
  serverName: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceReadResult {
  serverName: string;
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpToolControllerContext {
  sessionId: ChiliToolExecutionContext["sessionId"];
  turnId: ChiliToolExecutionContext["turnId"];
  callId: ChiliToolExecutionContext["callId"];
  cwd: string;
  signal: AbortSignal;
  assertCurrentAuthorization?: ChiliToolExecutionContext["assertCurrentAuthorization"];
}

export interface McpResourcesController {
  prepareRead?(input: McpResourceReadInput, context: ToolRegistryContext): Promise<{ resourceIdentity: string; revision: string }>;
  listResources(input: McpResourcesListInput, context: McpToolControllerContext): Promise<readonly McpResourceSummary[]> | readonly McpResourceSummary[];
  readResource(input: McpResourceReadInput, context: McpToolControllerContext): Promise<McpResourceReadResult> | McpResourceReadResult;
}

export function createMcpResourcesListTool(controller: McpResourcesController): ChiliToolDefinition<McpResourcesListInput> {
  return {
    name: "mcp_resources_list",
    searchHint: "List resources exposed by connected MCP servers.",
    description: "List MCP resources available through the configured MCP manager.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      properties: {
        serverName: { type: "string" },
      },
    },
    validate(input): ValidationResult<McpResourcesListInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const serverName = optionalString(input.serverName);
      const value: McpResourcesListInput = {};
      if (serverName !== undefined) value.serverName = serverName;
      return { ok: true, value };
    },
    resources: () => false,
    async execute(input, context) {
      const resources = await controller.listResources(input, mcpControllerContext(context));
      return {
        title: input.serverName ? `MCP resources: ${input.serverName}` : "MCP resources",
        output: formatResourceList(resources),
        structuredData: resources,
        metadata: {
          count: resources.length,
          serverName: input.serverName,
        },
      };
    },
  };
}

export function createMcpResourceReadTool(controller: McpResourcesController): ChiliToolDefinition<McpResourceReadInput> {
  return {
    name: "mcp_resource_read",
    aliases: ["mcp_resources_read"],
    searchHint: "Read a resource exposed by an MCP server.",
    description: "Read one MCP resource through the configured MCP manager.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      required: ["serverName", "uri"],
      properties: {
        serverName: { type: "string" },
        uri: { type: "string" },
      },
    },
    async validate(input, context): Promise<ValidationResult<McpResourceReadInput>> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const serverName = requiredString(input.serverName, "serverName");
      if (typeof serverName !== "string") return serverName;
      const uri = requiredString(input.uri, "uri");
      if (typeof uri !== "string") return uri;
      if (controller.prepareRead && !context) return { ok: false, message: "MCP resource preparation requires session context" };
      const prepared = controller.prepareRead && context ? await controller.prepareRead({ serverName, uri }, context) : undefined;
      return { ok: true, value: { serverName, uri, ...prepared } };
    },
    resources(input) {
      return {
        permission: "mcp_resource_read",
        patterns: [`${input.serverName}:${input.uri}`],
        metadata: {
          serverName: input.serverName,
          uri: input.uri,
          ...(input.resourceIdentity ? { resourceIdentity: input.resourceIdentity } : {}),
        },
      };
    },
    async execute(input, context) {
      const resource = await controller.readResource(input, mcpControllerContext(context));
      const output = formatResourceRead(resource);
      return {
        title: `${resource.serverName}:${resource.uri}`,
        output,
        structuredData: resource,
        metadata: {
          serverName: resource.serverName,
          uri: resource.uri,
          mimeType: resource.mimeType,
          bytes: Buffer.byteLength(output, "utf8"),
        },
      };
    },
  };
}

function mcpControllerContext(context: ChiliToolExecutionContext): McpToolControllerContext {
  const controllerContext: McpToolControllerContext = {
    sessionId: context.sessionId,
    turnId: context.turnId,
    callId: context.callId,
    cwd: context.cwd,
    signal: context.signal,
    ...(context.assertCurrentAuthorization ? { assertCurrentAuthorization: context.assertCurrentAuthorization } : {}),
  };
  return controllerContext;
}

function formatResourceList(resources: readonly McpResourceSummary[]): string {
  if (resources.length === 0) return "No MCP resources available.";
  return resources
    .map((resource) => {
      const label = resource.name ? `${resource.name} (${resource.uri})` : resource.uri;
      const type = resource.mimeType ? ` [${resource.mimeType}]` : "";
      const description = resource.description ? ` - ${resource.description}` : "";
      return `- ${resource.serverName}: ${label}${type}${description}`;
    })
    .join("\n");
}

function formatResourceRead(resource: McpResourceReadResult): string {
  if (resource.text !== undefined) return resource.text;
  if (resource.blob !== undefined) return resource.blob;
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requiredString(value: unknown, field: string): string | ValidationResult<never> {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, message: `${field} must be a non-empty string` };
  }
  return value;
}
