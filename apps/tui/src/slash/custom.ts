import {
  createCommandRegistry,
  createCommandRunInput,
  loadProjectCommands,
  loadUserCommands,
  type CommandDefinition,
  type ProjectCommandDiagnostic,
  type ProjectCommandsLoadResult,
} from "@chili/commands";
import type { SlashCommand } from "./types.js";

export interface CustomSlashCommandsState {
  commands: readonly SlashCommand[];
  diagnostics: readonly ProjectCommandDiagnostic[];
  directories: readonly string[];
  skippedConflicts: readonly string[];
}

export async function loadCustomSlashCommands(cwd: string): Promise<CustomSlashCommandsState> {
  const [project, user] = await Promise.all([
    loadProjectCommands({ cwd }),
    loadUserCommands(),
  ]);
  const registry = createCommandRegistry(project.commands);
  const userResults = registry.registerMany(user.commands);
  const skippedConflicts = userResults
    .filter((result) => result.status === "skipped")
    .map((result) => result.name);

  return {
    commands: registry.list().map(commandToSlashCommand),
    diagnostics: [...project.diagnostics, ...user.diagnostics],
    directories: directoriesOf(project, user),
    skippedConflicts,
  };
}

function commandToSlashCommand(command: CommandDefinition): SlashCommand {
  return {
    name: command.name,
    aliases: [...command.aliases],
    description: command.description,
    category: "custom",
    argumentHint: command.argumentHint,
    hidden: command.hidden,
    isSafeConcurrent: command.isSafeConcurrent,
    run: async (ctx, args) => {
      const invocation = `/${command.name}`;
      const input = args.length > 0 ? `${invocation} ${args}` : invocation;
      const commandContext = ctx.cwd ? { cwd: ctx.cwd } : {};
      const result = await command.run(commandContext, createCommandRunInput(input, args, invocation));
      return {
        type: "submit_prompt",
        prompt: result.prompt,
        commandName: command.name,
      };
    },
  };
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
