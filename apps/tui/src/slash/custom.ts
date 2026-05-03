import type { RuntimePromptCommandDescriptor, RuntimePromptCommandList } from "@chili/protocol";
import type { SlashCommand } from "./types.js";

export interface CustomSlashCommandsState {
  commands: readonly SlashCommand[];
  diagnostics: RuntimePromptCommandList["diagnostics"];
  directories: readonly string[];
  skippedConflicts: readonly string[];
}

export function customSlashCommandsFromRuntime(
  commandList: RuntimePromptCommandList | undefined,
): CustomSlashCommandsState {
  return {
    commands: (commandList?.commands ?? []).map(commandToSlashCommand),
    diagnostics: commandList?.diagnostics ?? [],
    directories: commandList?.directories ?? [],
    skippedConflicts: commandList?.skippedConflicts ?? [],
  };
}

function commandToSlashCommand(command: RuntimePromptCommandDescriptor): SlashCommand {
  return {
    name: command.name,
    aliases: [...command.aliases],
    description: command.description,
    category: "custom",
    argumentHint: command.argumentHint,
    hidden: command.hidden,
    isSafeConcurrent: true,
    run: (_ctx, args) => ({
      type: "submit_command",
      commandName: command.name,
      args,
    }),
  };
}
