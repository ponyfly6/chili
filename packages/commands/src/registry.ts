import type {
  CommandArgumentMode,
  CommandCompletion,
  CommandDefinition,
  CommandDefinitionInput,
  CommandRunResult,
  CommandType,
} from "./types.js";

export type RegisterCommandResult =
  | { status: "registered"; command: CommandDefinition }
  | {
      status: "skipped";
      reason: "name_conflict";
      command: CommandDefinition;
      existing: CommandDefinition;
      name: string;
    };

export interface ListCommandsOptions {
  includeHidden?: boolean;
}

export class CommandRegistry {
  readonly #commands: CommandDefinition[] = [];

  constructor(commands: readonly CommandDefinition[] = []) {
    for (const command of commands) {
      this.register(command);
    }
  }

  register(command: CommandDefinition): RegisterCommandResult {
    const conflict = this.#findInvocationConflict(command);
    if (conflict) {
      return {
        status: "skipped",
        reason: "name_conflict",
        command,
        existing: conflict.existing,
        name: conflict.name,
      };
    }

    this.#commands.push(command);
    return { status: "registered", command };
  }

  registerMany(commands: readonly CommandDefinition[]): RegisterCommandResult[] {
    return commands.map((command) => this.register(command));
  }

  list(options: ListCommandsOptions = {}): readonly CommandDefinition[] {
    if (options.includeHidden) return [...this.#commands];
    return this.#commands.filter((command) => !command.hidden);
  }

  all(): readonly CommandDefinition[] {
    return [...this.#commands];
  }

  #findInvocationConflict(command: CommandDefinition): { existing: CommandDefinition; name: string } | undefined {
    const names = new Set(commandInvocations(command));
    for (const existing of this.#commands) {
      for (const name of commandInvocations(existing)) {
        if (names.has(name)) return { existing, name };
      }
    }
    return undefined;
  }
}

export function createCommandRegistry(commands: readonly CommandDefinition[] = []): CommandRegistry {
  return new CommandRegistry(commands);
}

export function defineCommand(input: CommandDefinitionInput): CommandDefinition {
  const name = normalizeCommandName(input.name);
  const type = input.type;
  const command: CommandDefinition = {
    name,
    aliases: (input.aliases ?? []).map((alias) => normalizeCommandName(alias)).filter((alias) => alias.length > 0),
    category: input.category,
    description: input.description,
    argumentHint: input.argumentHint ?? "",
    source: input.source,
    hidden: input.hidden ?? false,
    type,
    argumentMode: input.argumentMode ?? defaultArgumentMode(input),
    supportsNonInteractive: input.supportsNonInteractive ?? defaultSupportsNonInteractive(type),
    isSafeConcurrent: input.isSafeConcurrent ?? defaultSafeConcurrent(type),
    isEnabled: input.isEnabled ?? (() => true),
    subCommands: (input.subCommands ?? []).map((subCommand) => defineCommand(subCommand)),
    complete: input.complete ?? (() => [] satisfies CommandCompletion[]),
    run: input.run ?? (() => stubCommandResult(name, type)),
  };

  if (input.metadata !== undefined) {
    return { ...command, metadata: input.metadata };
  }

  return command;
}

export function normalizeCommandName(value: string): string {
  return value.replace(/^\//, "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function splitCommandName(value: string): string[] {
  const normalized = normalizeCommandName(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

export function commandNames(command: CommandDefinition): string[] {
  return [command.name, ...command.aliases].map((name) => normalizeCommandName(name));
}

export function commandInvocations(command: CommandDefinition): string[] {
  return commandInvocationsInner(command, [""]);
}

export function stubCommandResult(command: string, intendedType: CommandType): CommandRunResult {
  return {
    type: "stub",
    command,
    intendedType,
    message: `/${command} is registered, but host execution is not wired yet.`,
  };
}

function defaultSupportsNonInteractive(type: CommandType): boolean {
  return type === "local" || type === "prompt";
}

function defaultSafeConcurrent(type: CommandType): boolean {
  return type === "local" || type === "prompt";
}

function defaultArgumentMode(input: CommandDefinitionInput): CommandArgumentMode {
  if (input.type === "prompt") return "variadic";
  if ((input.argumentHint ?? "").length > 0) return "variadic";
  return "none";
}

function commandInvocationsInner(command: CommandDefinition, parents: readonly string[]): string[] {
  const own = parents.flatMap((parent) =>
    commandNames(command).map((name) => normalizeCommandName(`${parent} ${name}`)),
  );
  return [...own, ...command.subCommands.flatMap((subCommand) => commandInvocationsInner(subCommand, own))];
}
