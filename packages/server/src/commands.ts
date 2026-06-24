import {
  builtinCommands,
  createCommandRegistry,
  loadProjectCommands,
  loadUserCommands,
  resolveCommand,
  type CommandDefinition,
  type PromptCommandMetadata,
  type ProjectCommandDiagnostic,
  type ProjectCommandsLoadResult,
} from "@chili/commands";
import type {
  RuntimePromptCommandDescriptor,
  RuntimePromptCommandDiagnostic,
  RuntimePromptCommandInvocation,
  RuntimePromptCommandList,
} from "@chili/protocol";

export interface PromptCommandControl {
  list(): Promise<RuntimePromptCommandList>;
  reload(): Promise<RuntimePromptCommandList>;
  run(input: RuntimePromptCommandInvocation): Promise<PromptCommandRunResult>;
}

export interface PromptCommandRunResult {
  prompt: string;
  command: RuntimePromptCommandDescriptor;
  metadata: PromptCommandMetadata;
}

export interface FilesystemPromptCommandControlOptions {
  cwd: string;
  chiliHome?: string;
}

interface LoadedPromptCommands {
  registry: ReturnType<typeof createCommandRegistry>;
  snapshot: RuntimePromptCommandList;
}

export class PromptCommandNotFoundError extends Error {
  constructor(readonly commandName: string) {
    super(`Unknown command: /${commandName}`);
    this.name = "PromptCommandNotFoundError";
  }
}

export class PromptCommandAmbiguousError extends Error {
  constructor(readonly commandName: string) {
    super(`Ambiguous command: /${commandName}`);
    this.name = "PromptCommandAmbiguousError";
  }
}

export function createFilesystemPromptCommandControl(
  options: FilesystemPromptCommandControlOptions,
): PromptCommandControl {
  let cached: LoadedPromptCommands | undefined;

  const load = async (): Promise<LoadedPromptCommands> => {
    const [project, user] = await Promise.all([
      loadProjectCommands({ cwd: options.cwd }),
      loadUserCommands(options.chiliHome ? { chiliHome: options.chiliHome } : {}),
    ]);
    const registry = createCommandRegistry(project.commands);
    const userResults = registry.registerMany(user.commands);
    registry.registerMany(builtinCommands);
    const skippedConflicts = userResults
      .filter((result) => result.status === "skipped")
      .map((result) => result.name);

    return {
      registry,
      snapshot: {
        commands: registry.list().map(descriptorForCommand),
        diagnostics: [...project.diagnostics, ...user.diagnostics].map(protocolDiagnostic),
        directories: directoriesOf(project, user),
        skippedConflicts,
      },
    };
  };

  const ensure = async (): Promise<LoadedPromptCommands> => {
    cached ??= await load();
    return cached;
  };

  return {
    async list() {
      return cloneSnapshot((await ensure()).snapshot);
    },
    async reload() {
      cached = await load();
      return cloneSnapshot(cached.snapshot);
    },
    async run(input) {
      const loaded = await ensure();
      const commandName = input.name.trim();
      const args = input.args?.trim() ?? "";
      const invocation = args.length > 0 ? `/${commandName} ${args}` : `/${commandName}`;
      const resolved = resolveCommand(loaded.registry, invocation, { includeHidden: true });
      if (resolved.status === "unknown") throw new PromptCommandNotFoundError(commandName);
      if (resolved.status === "ambiguous") throw new PromptCommandAmbiguousError(commandName);

      const context = input.cwd ? { cwd: input.cwd } : { cwd: options.cwd };
      const result = await resolved.command.run(context, resolved.args);
      return {
        prompt: result.prompt,
        command: descriptorForCommand(resolved.command),
        metadata: result.metadata,
      };
    },
  };
}

function descriptorForCommand(command: CommandDefinition): RuntimePromptCommandDescriptor {
  return {
    name: command.name,
    aliases: [...command.aliases],
    description: command.description,
    category: command.category,
    source: command.source,
    argumentHint: command.argumentHint,
    hidden: command.hidden,
  };
}

function protocolDiagnostic(diagnostic: ProjectCommandDiagnostic): RuntimePromptCommandDiagnostic {
  const output: RuntimePromptCommandDiagnostic = {
    level: diagnostic.level,
    code: diagnostic.code,
    message: diagnostic.message,
  };
  if (diagnostic.filePath) output.filePath = diagnostic.filePath;
  return output;
}

function directoriesOf(...results: readonly ProjectCommandsLoadResult[]): string[] {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const result of results) {
    if (seen.has(result.directory)) continue;
    seen.add(result.directory);
    directories.push(result.directory);
  }
  return directories;
}

function cloneSnapshot(snapshot: RuntimePromptCommandList): RuntimePromptCommandList {
  return {
    commands: snapshot.commands.map((command) => ({ ...command, aliases: [...command.aliases] })),
    diagnostics: snapshot.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    directories: [...snapshot.directories],
    skippedConflicts: [...snapshot.skippedConflicts],
  };
}
