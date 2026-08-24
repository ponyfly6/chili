import path from "node:path";
import {
  builtinPromptCommands,
  createCommandRegistry,
  createCommandRunInput,
  createPromptRoot,
  loadProjectCommands,
  loadUserCommands,
  serializeCommandCatalog,
  type CommandContext,
  type CommandDefinition,
  type CommandRegistry,
  type CommandRunResult,
  type PromptCommandMetadata,
} from "@chili/commands";
import type {
  RuntimeCommandCatalog,
  RuntimeCommandDiagnostic,
  RuntimeCommandInvocation,
  RuntimeCommandNode,
} from "@chili/protocol";

export interface PromptCommandControl {
  list(): Promise<RuntimeCommandCatalog>;
  reload(): Promise<RuntimeCommandCatalog>;
  run(input: RuntimeCommandInvocation): Promise<PromptCommandRunResult>;
}

export interface PromptCommandRunResult {
  prompt: string;
  command: RuntimeCommandNode;
  metadata: PromptCommandMetadata;
}

export interface FilesystemPromptCommandControlOptions {
  cwd: string;
  chiliHome?: string;
}

interface LoadedPromptCommands {
  registry: CommandRegistry<CommandContext, CommandRunResult>;
  snapshot: RuntimeCommandCatalog;
}

export class PromptCommandNotFoundError extends Error {
  constructor(readonly commandId: string) {
    super(`Unknown command ID: ${commandId}`);
    this.name = "PromptCommandNotFoundError";
  }
}

export class PromptCommandUsageError extends Error {
  constructor(
    readonly commandId: string,
    readonly usage: string,
  ) {
    super(`Command ${commandId} requires: ${usage}`);
    this.name = "PromptCommandUsageError";
  }
}

export function createFilesystemPromptCommandControl(
  options: FilesystemPromptCommandControlOptions,
): PromptCommandControl {
  const defaultCwd = path.resolve(options.cwd);
  const cache = new Map<string, Promise<LoadedPromptCommands>>();

  const load = async (cwd: string): Promise<LoadedPromptCommands> => {
    const [project, user] = await Promise.all([
      loadProjectCommands({ cwd }),
      loadUserCommands(options.chiliHome ? { chiliHome: options.chiliHome } : {}),
    ]);
    const root = createPromptRoot([
      ...promptNamespaces(builtinPromptCommands),
      ...promptNamespaces(project.commands),
      ...promptNamespaces(user.commands),
    ]);
    const registry = createCommandRegistry([root]);
    const snapshot = serializeCommandCatalog(registry, { cwd });
    snapshot.diagnostics.push(
      ...project.diagnostics.map(cloneDiagnostic),
      ...user.diagnostics.map(cloneDiagnostic),
    );
    return { registry, snapshot };
  };

  const ensure = (cwd: string): Promise<LoadedPromptCommands> => {
    const cacheKey = path.resolve(cwd);
    const existing = cache.get(cacheKey);
    if (existing) return existing;

    const pending = load(cacheKey);
    cache.set(cacheKey, pending);
    void pending.catch(() => {
      if (cache.get(cacheKey) === pending) cache.delete(cacheKey);
    });
    return pending;
  };

  return {
    async list() {
      return cloneCatalog((await ensure(defaultCwd)).snapshot);
    },
    async reload() {
      cache.clear();
      return cloneCatalog((await ensure(defaultCwd)).snapshot);
    },
    async run(input) {
      const cwd = path.resolve(input.cwd ?? defaultCwd);
      const loaded = await ensure(cwd);
      const command = loaded.registry.findById(input.commandId);
      if (!command?.run || command.executionTarget !== "prompt") {
        throw new PromptCommandNotFoundError(input.commandId);
      }

      const raw = input.args?.trim() ?? "";
      if (!raw && command.argumentMode === "required") {
        throw new PromptCommandUsageError(
          command.id,
          `${command.path} ${command.argumentHint}`.trim(),
        );
      }

      const context: CommandContext = { cwd };
      const availability = command.available?.(context) ?? { enabled: true };
      if (!availability.enabled) {
        throw new Error(availability.reason ?? `Command ${command.id} is disabled.`);
      }

      const result = await command.run(
        context,
        createCommandRunInput(
          raw ? `${command.path} ${raw}` : command.path,
          raw,
          command.path,
        ),
      );
      const descriptor = findRuntimeCommandNode(loaded.snapshot.roots, command.id);
      if (!descriptor) throw new PromptCommandNotFoundError(command.id);
      return {
        prompt: result.prompt,
        command: cloneCommandNode(descriptor),
        metadata: result.metadata,
      };
    },
  };
}

export function promptNamespaces(commands: readonly CommandDefinition[]): CommandDefinition[] {
  return commands.flatMap((command) => command.name === "prompt" ? [...command.children] : []);
}

export function cloneCatalog(catalog: RuntimeCommandCatalog): RuntimeCommandCatalog {
  return {
    roots: catalog.roots.map(cloneCommandNode),
    diagnostics: catalog.diagnostics.map(cloneDiagnostic),
  };
}

export function findRuntimeCommandNode(
  roots: readonly RuntimeCommandNode[],
  id: string,
): RuntimeCommandNode | undefined {
  for (const command of roots) {
    if (command.id === id) return command;
    const child = findRuntimeCommandNode(command.children, id);
    if (child) return child;
  }
  return undefined;
}

function cloneCommandNode(command: RuntimeCommandNode): RuntimeCommandNode {
  return {
    ...command,
    children: command.children.map(cloneCommandNode),
  };
}

function cloneDiagnostic(diagnostic: RuntimeCommandDiagnostic): RuntimeCommandDiagnostic {
  return {
    ...diagnostic,
    ...(diagnostic.commandIds ? { commandIds: [...diagnostic.commandIds] } : {}),
    ...(diagnostic.origins ? { origins: [...diagnostic.origins] } : {}),
  };
}
