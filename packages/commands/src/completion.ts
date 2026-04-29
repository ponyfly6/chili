import { commandNames, splitCommandName } from "./registry.js";
import { collectCommandCandidates, commandsOf, parseCommandInput } from "./resolve.js";
import type { CommandContext, CommandDefinition, CommandCompletion } from "./types.js";
import type { CommandRegistry } from "./registry.js";

export interface CommandCompletionOptions {
  includeHidden?: boolean;
  limit?: number;
}

export function completeCommands(
  commands: CommandRegistry | readonly CommandDefinition[],
  ctx: CommandContext,
  input: string,
  options: CommandCompletionOptions = {},
): CommandCompletion[] {
  const roots = commandsOf(commands, options.includeHidden ?? false);
  const parsed = parseCommandInput(input);
  const tokens = parsed.tokens.map((token) => token.normalized);
  const currentPrefix = parsed.hasTrailingSpace ? "" : (tokens.at(-1) ?? "");
  const parentTokens = parsed.hasTrailingSpace ? tokens : tokens.slice(0, -1);

  const parent = findParentCommand(roots, parentTokens);
  const generic = parent
    ? completeChildren(parent.command.subCommands, parent.path, currentPrefix, options)
    : completeChildren(roots, [], currentPrefix, options);

  const custom = roots.flatMap((command) => (command.hidden && !options.includeHidden ? [] : command.complete(ctx, parsed.body)));

  return uniqueCompletions([...custom, ...generic]).slice(0, options.limit ?? 20);
}

function findParentCommand(
  commands: readonly CommandDefinition[],
  parentTokens: readonly string[],
): { command: CommandDefinition; path: readonly string[] } | undefined {
  if (parentTokens.length === 0) return undefined;

  const candidates = collectCommandCandidates(commands)
    .filter((candidate) => candidate.invocationTokens.length === parentTokens.length)
    .filter((candidate) => candidate.invocationTokens.every((token, index) => token === parentTokens[index]));

  return candidates[0] ? { command: candidates[0].command, path: candidates[0].path } : undefined;
}

function completeChildren(
  commands: readonly CommandDefinition[],
  parentPath: readonly string[],
  prefix: string,
  options: CommandCompletionOptions,
): CommandCompletion[] {
  return commands
    .filter((command) => options.includeHidden || !command.hidden)
    .filter((command) => commandNames(command).some((name) => matchesPrefix(name, prefix)))
    .map((command) => {
      const path = [...parentPath, ...splitCommandName(command.name)];
      const value = `/${path.join(" ")}`;
      return {
        value,
        label: `${value}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
        description: command.description,
        category: command.category,
        source: command.source,
        type: command.type,
        argumentHint: command.argumentHint,
        hidden: command.hidden,
      };
    });
}

function matchesPrefix(name: string, prefix: string): boolean {
  if (prefix.length === 0) return true;
  return splitCommandName(name).join(" ").startsWith(prefix);
}

function uniqueCompletions(completions: readonly CommandCompletion[]): CommandCompletion[] {
  const seen = new Set<string>();
  const output: CommandCompletion[] = [];
  for (const completion of completions) {
    if (seen.has(completion.value)) continue;
    seen.add(completion.value);
    output.push(completion);
  }
  return output;
}

