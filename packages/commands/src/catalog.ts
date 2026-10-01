import { createCommandRegistry, defineCommand } from "./registry.js";
import type {
  CommandAvailability,
  CommandCompletionInput,
  CommandDefinition,
  CommandSuggestion,
} from "./types.js";

export const BUILTIN_COMMAND_IDS = [
  "help",
  "status",
  "theme",
  "permissions",
  "model",
  "model.select",
  "model.service",
  "thinking",
  "thinking.effort",
  "thinking.traces",
  "rename",
  "session",
  "session.new",
  "session.list",
  "session.resume",
  "session.rename",
  "session.compact",
  "session.revert",
  "session.delegation",
  "goal",
  "goal.show",
  "goal.set",
  "goal.pause",
  "goal.resume",
  "goal.clear",
  "team",
  "team.agents",
  "team.mailbox",
  "team.tasks",
  "team.task",
  "team.recover",
  "team.run",
  "team.merge",
  "memory",
  "memory.show",
  "memory.add",
  "memory.reload",
  "auth",
  "auth.status",
  "auth.login",
  "auth.logout",
  "skills",
  "skills.browse",
  "skills.enable",
  "skills.disable",
  "skills.reload",
  "mcp",
  "mcp.status",
  "mcp.tools",
  "mcp.reload",
  "mcp.add",
  "mcp.remove",
  "mcp.auth",
  "mcp.logout",
  "commands",
  "commands.reload",
  "commands.diagnostics",
  "app",
  "app.exit",
] as const;

export type BuiltinCommandId = (typeof BUILTIN_COMMAND_IDS)[number];

export interface BuiltinCommandBinding<TContext, TResult> {
  available?: (context: TContext) => CommandAvailability;
  complete?: (
    context: TContext,
    input: CommandCompletionInput,
  ) => readonly CommandSuggestion[] | Promise<readonly CommandSuggestion[]>;
  run?: CommandDefinition<TContext, TResult>["run"];
}

export type BuiltinCommandBindings<TContext, TResult> = Readonly<
  Partial<Record<BuiltinCommandId, BuiltinCommandBinding<TContext, TResult>>>
>;

interface BuiltinCommandSpec {
  id: BuiltinCommandId;
  name: string;
  title: string;
  description: string;
  group: string;
  argumentMode?: CommandDefinition["argumentMode"];
  argumentHint?: string;
  selectionMode?: CommandDefinition["selectionMode"];
  concurrency?: CommandDefinition["concurrency"];
  children?: readonly BuiltinCommandSpec[];
}

export function bindBuiltinCommands<TContext, TResult>(
  bindings: BuiltinCommandBindings<TContext, TResult>,
): CommandDefinition<TContext, TResult>[] {
  const commands = BUILTIN_COMMAND_SPECS
    .map((command) => bindSpec(command, bindings))
    .filter((command): command is CommandDefinition<TContext, TResult> => command !== undefined);
  return [...createCommandRegistry(commands).roots()];
}

