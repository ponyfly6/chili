export type CommandSource = "project" | "user" | "mcp" | "builtin";

export type CommandArgumentMode = "none" | "optional" | "required" | "variadic";

export interface CommandContext {
  cwd?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface CommandRunInput {
  raw: string;
  argv: readonly string[];
  invocation: string;
  input: string;
}

export interface PromptCommandMetadata {
  commandName: string;
  source: CommandSource;
  filePath?: string;
  model?: string;
  allowedTools?: readonly string[];
  writeScope?: readonly string[];
  executeScope?: readonly string[];
  subtask?: boolean | string;
}

export interface CommandRunResult {
  type: "prompt";
  prompt: string;
  metadata: PromptCommandMetadata;
}

export interface CommandCompletion {
  value: string;
  label: string;
  description: string;
  category: string;
  source: CommandSource;
  argumentHint: string;
  hidden: boolean;
}

export interface CommandDefinition {
  name: string;
  aliases: readonly string[];
  category: string;
  description: string;
  argumentHint: string;
  source: CommandSource;
  hidden: boolean;
  argumentMode: CommandArgumentMode;
  supportsNonInteractive: boolean;
  isSafeConcurrent: boolean;
  isEnabled: (ctx: CommandContext) => boolean;
  subCommands: readonly CommandDefinition[];
  complete: (ctx: CommandContext, input: string) => readonly CommandCompletion[];
  run: (ctx: CommandContext, args: CommandRunInput) => CommandRunResult | Promise<CommandRunResult>;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface CommandDefinitionInput {
  name: string;
  category: string;
  description: string;
  source: CommandSource;
  aliases?: readonly string[];
  argumentHint?: string;
  hidden?: boolean;
  argumentMode?: CommandArgumentMode;
  supportsNonInteractive?: boolean;
  isSafeConcurrent?: boolean;
  isEnabled?: (ctx: CommandContext) => boolean;
  subCommands?: readonly CommandDefinitionInput[];
  complete?: (ctx: CommandContext, input: string) => readonly CommandCompletion[];
  run?: (ctx: CommandContext, args: CommandRunInput) => CommandRunResult | Promise<CommandRunResult>;
  metadata?: Readonly<Record<string, unknown>>;
}
