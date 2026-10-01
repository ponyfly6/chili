import type { RuntimeCommandSelectionMode } from "@chili/protocol";
import type { CommandRegistry } from "./registry.js";
import { collectCommandNodes, commandsOf, parseCommandInput } from "./resolve.js";
import { splitCommandArguments } from "./template.js";
import type { CommandDefinition, CommandSuggestion } from "./types.js";

export interface CommandMenuOptions {
  scope?: "contextual" | "global";
  includeHidden?: boolean;
  limit?: number;
}

export interface CommandMenuGroup {
  id: string;
  items: readonly CommandSuggestion[];
}

export interface CommandMenuModel {
  query: string;
  items: readonly CommandSuggestion[];
  groups: readonly CommandMenuGroup[];
  total: number;
}

export async function completeCommands<TContext, TResult>(
  commands: CommandRegistry<TContext, TResult> | readonly CommandDefinition<TContext, TResult>[],
  context: TContext,
  input: string,
  options: CommandMenuOptions = {},
): Promise<CommandSuggestion[]> {
  const roots = commandsOf(commands, options.includeHidden ?? false);
  const items = options.scope === "global"
    ? globalSuggestions(roots, context, input)
    : contextualSuggestions(roots, context, input);
  return (await items).slice(0, options.limit ?? 64);
}

/**
 * Synchronous projection of the shared command menu for renderers whose input
 * loop cannot await completion providers. Static nodes and synchronous
 * argument providers keep identical ranking semantics; async providers are
 * omitted until an async client refreshes them.
 */
export function completeCommandsSync<TContext, TResult>(
  commands: CommandRegistry<TContext, TResult> | readonly CommandDefinition<TContext, TResult>[],
  context: TContext,
  input: string,
  options: CommandMenuOptions = {},
): CommandSuggestion[] {
  const roots = commandsOf(commands, options.includeHidden ?? false);
  const items = options.scope === "global"
    ? globalSuggestions(roots, context, input)
    : contextualSuggestionsSync(roots, context, input);
  return items.slice(0, options.limit ?? 64);
}

export async function commandMenuModel<TContext, TResult>(
  commands: CommandRegistry<TContext, TResult> | readonly CommandDefinition<TContext, TResult>[],
  context: TContext,
  input: string,
  options: CommandMenuOptions = {},
): Promise<CommandMenuModel> {
  const items = await completeCommands(commands, context, input, options);
  const groups: CommandMenuGroup[] = [];
  const byGroup = new Map<string, CommandSuggestion[]>();
  for (const item of items) {
    let group = byGroup.get(item.group);
    if (!group) {
      group = [];
      byGroup.set(item.group, group);
      groups.push({ id: item.group, items: group });
    }
    group.push(item);
  }
  return { query: input, items, groups, total: items.length };
}

async function contextualSuggestions<TContext, TResult>(
  roots: readonly CommandDefinition<TContext, TResult>[],
  context: TContext,
  input: string,
): Promise<CommandSuggestion[]> {
  const parsed = parseCommandInput(input);
  if (parsed.tokens.length === 0) return staticSuggestions(roots, context, "");

  if (parsed.hasTrailingSpace) {
    const exact = traverseExact(roots, parsed.tokens.map((token) => token.normalized));
    if (!exact) return [];
    if (exact.children.length > 0) return staticSuggestions(exact.children, context, "");
    return dynamicSuggestions(exact, context, parsed.body.slice(parsed.tokens[parsed.tokens.length - 1]?.end ?? 0));
  }

  const tokens = parsed.tokens.map((token) => token.normalized);
  const query = tokens[tokens.length - 1] ?? "";
  const parentTokens = tokens.slice(0, -1);
  if (parentTokens.length === 0) return staticSuggestions(roots, context, query);

  const parent = traverseExact(roots, parentTokens);
  if (!parent) return [];
  if (parent.children.length > 0) return staticSuggestions(parent.children, context, query);
  if (!parent.complete) return [];
  const firstArgument = parsed.tokens[parentTokens.length];
  const raw = firstArgument ? parsed.body.slice(firstArgument.start) : "";
  return dynamicSuggestions(parent, context, raw);
}

function contextualSuggestionsSync<TContext, TResult>(
  roots: readonly CommandDefinition<TContext, TResult>[],
  context: TContext,
  input: string,
): CommandSuggestion[] {
  const parsed = parseCommandInput(input);
  if (parsed.tokens.length === 0) return staticSuggestions(roots, context, "");

  if (parsed.hasTrailingSpace) {
    const exact = traverseExact(roots, parsed.tokens.map((token) => token.normalized));
    if (!exact) return [];
    if (exact.children.length > 0) return staticSuggestions(exact.children, context, "");
    return dynamicSuggestionsSync(exact, context, parsed.body.slice(parsed.tokens[parsed.tokens.length - 1]?.end ?? 0));
  }

  const tokens = parsed.tokens.map((token) => token.normalized);
  const query = tokens[tokens.length - 1] ?? "";
  const parentTokens = tokens.slice(0, -1);
  if (parentTokens.length === 0) return staticSuggestions(roots, context, query);

  const parent = traverseExact(roots, parentTokens);
  if (!parent) return [];
  if (parent.children.length > 0) return staticSuggestions(parent.children, context, query);
  if (!parent.complete) return [];
  const firstArgument = parsed.tokens[parentTokens.length];
  const raw = firstArgument ? parsed.body.slice(firstArgument.start) : "";
  return dynamicSuggestionsSync(parent, context, raw);
}

