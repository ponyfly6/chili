import { CommandRegistry, commandNames, splitCommandName } from "./registry.js";
import { createCommandRunInput } from "./template.js";
import type { CommandDefinition } from "./types.js";

export interface ResolveCommandOptions {
  allowPrefix?: boolean;
  includeHidden?: boolean;
}

export type ResolveCommandResult =
  | {
      status: "matched";
      command: CommandDefinition;
      args: ReturnType<typeof createCommandRunInput>;
      path: readonly string[];
      invocation: string;
      matchType: "exact" | "prefix";
    }
  | {
      status: "ambiguous";
      input: string;
      candidates: readonly CommandCandidate[];
    }
  | {
      status: "unknown";
      input: string;
      normalized: string;
    };

export interface CommandCandidate {
  command: CommandDefinition;
  path: readonly string[];
  invocationTokens: readonly string[];
  value: string;
}

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

export function resolveCommand(
  commands: CommandRegistry | readonly CommandDefinition[],
  input: string,
  options: ResolveCommandOptions = {},
): ResolveCommandResult {
  const parsed = parseCommandInput(input);
  if (parsed.tokens.length === 0) {
    return { status: "unknown", input, normalized: parsed.body };
  }

  const candidates = collectCommandCandidates(commandsOf(commands, options.includeHidden));
  const exact = dedupeCandidates(
    candidates.filter((candidate) => exactCandidateMatch(candidate, parsed.tokens)),
  ).sort((left, right) => right.invocationTokens.length - left.invocationTokens.length);

  if (exact.length > 0) {
    const longest = exact[0]?.invocationTokens.length ?? 0;
    const matches = exact.filter((candidate) => candidate.invocationTokens.length === longest);
    if (matches.length > 1) {
      return { status: "ambiguous", input, candidates: matches };
    }
    const match = matches[0];
    if (!match) return { status: "unknown", input, normalized: parsed.body };
    const raw = rawArgsAfter(parsed, match.invocationTokens.length);
    return {
      status: "matched",
      command: match.command,
      args: createCommandRunInput(input, raw, match.value),
      path: match.path,
      invocation: match.value,
      matchType: "exact",
    };
  }

  if (options.allowPrefix) {
    const prefix = dedupeCandidates(candidates.filter((candidate) => prefixCandidateMatch(candidate, parsed.tokens)));
    if (prefix.length > 1) return { status: "ambiguous", input, candidates: prefix };
    const match = prefix[0];
    if (match) {
      return {
        status: "matched",
        command: match.command,
        args: createCommandRunInput(input, "", match.value),
        path: match.path,
        invocation: match.value,
        matchType: "prefix",
      };
    }
  }

  return { status: "unknown", input, normalized: parsed.body };
}

export function parseCommandInput(input: string): ParsedCommandInput {
  const body = input.trimStart().replace(/^\//, "");
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

export function collectCommandCandidates(commands: readonly CommandDefinition[]): CommandCandidate[] {
  return collectCommandCandidatesInner(commands, [[]], []);
}

export function commandsOf(
  commands: CommandRegistry | readonly CommandDefinition[],
  includeHidden = true,
): readonly CommandDefinition[] {
  if (commands instanceof CommandRegistry) {
    return includeHidden ? commands.all() : commands.list();
  }
  if (includeHidden) return commands;
  return commands.filter((command) => !command.hidden);
}

function collectCommandCandidatesInner(
  commands: readonly CommandDefinition[],
  parentInvocations: readonly (readonly string[])[],
  parentPath: readonly string[],
): CommandCandidate[] {
  const output: CommandCandidate[] = [];

  for (const command of commands) {
    const alternatives = commandNames(command).map((name) => splitCommandName(name)).filter((tokens) => tokens.length > 0);
    const invocations = parentInvocations.flatMap((parent) =>
      alternatives.map((alternative) => [...parent, ...alternative]),
    );
    const path = [...parentPath, ...splitCommandName(command.name)];

    for (const invocationTokens of invocations) {
      output.push({
        command,
        path,
        invocationTokens,
        value: `/${path.join(" ")}`,
      });
    }

    if (command.subCommands.length > 0) {
      output.push(...collectCommandCandidatesInner(command.subCommands, invocations, path));
    }
  }

  return output;
}

function exactCandidateMatch(candidate: CommandCandidate, tokens: readonly ParsedCommandToken[]): boolean {
  if (tokens.length < candidate.invocationTokens.length) return false;
  if (tokens.length > candidate.invocationTokens.length && candidate.command.argumentMode === "none") return false;
  return candidate.invocationTokens.every((token, index) => tokens[index]?.normalized === token);
}

function prefixCandidateMatch(candidate: CommandCandidate, tokens: readonly ParsedCommandToken[]): boolean {
  if (tokens.length > candidate.invocationTokens.length) return false;
  for (let index = 0; index < tokens.length; index += 1) {
    const inputToken = tokens[index];
    const candidateToken = candidate.invocationTokens[index];
    if (!inputToken || !candidateToken) return false;
    if (index === tokens.length - 1) {
      if (!candidateToken.startsWith(inputToken.normalized)) return false;
    } else if (candidateToken !== inputToken.normalized) {
      return false;
    }
  }
  return true;
}

function rawArgsAfter(parsed: ParsedCommandInput, tokenCount: number): string {
  const token = parsed.tokens[tokenCount - 1];
  if (!token) return "";
  return parsed.body.slice(token.end).trimStart();
}

function dedupeCandidates(candidates: readonly CommandCandidate[]): CommandCandidate[] {
  const seen = new Set<string>();
  const commandIds = new Map<CommandDefinition, number>();
  const output: CommandCandidate[] = [];
  for (const candidate of candidates) {
    let commandId = commandIds.get(candidate.command);
    if (commandId === undefined) {
      commandId = commandIds.size;
      commandIds.set(candidate.command, commandId);
    }
    const key = `${commandId}\0${candidate.value}\0${candidate.invocationTokens.join(" ")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
}
