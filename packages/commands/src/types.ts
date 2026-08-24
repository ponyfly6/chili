import type {
  RuntimeCommandArgumentMode,
  RuntimeCommandConcurrency,
  RuntimeCommandExecutionTarget,
  RuntimeCommandNode,
  RuntimeCommandSelectionMode,
  RuntimeCommandSource,
} from "@chili/protocol";

export interface CommandContext {
  cwd?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface CommandAvailability {
  enabled: boolean;
  reason?: string;
}

export interface CommandRunInput {
  raw: string;
  argv: readonly string[];
  invocation: string;
  input: string;
}

export interface CommandCompletionInput {
  raw: string;
  query: string;
  argv: readonly string[];
  invocation: string;
}

export interface PromptCommandMetadata {
  readonly [key: string]: unknown;
  commandId: string;
  commandPath: string;
  source: RuntimeCommandSource;
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

export interface CommandSuggestion {
  id: string;
  value: string;
  label: string;
  description: string;
  group: string;
  source: RuntimeCommandSource;
  argumentHint: string;
  hidden: boolean;
  enabled: boolean;
  disabledReason?: string;
  intent: RuntimeCommandSelectionMode;
}

export interface CommandDefinition<TContext = CommandContext, TResult = CommandRunResult>
  extends Omit<RuntimeCommandNode, "children" | "enabled" | "disabledReason"> {
  children: readonly CommandDefinition<TContext, TResult>[];
  origin?: string;
  available?: (context: TContext) => CommandAvailability;
  complete?: (
    context: TContext,
    input: CommandCompletionInput,
  ) => readonly CommandSuggestion[] | Promise<readonly CommandSuggestion[]>;
  run?: (context: TContext, input: CommandRunInput) => TResult | Promise<TResult>;
  metadata?: PromptCommandMetadata | Readonly<Record<string, unknown>>;
}

export interface CommandDefinitionInput<TContext = CommandContext, TResult = CommandRunResult> {
  id: string;
  name: string;
  title: string;
  description: string;
  group: string;
  source: RuntimeCommandSource;
  argumentMode?: RuntimeCommandArgumentMode;
  argumentHint?: string;
  selectionMode?: RuntimeCommandSelectionMode;
  concurrency?: RuntimeCommandConcurrency;
  hidden?: boolean;
  executionTarget: RuntimeCommandExecutionTarget;
  children?: readonly CommandDefinitionInput<TContext, TResult>[];
  origin?: string;
  available?: (context: TContext) => CommandAvailability;
  complete?: (
    context: TContext,
    input: CommandCompletionInput,
  ) => readonly CommandSuggestion[] | Promise<readonly CommandSuggestion[]>;
  run?: (context: TContext, input: CommandRunInput) => TResult | Promise<TResult>;
  metadata?: PromptCommandMetadata | Readonly<Record<string, unknown>>;
}

export type CommandSource = RuntimeCommandSource;
export type CommandArgumentMode = RuntimeCommandArgumentMode;
