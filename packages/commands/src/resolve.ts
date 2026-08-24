import { CommandRegistry } from "./registry.js";
import { createCommandRunInput } from "./template.js";
import type { CommandDefinition, CommandRunInput } from "./types.js";

export type ResolveCommandResult<TContext, TResult> =
  | {
      status: "matched";
      command: CommandDefinition<TContext, TResult>;
      args: CommandRunInput;
      path: string;
      invocation: string;
    }
  | {
      status: "incomplete";
      command: CommandDefinition<TContext, TResult>;
      path: string;
      reason: "children_required" | "arguments_required";
      usage: string;
      children: readonly string[];
    }
  | {
      status: "disabled";
      command: CommandDefinition<TContext, TResult>;
      path: string;
      reason: string;
    }
  | {
      status: "unknown";
      input: string;
      token: string;
      suggestions: readonly string[];
    }
  | {
      status: "not_command";
      input: string;
    };

export interface ParsedCommandInput {
  body: string;
  tokens: readonly ParsedCommandToken[];
  hasTrailingSpace: boolean;
}

export interface ParsedCommandToken {
  value: string;
  normalized: string;
  start: number;
  end: number;
}

export function resolveCommand<TContext, TResult>(
  commands: CommandRegistry<TContext, TResult> | readonly CommandDefinition<TContext, TResult>[],
  context: TContext,
  input: string,
): ResolveCommandResult<TContext, TResult> {
  if (!input.trimStart().startsWith("/")) return { status: "not_command", input };

  const roots = commandsOf(commands, true);
  const parsed = parseCommandInput(input);
  if (parsed.tokens.length === 0) {
    return {
      status: "unknown",
      input,
      token: "",
      suggestions: roots.filter((command) => !command.hidden).map((command) => command.path),
    };
  }

  const first = parsed.tokens[0];
  const root = roots.find((command) => command.name === first?.normalized);
  if (!root) {
    if (looksLikeAbsolutePath(input)) return { status: "not_command", input };
    return unknownResult(input, first?.value ?? "", roots);
  }

  let command = root;
  let consumed = 1;
  while (consumed < parsed.tokens.length && command.children.length > 0) {
    const token = parsed.tokens[consumed];
    const child = command.children.find((candidate) => candidate.name === token?.normalized);
    if (!child) {
      return unknownResult(input, token?.value ?? "", command.children);
    }
    command = child;
    consumed += 1;
  }

  const raw = rawArgsAfter(parsed, consumed);
  if (raw && command.argumentMode === "none") {
    return unknownResult(input, parsed.tokens[consumed]?.value ?? raw, command.children);
  }

  if (!raw && command.argumentMode === "required") {
    return incompleteResult(command, "arguments_required");
  }

  if (!raw && command.children.length > 0 && command.run === undefined) {
    return incompleteResult(command, "children_required");
  }

  const availability = command.available?.(context) ?? { enabled: true };
  if (!availability.enabled) {
    return {
      status: "disabled",
      command,
      path: command.path,
      reason: availability.reason ?? "Command is unavailable.",
    };
  }

  return {
    status: "matched",
    command,
    args: createCommandRunInput(input, raw, command.path),
    path: command.path,
    invocation: command.path,
  };
}

export function parseCommandInput(input: string): ParsedCommandInput {
  const trimmed = input.trimStart();
  const body = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const tokens: ParsedCommandToken[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const value = match[0] ?? "";
    tokens.push({
      value,
      normalized: value.toLowerCase(),
      start: match.index,
      end: match.index + value.length,
    });
  }
  return {
    body,
    tokens,
    hasTrailingSpace: body.length > 0 && /\s$/.test(body),
  };
}

export function commandsOf<TContext, TResult>(
  commands: CommandRegistry<TContext, TResult> | readonly CommandDefinition<TContext, TResult>[],
  includeHidden = false,
): readonly CommandDefinition<TContext, TResult>[] {
  const roots = commands instanceof CommandRegistry ? commands.roots() : commands;
  return includeHidden ? roots : visibleCommands(roots);
}

export function collectCommandNodes<TContext, TResult>(
  commands: readonly CommandDefinition<TContext, TResult>[],
): CommandDefinition<TContext, TResult>[] {
  return commands.flatMap((command) => [command, ...collectCommandNodes(command.children)]);
}

export function looksLikeAbsolutePath(input: string): boolean {
  const trimmed = input.trimStart();
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (!trimmed.startsWith("/")) return false;
  const token = trimmed.split(/\s+/, 1)[0] ?? "";
  if (token.startsWith("//") || token.slice(1).includes("/")) return true;
  return /^\/(?:Applications|Library|System|Users|Volumes|dev|etc|home|opt|private|tmp|usr|var)$/i.test(token);
}

function incompleteResult<TContext, TResult>(
  command: CommandDefinition<TContext, TResult>,
  reason: "children_required" | "arguments_required",
): Extract<ResolveCommandResult<TContext, TResult>, { status: "incomplete" }> {
  return {
    status: "incomplete",
    command,
    path: command.path,
    reason,
    usage: `${command.path}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
    children: command.children.filter((child) => !child.hidden).map((child) => child.path),
  };
}

function unknownResult<TContext, TResult>(
  input: string,
  token: string,
  commands: readonly CommandDefinition<TContext, TResult>[],
): Extract<ResolveCommandResult<TContext, TResult>, { status: "unknown" }> {
  return {
    status: "unknown",
    input,
    token,
    suggestions: strongestSuggestions(token, commands),
  };
}

function strongestSuggestions<TContext, TResult>(
  token: string,
  commands: readonly CommandDefinition<TContext, TResult>[],
): string[] {
  const query = token.toLowerCase();
  const ranked = commands
    .filter((command) => !command.hidden)
    .map((command, index) => ({ command, index, rank: suggestionRank(command.name, query) }))
    .filter((candidate): candidate is typeof candidate & { rank: number } => candidate.rank !== undefined)
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
  const best = ranked[0]?.rank;
  return ranked.filter((candidate) => candidate.rank === best).slice(0, 5).map((candidate) => candidate.command.path);
}

function suggestionRank(value: string, query: string): number | undefined {
  if (!query) return 0;
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  const distance = levenshtein(value, query);
  return distance <= Math.max(2, Math.floor(value.length / 3)) ? 2 + distance : undefined;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function rawArgsAfter(parsed: ParsedCommandInput, tokenCount: number): string {
  const token = parsed.tokens[tokenCount - 1];
  if (!token) return "";
  return parsed.body.slice(token.end).trimStart();
}

function visibleCommands<TContext, TResult>(
  commands: readonly CommandDefinition<TContext, TResult>[],
): CommandDefinition<TContext, TResult>[] {
  return commands
    .filter((command) => !command.hidden)
    .map((command) => ({ ...command, children: visibleCommands(command.children) }));
}
