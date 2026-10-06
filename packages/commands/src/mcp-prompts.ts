import { createPromptNamespace, createPromptRoot, normalizeCommandSegment } from "./prompt-tree.js";
import { defineCommand } from "./registry.js";
import { commandToolPolicy } from "./policy-metadata.js";
import { splitCommandArguments } from "./template.js";
import type { CommandContext, CommandDefinition, CommandRunInput, CommandRunResult } from "./types.js";

export interface McpPromptArgumentDefinition {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptDefinition {
  serverName: string;
  name: string;
  title?: string;
  description?: string;
  arguments?: readonly McpPromptArgumentDefinition[];
  hidden?: boolean;
}

export interface McpPromptRenderRequest {
  serverName: string;
  promptName: string;
  arguments: Record<string, string>;
}

export interface McpPromptMessage {
  role: string;
  content: string | readonly { type?: string; text?: string }[];
}

export interface McpPromptRenderResult {
  prompt?: string;
  messages?: readonly McpPromptMessage[];
  metadata?: Record<string, unknown>;
}

export interface McpPromptController {
  renderPrompt(request: McpPromptRenderRequest, context: CommandContext): Promise<McpPromptRenderResult> | McpPromptRenderResult;
}

export function createMcpPromptCommands(
  prompts: readonly McpPromptDefinition[],
  controller: McpPromptController,
): CommandDefinition[] {
  const servers = new Map<string, { rawName: string; prompts: McpPromptDefinition[] }>();
  for (const prompt of prompts) {
    const segment = normalizeCommandSegment(prompt.serverName);
    const server = servers.get(segment) ?? { rawName: prompt.serverName, prompts: [] };
    server.prompts.push(prompt);
    servers.set(segment, server);
  }
  if (servers.size === 0) return [];

  const serverNodes = [...servers.entries()].map(([serverSegment, server]) => defineCommand({
    id: `prompt.mcp.${serverSegment}`,
    name: serverSegment,
    title: server.rawName,
    description: `MCP prompts from ${server.rawName}`,
    group: "prompt",
    source: "mcp",
    selectionMode: "drilldown",
    executionTarget: "prompt",
    children: server.prompts.map((prompt) => mcpPromptLeaf(prompt, serverSegment, controller)),
  }));
  return [createPromptRoot([createPromptNamespace("mcp", serverNodes)])];
}

export function parseMcpPromptArguments(
  input: string,
  definitions: readonly McpPromptArgumentDefinition[],
): Record<string, string> {
  const tokens = splitCommandArguments(input);
  const named = new Map<string, string>();
  const positional: string[] = [];
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator > 0) named.set(token.slice(0, separator), token.slice(separator + 1));
    else positional.push(token);
  }

  const output: Record<string, string> = {};
  let positionalIndex = 0;
  for (const definition of definitions) {
    const namedValue = named.get(definition.name);
    const value = namedValue ?? positional[positionalIndex];
    if (namedValue === undefined && value !== undefined) positionalIndex += 1;
    if (value !== undefined) output[definition.name] = value;
    if (definition.required && !value) throw new Error(`Missing required MCP prompt argument: ${definition.name}`);
  }
  for (const [key, value] of named) {
    if (output[key] === undefined) output[key] = value;
  }
  return output;
}

function mcpPromptLeaf(
  prompt: McpPromptDefinition,
  serverSegment: string,
  controller: McpPromptController,
): CommandDefinition {
  const promptSegment = normalizeCommandSegment(prompt.name);
  const commandId = `prompt.mcp.${serverSegment}.${promptSegment}`;
  const commandPath = `/prompt mcp ${serverSegment} ${promptSegment}`;
  const argumentDefinitions = prompt.arguments ?? [];
  return defineCommand({
    id: commandId,
    name: promptSegment,
    title: prompt.title ?? prompt.name,
    description: prompt.description ?? `MCP prompt from ${prompt.serverName}`,
    group: "prompt",
    source: "mcp",
    argumentMode: argumentDefinitions.some((argument) => argument.required)
      ? "required"
      : argumentDefinitions.length > 0 ? "optional" : "none",
    argumentHint: mcpPromptArgumentHint(argumentDefinitions),
    selectionMode: argumentDefinitions.length > 0 ? "complete" : "execute",
    hidden: prompt.hidden ?? false,
    executionTarget: "prompt",
    metadata: { kind: "mcp_prompt", serverName: prompt.serverName, promptName: prompt.name },
    run: (context, args) => runMcpPromptCommand(prompt, commandId, commandPath, controller, context, args),
  });
}

function mcpPromptArgumentHint(definitions: readonly McpPromptArgumentDefinition[]): string {
  return definitions.map((definition) => definition.required ? `<${definition.name}>` : `[${definition.name}]`).join(" ");
}

async function runMcpPromptCommand(
  prompt: McpPromptDefinition,
  commandId: string,
  commandPath: string,
  controller: McpPromptController,
  context: CommandContext,
  args: CommandRunInput,
): Promise<CommandRunResult> {
  const rendered = await controller.renderPrompt({
    serverName: prompt.serverName,
    promptName: prompt.name,
    arguments: parseMcpPromptArguments(args.raw, prompt.arguments ?? []),
  }, context);
  const model = stringMetadata(rendered.metadata?.model);
  const toolPolicy = commandToolPolicy(rendered.metadata ?? {});
  return {
    type: "prompt",
    prompt: formatMcpPromptResult(rendered),
    metadata: {
      commandId,
      commandPath,
      source: "mcp",
      ...(model !== undefined ? { model } : {}),
      ...toolPolicy,
    },
  };
}

function formatMcpPromptResult(result: McpPromptRenderResult): string {
  const prompt = result.prompt?.trim();
  if (prompt) return prompt;
  return (result.messages ?? [])
    .map((message) => `${message.role.toUpperCase()}: ${messageContentText(message.content)}`)
    .filter((message) => message.trim())
    .join("\n\n");
}

function messageContentText(content: McpPromptMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => part.text).filter((text): text is string => Boolean(text)).join("\n");
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