const BUILTIN_COMMAND_SPECS: readonly BuiltinCommandSpec[] = [
  leaf("help", "help", "Help", "Browse commands and keyboard shortcuts", "general"),
  leaf("status", "status", "Status", "Show session and team status", "general"),
  leaf("theme", "theme", "Theme", "Switch the terminal theme", "general"),
  leaf("permissions", "permissions", "Permissions", "Choose what Chili may do", "general"),
  parent("model", "model", "Model", "Configure the active model", "model", [
    leaf("model.select", "select", "Select model", "Choose a provider and model", "model", {
      argumentMode: "required",
      argumentHint: "<provider/model>",
      selectionMode: "complete",
    }),
    leaf("model.service", "service", "Service tier", "Choose standard or fast service", "model", {
      argumentMode: "required",
      argumentHint: "<standard|fast>",
      selectionMode: "complete",
    }),
  ]),
  parent("thinking", "thinking", "Thinking", "Configure reasoning and traces", "model", [
    leaf("thinking.effort", "effort", "Reasoning effort", "Set model reasoning effort", "model", {
      argumentMode: "required",
      argumentHint: "<off|minimal|low|medium|high|xhigh|max|ultra>",
      selectionMode: "complete",
    }),
    leaf("thinking.traces", "traces", "Thinking traces", "Show or hide reasoning traces", "model", {
      argumentMode: "required",
      argumentHint: "<show|hide>",
      selectionMode: "complete",
    }),
  ]),
  leaf("rename", "rename", "Rename session", "Rename the current session", "session", {
    argumentMode: "optional",
    argumentHint: "[title]",
  }),
  parent("session", "session", "Session", "Manage chat sessions", "session", [
    leaf("session.new", "new", "New session", "Start a fresh chat session", "session", { concurrency: "deny" }),
    leaf("session.list", "list", "List sessions", "List saved sessions", "session"),
    leaf("session.resume", "resume", "Resume session", "Resume a saved session", "session", {
      argumentMode: "optional",
      argumentHint: "[session]",
      selectionMode: "complete",
      concurrency: "deny",
    }),
    leaf("session.rename", "rename", "Rename session", "Rename the current session", "session", {
      argumentMode: "optional",
      argumentHint: "[title]",
    }),
    leaf("session.compact", "compact", "Compact context", "Compress conversation context", "session", {
      argumentMode: "optional",
      argumentHint: "[focus]",
      concurrency: "deny",
    }),
    leaf("session.revert", "revert", "Revert snapshot", "Revert a session snapshot", "session", {
      argumentMode: "required",
      argumentHint: "<snapshot-id>",
      selectionMode: "complete",
      concurrency: "deny",
    }),
    leaf(
      "session.delegation",
      "delegation",
      "Delegation policy",
      "Show or set the session delegation policy",
      "session",
      {
        argumentMode: "optional",
        argumentHint: "[off|explicit|proactive|status]",
        selectionMode: "complete",
      },
    ),
  ]),
  parent("goal", "goal", "Goal", "Manage the persistent goal", "session", [
    leaf("goal.show", "show", "Show goal", "Show the current persistent goal", "session"),
    leaf("goal.set", "set", "Set goal", "Set a persistent goal objective", "session", {
      argumentMode: "variadic",
      argumentHint: "[--budget <tokens>] <objective>",
      selectionMode: "complete",
    }),
    leaf("goal.pause", "pause", "Pause goal", "Pause the persistent goal", "session"),
    leaf("goal.resume", "resume", "Resume goal", "Resume the persistent goal", "session"),
    leaf("goal.clear", "clear", "Clear goal", "Clear the persistent goal", "session"),
  ]),
  parent("team", "team", "Team", "Inspect and control agent teamwork", "team", [
    leaf("team.agents", "agents", "Agents", "Show the agent tree", "team"),
    leaf("team.mailbox", "mailbox", "Mailbox", "Show queued agent messages", "team"),
    leaf("team.tasks", "tasks", "Tasks", "List agent tasks", "team"),
    leaf("team.task", "task", "Task", "Show one agent task", "team", {
      argumentMode: "required",
      argumentHint: "<task-id>",
      selectionMode: "complete",
    }),
    leaf("team.recover", "recover", "Recover tasks", "Close stale background tasks", "team", { concurrency: "deny" }),
    leaf("team.run", "run", "Run team", "Start the selected team loop", "team", { concurrency: "deny" }),
    leaf("team.merge", "merge", "Merge team work", "Merge pending team work", "team", { concurrency: "deny" }),
  ]),
  parent("memory", "memory", "Memory", "Inspect and update Chili memory", "memory", [
    leaf("memory.show", "show", "Show memory", "Show loaded memory and instructions", "memory", {
      argumentMode: "optional",
      argumentHint: "[--user|--project|--all]",
    }),
    leaf("memory.add", "add", "Add memory", "Save a memory entry", "memory", {
      argumentMode: "variadic",
      argumentHint: "[--user|--project] <text>",
      selectionMode: "complete",
    }),
    leaf("memory.reload", "reload", "Reload memory", "Reload memory sources", "memory", {
      argumentMode: "optional",
      argumentHint: "[--user|--project|--all]",
    }),
  ]),
  parent("auth", "auth", "Authentication", "Manage ChatGPT Codex authentication", "auth", [
    leaf("auth.status", "status", "Auth status", "Show authentication status", "auth"),
    leaf("auth.login", "login", "Log in", "Log in to ChatGPT Codex", "auth", { concurrency: "deny" }),
    leaf("auth.logout", "logout", "Log out", "Remove ChatGPT Codex credentials", "auth", { concurrency: "deny" }),
  ]),
  parent("skills", "skills", "Skills", "Browse and configure skills", "skills", [
    leaf("skills.browse", "browse", "Browse skills", "Browse available skills", "skills"),
    leaf("skills.enable", "enable", "Enable skill", "Enable a skill", "skills", {
      argumentMode: "variadic",
      argumentHint: "[--user|--project] <name>",
      selectionMode: "complete",
    }),
    leaf("skills.disable", "disable", "Disable skill", "Disable a skill", "skills", {
      argumentMode: "variadic",
      argumentHint: "[--user|--project] <name>",
      selectionMode: "complete",
    }),
    leaf("skills.reload", "reload", "Reload skills", "Reload skill definitions", "skills"),
  ]),
  parent("mcp", "mcp", "MCP", "Manage MCP servers", "mcp", [
    leaf("mcp.status", "status", "MCP status", "Show MCP server status", "mcp", {
      argumentMode: "optional",
      argumentHint: "[server]",
      selectionMode: "complete",
    }),
    leaf("mcp.tools", "tools", "MCP tools", "List tools from one MCP server", "mcp", {
      argumentMode: "required",
      argumentHint: "<server>",
      selectionMode: "complete",
    }),
    leaf("mcp.reload", "reload", "Reload MCP", "Reload MCP servers", "mcp"),
    leaf("mcp.add", "add", "Add MCP server", "Add a remote MCP server", "mcp", {
      argumentMode: "variadic",
      argumentHint: "<name> --url <url> [options]",
      selectionMode: "complete",
    }),
    leaf("mcp.remove", "remove", "Remove MCP server", "Remove an MCP server", "mcp", {
      argumentMode: "required",
      argumentHint: "<server>",
      selectionMode: "complete",
    }),
    leaf("mcp.auth", "auth", "Authenticate MCP", "Authenticate an MCP server", "mcp", {
      argumentMode: "variadic",
      argumentHint: "<server> [options]",
      selectionMode: "complete",
    }),
    leaf("mcp.logout", "logout", "Log out MCP", "Log out from an MCP server", "mcp", {
      argumentMode: "required",
      argumentHint: "<server>",
      selectionMode: "complete",
    }),
  ]),
  parent("commands", "commands", "Commands", "Reload commands or inspect diagnostics", "system", [
    leaf("commands.reload", "reload", "Reload commands", "Reload reusable prompt commands", "system"),
    leaf("commands.diagnostics", "diagnostics", "Command diagnostics", "Show command loading errors and conflicts", "system"),
  ]),
  parent("app", "app", "Application", "Control the current application", "system", [
    leaf("app.exit", "exit", "Exit", "Exit the current application", "system"),
  ]),
];

