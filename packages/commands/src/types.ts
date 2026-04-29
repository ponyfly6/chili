export type CommandSource = "builtin" | "project" | "user" | "plugin" | "mcp";

export type CommandType = "local" | "action" | "prompt";

export type CommandArgumentMode = "none" | "optional" | "required" | "variadic";

export type CommandExecutionMode = "interactive" | "non_interactive";

export type CommandOutputFormat = "text" | "markdown" | "json";

export interface CommandContext {
  cwd?: string;
  mode?: CommandExecutionMode;
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
  subtask?: boolean | string;
}

export type CommandRunResult =
  | {
      type: "local";
      content: string;
      format: CommandOutputFormat;
      data?: unknown;
    }
  | {
      type: "action";
      action: string;
      stub: boolean;
      message: string;
      payload?: unknown;
    }
  | {
      type: "prompt";
      prompt: string;
      metadata: PromptCommandMetadata;
    }
  | {
      type: "stub";
      command: string;
      intendedType: CommandType;
      message: string;
    };

export interface CommandCompletion {
  value: string;
  label: string;
  description: string;
  category: string;
  source: CommandSource;
  type: CommandType;
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
  type: CommandType;
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
  type: CommandType;
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
