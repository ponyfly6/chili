import { commandsOf, collectCommandCandidates, parseCommandInput } from "./resolve.js";
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
  const inputTokens = parsed.tokens.map((token) => token.normalized);
  const generic = collectCommandCandidates(roots)
    .filter((candidate) => options.includeHidden || !candidate.command.hidden)
    .filter((candidate) => matchesCandidate(candidate.invocationTokens, inputTokens, parsed.hasTrailingSpace))
    .map((candidate) => completionFor(candidate.command, candidate.value));
  const custom = roots.flatMap((command) =>
    command.hidden && !options.includeHidden ? [] : command.complete(ctx, parsed.body),
  );

  return uniqueCompletions([...custom, ...generic]).slice(0, options.limit ?? 20);
}

function matchesCandidate(
  invocationTokens: readonly string[],
  inputTokens: readonly string[],
  hasTrailingSpace: boolean,
): boolean {
  if (inputTokens.length === 0) return true;
  if (inputTokens.length > invocationTokens.length) return false;
  if (hasTrailingSpace && inputTokens.length >= invocationTokens.length) return false;
  for (let index = 0; index < inputTokens.length; index += 1) {
    const input = inputTokens[index];
    const candidate = invocationTokens[index];
    if (!input || !candidate) return false;
    if (index === inputTokens.length - 1) {
      if (!candidate.startsWith(input)) return false;
    } else if (candidate !== input) {
      return false;
    }
  }
  return true;
}

function completionFor(command: CommandDefinition, value: string): CommandCompletion {
  return {
    value,
    label: `${value}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
    description: command.description,
    category: command.category,
    source: command.source,
    argumentHint: command.argumentHint,
    hidden: command.hidden,
  };
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