function bindSpec<TContext, TResult>(
  spec: BuiltinCommandSpec,
  bindings: BuiltinCommandBindings<TContext, TResult>,
): CommandDefinition<TContext, TResult> | undefined {
  const binding = bindings[spec.id];
  const children = (spec.children ?? [])
    .map((child) => bindSpec(child, bindings))
    .filter((child): child is CommandDefinition<TContext, TResult> => child !== undefined);
  if (!binding && children.length === 0) return undefined;

  return defineCommand({
    id: spec.id,
    name: spec.name,
    title: spec.title,
    description: spec.description,
    group: spec.group,
    source: "builtin",
    selectionMode: spec.selectionMode ?? (spec.children ? "drilldown" : "execute"),
    executionTarget: "client",
    children,
    ...(spec.argumentMode !== undefined ? { argumentMode: spec.argumentMode } : {}),
    ...(spec.argumentHint !== undefined ? { argumentHint: spec.argumentHint } : {}),
    ...(spec.concurrency !== undefined ? { concurrency: spec.concurrency } : {}),
    ...(binding?.available ? { available: binding.available } : {}),
    ...(binding?.complete ? { complete: binding.complete } : {}),
    ...(binding?.run ? { run: binding.run } : {}),
  });
}

function parent(
  id: BuiltinCommandId,
  name: string,
  title: string,
  description: string,
  group: string,
  children: readonly BuiltinCommandSpec[],
): BuiltinCommandSpec {
  return { id, name, title, description, group, selectionMode: "drilldown", children };
}

function leaf(
  id: BuiltinCommandId,
  name: string,
  title: string,
  description: string,
  group: string,
  options: Pick<BuiltinCommandSpec, "argumentMode" | "argumentHint" | "selectionMode" | "concurrency"> = {},
): BuiltinCommandSpec {
  return { id, name, title, description, group, ...options };
}
