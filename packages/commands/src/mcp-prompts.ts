import { defineCommand } from "./registry.js";
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

export function createMcpPromptCommand(
  prompt: McpPromptDefinition,
  controller: McpPromptController,
): CommandDefinition {
  const commandName = mcpPromptCommandName(prompt);
  return defineCommand({
    name: commandName,
    category: "mcp",
    description: prompt.description ?? `MCP prompt from ${prompt.serverName}`,
    source: "mcp",
    hidden: prompt.hidden ?? false,
    argumentMode: (prompt.arguments?.length ?? 0) > 0 ? "variadic" : "none",
    argumentHint: mcpPromptArgumentHint(prompt.arguments ?? []),
    metadata: {
      kind: "mcp_prompt",
      serverName: prompt.serverName,
      promptName: prompt.name,
      title: prompt.title,
    },
    run: async (ctx, args) => runMcpPromptCommand(prompt, commandName, controller, ctx, args),
  });
}

export function createMcpPromptCommands(
  prompts: readonly McpPromptDefinition[],
  controller: McpPromptController,
): CommandDefinition[] {
  return prompts.map((prompt) => createMcpPromptCommand(prompt, controller));
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
    if (separator > 0) {
      named.set(token.slice(0, separator), token.slice(separator + 1));
    } else {
      positional.push(token);
    }
  }

  const output: Record<string, string> = {};
  let positionalIndex = 0;
  for (const definition of definitions) {
    const name = definition.name;
    const namedValue = named.get(name);
    const value = namedValue ?? positional[positionalIndex];
    if (namedValue === undefined && value !== undefined) positionalIndex += 1;
    if (value !== undefined) output[name] = value;
    if (definition.required && (value === undefined || value.length === 0)) {
      throw new Error(`Missing required MCP prompt argument: ${name}`);
    }
  }

  for (const [key, value] of named.entries()) {
    if (output[key] === undefined) output[key] = value;
  }

  return output;
}

function mcpPromptArgumentHint(definitions: readonly McpPromptArgumentDefinition[]): string {
  if (definitions.length === 0) return "";
  return definitions
    .map((definition) => definition.required ? `<${definition.name}>` : `[${definition.name}]`)
    .join(" ");
}

async function runMcpPromptCommand(
  prompt: McpPromptDefinition,
  commandName: string,
  controller: McpPromptController,
  ctx: CommandContext,
  args: CommandRunInput,
): Promise<CommandRunResult> {
  const rendered = await controller.renderPrompt({
    serverName: prompt.serverName,
    promptName: prompt.name,
    arguments: parseMcpPromptArguments(args.input, prompt.arguments ?? []),
  }, ctx);

  const metadata: CommandRunResult["metadata"] = {
    commandName,
    source: "mcp",
  };
  const model = stringMetadata(rendered.metadata?.model);
  const allowedTools = stringArrayMetadata(rendered.metadata?.allowedTools);
  if (model !== undefined) metadata.model = model;
  if (allowedTools !== undefined) metadata.allowedTools = allowedTools;

  return {
    type: "prompt",
    prompt: formatMcpPromptResult(rendered),
    metadata,
  };
}

function mcpPromptCommandName(prompt: McpPromptDefinition): string {
  return `${prompt.serverName} ${prompt.name}`;
}

function formatMcpPromptResult(result: McpPromptRenderResult): string {
  const prompt = result.prompt?.trim();
  if (prompt) return prompt;
  return (result.messages ?? [])
    .map((message) => `${message.role.toUpperCase()}: ${messageContentText(message.content)}`)
    .filter((message) => message.trim().length > 0)
    .join("\n\n");
}

function messageContentText(content: McpPromptMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => part.text)
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n");
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArrayMetadata(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}
