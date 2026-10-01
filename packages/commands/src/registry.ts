import type { RuntimeCommandCatalog, RuntimeCommandDiagnostic, RuntimeCommandNode } from "@chili/protocol";
import type {
  CommandContext,
  CommandDefinition,
  CommandDefinitionInput,
  CommandRunResult,
} from "./types.js";

export type RegisterCommandResult<TContext, TResult> =
  | { status: "registered"; command: CommandDefinition<TContext, TResult> }
  | { status: "rejected"; command: CommandDefinition<TContext, TResult>; diagnostic: RuntimeCommandDiagnostic };

export class CommandRegistry<TContext = CommandContext, TResult = CommandRunResult> {
  readonly #roots: CommandDefinition<TContext, TResult>[] = [];
  readonly #diagnostics: RuntimeCommandDiagnostic[] = [];

  constructor(commands: readonly CommandDefinition<TContext, TResult>[] = []) {
    this.registerMany(commands);
  }

  register(command: CommandDefinition<TContext, TResult>): RegisterCommandResult<TContext, TResult> {
    const existing = this.#roots.find((candidate) => candidate.name === command.name);
    if (existing) {
      const diagnostic = duplicateDiagnostic(`/${command.name}`, existing, command);
      this.#diagnostics.push(diagnostic);
      return { status: "rejected", command, diagnostic };
    }

    const materialized = materializeCommand(command, [], this.#diagnostics);
    this.#roots.push(materialized);
    return { status: "registered", command: materialized };
  }

  registerMany(
    commands: readonly CommandDefinition<TContext, TResult>[],
  ): RegisterCommandResult<TContext, TResult>[] {
    return commands.map((command) => this.register(command));
  }

  roots(): readonly CommandDefinition<TContext, TResult>[] {
    return [...this.#roots];
  }

  visibleRoots(): readonly CommandDefinition<TContext, TResult>[] {
    return this.#roots
      .filter((command) => !command.hidden)
      .map((command) => visibleCommand(command));
  }

  diagnostics(): readonly RuntimeCommandDiagnostic[] {
    return this.#diagnostics.map((diagnostic) => cloneDiagnostic(diagnostic));
  }

  findById(id: string): CommandDefinition<TContext, TResult> | undefined {
    return findCommand(this.#roots, (command) => command.id === id);
  }

  findByPath(path: string): CommandDefinition<TContext, TResult> | undefined {
    return findCommand(this.#roots, (command) => command.path === path);
  }
}

export function createCommandRegistry<TContext = CommandContext, TResult = CommandRunResult>(
  commands: readonly CommandDefinition<TContext, TResult>[] = [],
): CommandRegistry<TContext, TResult> {
  return new CommandRegistry(commands);
}

export function defineCommand<TContext = CommandContext, TResult = CommandRunResult>(
  input: CommandDefinitionInput<TContext, TResult>,
): CommandDefinition<TContext, TResult> {
  const name = normalizeCommandName(input.name);
  if (!name || name.includes(" ")) {
    throw new Error(`Command node names must be one non-empty token: ${JSON.stringify(input.name)}`);
  }

  const command: CommandDefinition<TContext, TResult> = {
    id: input.id,
    name,
    path: `/${name}`,
    title: input.title,
    description: input.description,
    group: input.group,
    source: input.source,
    argumentMode: input.argumentMode ?? "none",
    argumentHint: input.argumentHint ?? "",
    selectionMode: input.selectionMode ?? ((input.children?.length ?? 0) > 0 ? "drilldown" : "execute"),
    concurrency: input.concurrency ?? "allow",
    hidden: input.hidden ?? false,
    executionTarget: input.executionTarget,
    children: (input.children ?? []).map((child) => defineCommand(child)),
  };

  if (input.origin !== undefined) command.origin = input.origin;
  if (input.available !== undefined) command.available = input.available;
  if (input.complete !== undefined) command.complete = input.complete;
  if (input.run !== undefined) command.run = input.run;
  if (input.metadata !== undefined) command.metadata = input.metadata;
  return command;
}

export function serializeCommandCatalog<TContext, TResult>(
  registry: CommandRegistry<TContext, TResult>,
  context: TContext,
): RuntimeCommandCatalog {
  return {
    roots: registry.roots().map((command) => serializeCommand(command, context)),
    diagnostics: registry.diagnostics().map((diagnostic) => cloneDiagnostic(diagnostic)),
  };
}

export function normalizeCommandName(value: string): string {
  return value.replace(/^\/+/, "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function splitCommandName(value: string): string[] {
  const normalized = normalizeCommandName(value);
  return normalized ? normalized.split(" ") : [];
}

function materializeCommand<TContext, TResult>(
  command: CommandDefinition<TContext, TResult>,
  parentSegments: readonly string[],
  diagnostics: RuntimeCommandDiagnostic[],
): CommandDefinition<TContext, TResult> {
  const pathSegments = [...parentSegments, command.name];
  const path = `/${pathSegments.join(" ")}`;
  const children: CommandDefinition<TContext, TResult>[] = [];
  const siblings = new Map<string, CommandDefinition<TContext, TResult>>();

  for (const child of command.children) {
    const existing = siblings.get(child.name);
    if (existing) {
      diagnostics.push(duplicateDiagnostic(`${path} ${child.name}`, existing, child));
      continue;
    }
    const materialized = materializeCommand(child, pathSegments, diagnostics);
    siblings.set(child.name, materialized);
    children.push(materialized);
  }

  return { ...command, path, children };
}

function duplicateDiagnostic<TContext, TResult>(
  path: string,
  existing: CommandDefinition<TContext, TResult>,
  rejected: CommandDefinition<TContext, TResult>,
): RuntimeCommandDiagnostic {
  const diagnostic: RuntimeCommandDiagnostic = {
    level: "error",
    code: "duplicate_command_path",
    message: `Rejected ${rejected.id} because ${path} is already owned by ${existing.id}.`,
    path,
    commandIds: [existing.id, rejected.id],
  };
  const origins = [existing.origin, rejected.origin].filter((origin): origin is string => Boolean(origin));
  if (origins.length > 0) diagnostic.origins = origins;
  return diagnostic;
}

function visibleCommand<TContext, TResult>(
  command: CommandDefinition<TContext, TResult>,
): CommandDefinition<TContext, TResult> {
  return {
    ...command,
    children: command.children.filter((child) => !child.hidden).map((child) => visibleCommand(child)),
  };
}

function findCommand<TContext, TResult>(
  commands: readonly CommandDefinition<TContext, TResult>[],
  predicate: (command: CommandDefinition<TContext, TResult>) => boolean,
): CommandDefinition<TContext, TResult> | undefined {
  for (const command of commands) {
    if (predicate(command)) return command;
    const child = findCommand(command.children, predicate);
    if (child) return child;
  }
  return undefined;
}

function serializeCommand<TContext, TResult>(
  command: CommandDefinition<TContext, TResult>,
  context: TContext,
): RuntimeCommandNode {
  const availability = command.available?.(context) ?? { enabled: true };
  const node: RuntimeCommandNode = {
    id: command.id,
    name: command.name,
    path: command.path,
    title: command.title,
    description: command.description,
    group: command.group,
    source: command.source,
    argumentMode: command.argumentMode,
    argumentHint: command.argumentHint,
    selectionMode: command.selectionMode,
    concurrency: command.concurrency,
    hidden: command.hidden,
    enabled: availability.enabled,
    executionTarget: command.executionTarget,
    children: command.children.map((child) => serializeCommand(child, context)),
  };
  if (!availability.enabled && availability.reason !== undefined) {
    node.disabledReason = availability.reason;
  }
  return node;
}

function cloneDiagnostic(diagnostic: RuntimeCommandDiagnostic): RuntimeCommandDiagnostic {
  return {
    ...diagnostic,
    ...(diagnostic.commandIds ? { commandIds: [...diagnostic.commandIds] } : {}),
    ...(diagnostic.origins ? { origins: [...diagnostic.origins] } : {}),
  };
}