function globalSuggestions<TContext, TResult>(
  roots: readonly CommandDefinition<TContext, TResult>[],
  context: TContext,
  input: string,
): CommandSuggestion[] {
  const query = input.trim().replace(/^\//, "").toLowerCase();
  const nodes = collectCommandNodes(roots);
  const ranked = nodes
    .map((command, index) => ({ command, index, rank: globalRank(command, query) }))
    .filter((candidate): candidate is typeof candidate & { rank: number } => candidate.rank !== undefined);
  const strong = ranked.some((candidate) => candidate.rank < 3);
  return ranked
    .filter((candidate) => !strong || candidate.rank < 3)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ command }) => suggestionFor(command, context));
}

function staticSuggestions<TContext, TResult>(
  commands: readonly CommandDefinition<TContext, TResult>[],
  context: TContext,
  query: string,
): CommandSuggestion[] {
  const ranked = commands
    .map((command, index) => ({ command, index, rank: segmentRank(command, query) }))
    .filter((candidate): candidate is typeof candidate & { rank: number } => candidate.rank !== undefined);
  const strong = ranked.some((candidate) => candidate.rank < 3);
  return ranked
    .filter((candidate) => !strong || candidate.rank < 3)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ command }) => suggestionFor(command, context));
}

async function dynamicSuggestions<TContext, TResult>(
  command: CommandDefinition<TContext, TResult>,
  context: TContext,
  raw: string,
): Promise<CommandSuggestion[]> {
  if (!command.complete) return [];
  return [...await command.complete(context, {
    raw,
    query: raw.trimStart(),
    argv: splitCommandArguments(raw),
    invocation: command.path,
  })];
}

function dynamicSuggestionsSync<TContext, TResult>(
  command: CommandDefinition<TContext, TResult>,
  context: TContext,
  raw: string,
): CommandSuggestion[] {
  if (!command.complete) return [];
  const result = command.complete(context, {
    raw,
    query: raw.trimStart(),
    argv: splitCommandArguments(raw),
    invocation: command.path,
  });
  return isPromiseLike(result) ? [] : [...result];
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof value.then === "function";
}

function suggestionFor<TContext, TResult>(
  command: CommandDefinition<TContext, TResult>,
  context: TContext,
): CommandSuggestion {
  const availability = command.available?.(context) ?? { enabled: true };
  const suggestion: CommandSuggestion = {
    id: command.id,
    value: command.path,
    label: `${command.path}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
    description: command.description,
    group: command.group,
    source: command.source,
    argumentHint: command.argumentHint,
    hidden: command.hidden,
    enabled: availability.enabled,
    intent: selectionIntent(command),
  };
  if (!availability.enabled && availability.reason !== undefined) suggestion.disabledReason = availability.reason;
  return suggestion;
}

function selectionIntent<TContext, TResult>(
  command: CommandDefinition<TContext, TResult>,
): RuntimeCommandSelectionMode {
  if (command.children.length > 0 && command.selectionMode === "execute") return "drilldown";
  return command.selectionMode;
}

function traverseExact<TContext, TResult>(
  roots: readonly CommandDefinition<TContext, TResult>[],
  tokens: readonly string[],
): CommandDefinition<TContext, TResult> | undefined {
  let candidates = roots;
  let command: CommandDefinition<TContext, TResult> | undefined;
  for (const token of tokens) {
    command = candidates.find((candidate) => candidate.name === token);
    if (!command) return undefined;
    candidates = command.children;
  }
  return command;
}

function segmentRank<TContext, TResult>(
  command: CommandDefinition<TContext, TResult>,
  query: string,
): number | undefined {
  if (!query) return 0;
  if (command.name === query) return 0;
  if (command.name.startsWith(query)) return 1;
  if (wordPrefix(`${command.title} ${command.description}`, query)) return 2;
  return fuzzyMatch(`${command.name} ${command.title}`.toLowerCase(), query) ? 3 : undefined;
}

function globalRank<TContext, TResult>(
  command: CommandDefinition<TContext, TResult>,
  query: string,
): number | undefined {
  if (!query) return 0;
  const path = command.path.slice(1).toLowerCase();
  if (path === query || command.name === query) return 0;
  if (path.startsWith(query) || command.name.startsWith(query)) return 1;
  const searchable = `${path} ${command.title} ${command.description} ${command.group} ${command.source}`.toLowerCase();
  if (wordPrefix(searchable, query) || searchable.includes(query)) return 2;
  return fuzzyMatch(searchable, query) ? 3 : undefined;
}

function wordPrefix(value: string, query: string): boolean {
  return value.toLowerCase().split(/[^a-z0-9_-]+/).some((word) => word.startsWith(query));
}

function fuzzyMatch(value: string, query: string): boolean {
  let index = 0;
  for (const char of query) {
    index = value.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}
