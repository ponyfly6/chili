import { CommandRegistry, defineCommand } from "./registry.js";
import type { CommandDefinition, CommandDefinitionInput, CommandRunResult, CommandType } from "./types.js";

export const BUILTIN_COMMANDS: readonly CommandDefinition[] = [
  builtin({
    name: "help",
    aliases: ["?", "h"],
    category: "view",
    description: "Show available commands",
    type: "local",
  }),
  builtin({
    name: "status",
    aliases: ["st"],
    category: "view",
    description: "Show session and runtime status",
    type: "local",
  }),
  builtin({
    name: "sessions",
    aliases: ["ls"],
    category: "session",
    description: "List known sessions",
    type: "local",
  }),
  builtin({
    name: "resume",
    aliases: ["continue"],
    category: "session",
    description: "Resume a session",
    argumentHint: "<id>",
    type: "action",
    supportsNonInteractive: true,
  }),
  builtin({
    name: "new",
    category: "session",
    description: "Start a new session",
    type: "action",
    supportsNonInteractive: true,
  }),
  builtin({
    name: "compact",
    category: "session",
    description: "Compact the current conversation",
    argumentHint: "[focus]",
    type: "action",
    supportsNonInteractive: true,
  }),
  builtin({
    name: "diff",
    category: "workspace",
    description: "Show workspace changes",
    type: "local",
  }),
  builtin({
    name: "permissions",
    category: "policy",
    description: "Show active tool permissions",
    type: "local",
  }),
  builtin({
    name: "memory",
    aliases: ["mem"],
    category: "memory",
    description: "Inspect or update memory",
    type: "local",
    subCommands: [
      local("show", "memory", "Show loaded memory", "", "memory show"),
      action("add", "memory", "Add a memory entry", "<text>", true, "memory add"),
      action("reload", "memory", "Reload memory from disk", "", true, "memory reload"),
    ],
  }),
  builtin({
    name: "tasks",
    category: "task",
    description: "List tasks",
    type: "local",
  }),
  builtin({
    name: "task",
    category: "task",
    description: "Show a task",
    argumentHint: "<id>",
    type: "local",
  }),
  builtin({
    name: "team",
    category: "team",
    description: "Inspect or operate on team state",
    type: "local",
    subCommands: [
      local("status", "team", "Show team status", "", "team status"),
      local("tasks", "team", "Show team tasks", "", "team tasks"),
      local("members", "team", "Show team members", "", "team members"),
      local("messages", "team", "Show team messages", "", "team messages"),
      action("run", "team", "Run the selected team loop", "", true, "team run"),
      action("merge", "team", "Merge completed team work", "", true, "team merge"),
    ],
  }),
  builtin({
    name: "commands",
    category: "registry",
    description: "Inspect or refresh command definitions",
    type: "local",
    subCommands: [action("reload", "registry", "Reload project commands", "", true, "commands reload")],
  }),
];

export function createBuiltinCommandRegistry(projectCommands: readonly CommandDefinition[] = []): CommandRegistry {
  const registry = new CommandRegistry(BUILTIN_COMMANDS);
  registry.registerMany(projectCommands);
  return registry;
}

function builtin(input: Omit<CommandDefinitionInput, "source" | "run">): CommandDefinition {
  return defineCommand({
    ...input,
    source: "builtin",
    run: () => builtinResult(input.name, input.type),
  });
}

function local(
  name: string,
  category: string,
  description: string,
  argumentHint = "",
  commandPath = name,
): CommandDefinitionInput {
  return {
    name,
    category,
    description,
    argumentHint,
    source: "builtin",
    type: "local",
    run: () => builtinResult(commandPath, "local"),
  };
}

function action(
  name: string,
  category: string,
  description: string,
  argumentHint = "",
  supportsNonInteractive = false,
  commandPath = name,
): CommandDefinitionInput {
  return {
    name,
    category,
    description,
    argumentHint,
    source: "builtin",
    type: "action",
    supportsNonInteractive,
    isSafeConcurrent: false,
    run: () => builtinResult(commandPath, "action"),
  };
}

function builtinResult(command: string, type: CommandType): CommandRunResult {
  if (type === "action") {
    return {
      type: "action",
      action: command.replace(/\s+/g, "_"),
      stub: true,
      message: `/${command} is defined in the builtin registry; runtime integration is pending.`,
    };
  }

  return {
    type: "local",
    format: "text",
    content: `/${command} is defined in the builtin registry; host rendering is pending.`,
  };
}
