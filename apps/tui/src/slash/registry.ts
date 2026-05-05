import type { SkillSettingsScope, SkillSummary } from "@chili/skills";
import type { RuntimeMcpAddServerRequest, RuntimeMcpAuthRequest, RuntimeMcpTransport } from "@chili/protocol";
import type { SlashCommand, SlashCommandContext, SlashCommandResult, SlashCompletion } from "./types.js";
import {
  REASONING_LEVELS,
  defaultModelCandidates,
  isReasoningLevel,
  modelDescriptorSelection,
  modelSelectionLabel,
  parseModelCommand,
  type ReasoningLevel,
} from "../model-state.js";

export function createDefaultSlashCommands(): SlashCommand[] {
  return [
    {
      name: "team",
      description: "Open the team cockpit",
      category: "team",
      run: () => ({ type: "open_view", view: "team" }),
    },
    {
      name: "team run",
      description: "Start the selected team loop",
      category: "team",
      isSafeConcurrent: false,
      run: () => ({ type: "sdk_action", action: "team_run" }),
    },
    {
      name: "team merge",
      description: "Merge pending team work",
      category: "team",
      isSafeConcurrent: false,
      run: () => ({ type: "sdk_action", action: "team_merge" }),
    },
    {
      name: "theme",
      description: "Switch theme",
      category: "view",
      isSafeConcurrent: true,
      run: () => ({ type: "open_theme_picker" }),
    },
    {
      name: "hide-thinking",
      description: "Hide thinking traces",
      category: "model",
      isSafeConcurrent: true,
      run: () => ({ type: "set_hide_thinking", hidden: true }),
    },
    {
      name: "show-thinking",
      description: "Show thinking traces",
      category: "model",
      isSafeConcurrent: true,
      run: () => ({ type: "set_hide_thinking", hidden: false }),
    },
    {
      name: "goal",
      description: "Set or control a persistent goal",
      category: "session",
      argumentHint: "[pause|resume|clear|--budget 50k|objective]",
      isSafeConcurrent: true,
      complete: goalCompletions,
      run: (_ctx, args) => goalResult(args),
    },
    {
      name: "clear",
      description: "Start a fresh chat session",
      category: "session",
      isSafeConcurrent: true,
      run: () => ({ type: "new_session" }),
    },
    {
      name: "new",
      description: "Start a fresh chat session",
      category: "session",
      isSafeConcurrent: true,
      run: () => ({ type: "new_session" }),
    },
    {
      name: "help",
      description: "Show commands and shortcuts",
      category: "view",
      isSafeConcurrent: true,
      run: () => ({ type: "open_view", view: "help" }),
    },
    {
      name: "commands",
      description: "Show commands and shortcuts",
      category: "view",
      isSafeConcurrent: true,
      run: () => ({ type: "open_view", view: "help" }),
    },
    {
      name: "commands reload",
      description: "Reload project and user commands",
      category: "custom",
      isSafeConcurrent: true,
      run: () => ({ type: "reload_commands" }),
    },
    {
      name: "mcp",
      description: "Manage MCP servers",
      category: "mcp",
      argumentHint: "[status|tools|reload|add|remove|auth|logout]",
      isSafeConcurrent: true,
      complete: mcpCompletions,
      run: (_ctx, args) => mcpResult(args),
    },
    {
      name: "status",
      description: "Show session and team status",
      category: "view",
      isSafeConcurrent: true,
      run: () => ({ type: "open_view", view: "status" }),
    },
    {
      name: "permissions",
      aliases: ["approvals"],
      description: "Choose what Chili is allowed to do",
      category: "policy",
      isSafeConcurrent: true,
      run: openPermissionsView,
    },
    {
      name: "approvals",
      description: "Choose what Chili is allowed to do",
      category: "policy",
      isSafeConcurrent: true,
      run: openPermissionsView,
    },
    {
      name: "agents",
      description: "Show agent activity",
      category: "team",
      isSafeConcurrent: true,
      run: () => ({ type: "open_view", view: "agents" }),
    },
    {
      name: "login",
      aliases: ["auth login"],
      description: "Login to ChatGPT Codex",
      category: "auth",
      isSafeConcurrent: false,
      run: () => ({ type: "auth_action", action: "login", provider: "openai-codex" }),
    },
    {
      name: "logout",
      aliases: ["auth logout"],
      description: "Remove ChatGPT Codex credentials",
      category: "auth",
      isSafeConcurrent: false,
      run: () => ({ type: "auth_action", action: "logout", provider: "openai-codex" }),
    },
    {
      name: "auth",
      description: "Show ChatGPT Codex auth status",
      category: "auth",
      isSafeConcurrent: true,
      run: () => ({ type: "auth_action", action: "status", provider: "openai-codex" }),
    },
    {
      name: "skills",
      description: "List skills",
      category: "skills",
      isSafeConcurrent: true,
      run: () => ({ type: "insert_prompt", text: "$" }),
    },
    {
      name: "skills enable",
      description: "Enable a skill",
      category: "skills",
      argumentHint: "[--user|--project] <name>",
      isSafeConcurrent: true,
      complete: skillToggleCompletions("enable"),
      run: (_ctx, args) => skillToggleResult("enable", args),
    },
    {
      name: "skills disable",
      description: "Disable a skill",
      category: "skills",
      argumentHint: "[--user|--project] <name>",
      isSafeConcurrent: true,
      complete: skillToggleCompletions("disable"),
      run: (_ctx, args) => skillToggleResult("disable", args),
    },
    {
      name: "model",
      description: "Select model",
      category: "model",
      argumentHint: "[provider/model]",
      isSafeConcurrent: true,
      complete: modelCompletions,
      run: (ctx, args) => {
        const match = parseModelCommand(args, modelCandidates(ctx));
        if (match.selection) {
          return {
            type: "set_model",
            selection: match.selection,
            ...(match.reasoningLevel ? { reasoningLevel: match.reasoningLevel } : {}),
          };
        }
        return {
          type: "open_model_picker",
          ...(match.query ? { query: match.query } : {}),
        };
      },
    },
    {
      name: "thinking",
      aliases: ["reasoning"],
      description: "Set reasoning level or visibility",
      category: "model",
      argumentHint: "<off|minimal|low|medium|high|xhigh|hide|show>",
      isSafeConcurrent: true,
      complete: reasoningCompletions,
      run: (_ctx, args) => {
        const level = args.trim().toLowerCase();
        if (!level) return { type: "open_reasoning_picker" };
        if (level === "hide") return { type: "set_hide_thinking", hidden: true };
        if (level === "show") return { type: "set_hide_thinking", hidden: false };
        if (isReasoningLevel(level)) return { type: "set_reasoning", level };
        return {
          type: "local_message",
          level: "error",
          text: `Unknown thinking option: ${args.trim() || "none"}`,
        };
      },
    },
  ];
}

function openPermissionsView(): SlashCommandResult {
  return { type: "open_permissions_picker" };
}

export function resolveSlashCommand(
  commands: readonly SlashCommand[],
  input: string,
): { command: SlashCommand; args: string } | undefined {
  const rawBody = input.replace(/^\//, "").trimStart();
  const body = normalizeInput(input);
  if (!body) return undefined;
  const matches = commands
    .flatMap((command) => commandNames(command).map((name) => ({ command, name })))
    .filter(({ name }) => body === name || body.startsWith(`${name} `))
    .sort((left, right) => right.name.length - left.name.length);
  const match = matches[0];
  if (!match) return undefined;
  return {
    command: match.command,
    args: rawBody.slice(match.name.length).trimStart(),
  };
}

export function slashCompletions(
  commands: readonly SlashCommand[],
  ctx: SlashCommandContext,
  input: string,
  limit = 8,
): SlashCompletion[] {
  const body = normalizeInput(input);
  const custom = commands.flatMap((command) => command.complete?.(ctx, body) ?? []);
  const registry = commands
    .map((command, index) => ({ command, index, rank: commandMatchRank(command, body) }))
    .filter((candidate): candidate is { command: SlashCommand; index: number; rank: CommandMatchRank } => candidate.rank !== undefined)
    .sort((left, right) => compareCommandMatch(left.rank, right.rank) || left.index - right.index)
    .map(({ command }) => command)
    .filter((command) => !command.hidden)
    .map((command) => ({
      value: `/${command.name}`,
      label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
      description: command.description,
      category: command.category,
    }));

  return uniqueCompletions([...custom, ...registry]).slice(0, limit);
}

function normalizeInput(input: string): string {
  return input.replace(/^\//, "").trimStart().replace(/\s+/g, " ").toLowerCase();
}

function commandNames(command: SlashCommand): string[] {
  return [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
}

interface CommandMatchRank {
  kind: 0 | 1 | 2;
  nameLength: number;
}

function commandMatchRank(command: SlashCommand, input: string): CommandMatchRank | undefined {
  if (command.hidden) return undefined;
  let best: CommandMatchRank | undefined;
  for (const name of commandNames(command)) {
    const rank = nameMatchRank(name, input);
    if (!rank) continue;
    if (!best || compareCommandMatch(rank, best) < 0) best = rank;
  }
  return best;
}

function nameMatchRank(name: string, input: string): CommandMatchRank | undefined {
  if (!input) return { kind: 0, nameLength: 0 };
  if (name === input) return { kind: 0, nameLength: name.length };
  if (name.startsWith(input)) return { kind: 1, nameLength: name.length };
  if (fuzzyMatch(name, input)) return { kind: 2, nameLength: name.length };
  return undefined;
}

function compareCommandMatch(left: CommandMatchRank, right: CommandMatchRank): number {
  return left.kind - right.kind || left.nameLength - right.nameLength;
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

function uniqueCompletions(completions: readonly SlashCompletion[]): SlashCompletion[] {
  const seen = new Set<string>();
  const output: SlashCompletion[] = [];
  for (const completion of completions) {
    if (seen.has(completion.value)) continue;
    seen.add(completion.value);
    output.push(completion);
  }
  return output;
}

function goalCompletions(_ctx: SlashCommandContext, input: string): SlashCompletion[] {
  const query = commandArgument(input, "goal");
  if (query === undefined) return [];
  const rows = [
    { value: "/goal pause", label: "/goal pause", description: "Pause the active goal" },
    { value: "/goal resume", label: "/goal resume", description: "Resume the paused goal" },
    { value: "/goal clear", label: "/goal clear", description: "Clear the current goal" },
  ];
  const normalized = query.trim().toLowerCase();
  return rows
    .filter((row) => !normalized || row.value.includes(normalized))
    .map((row) => ({ ...row, category: "session" as const }));
}

function goalResult(args: string): SlashCommandResult {
  const trimmed = args.trim();
  if (!trimmed) return { type: "goal_action", action: "show" };
  const normalized = trimmed.toLowerCase();
  if (normalized === "pause") return { type: "goal_action", action: "pause" };
  if (normalized === "resume") return { type: "goal_action", action: "resume" };
  if (normalized === "clear" || normalized === "delete") return { type: "goal_action", action: "clear" };
  const parsed = parseGoalSetArgs(trimmed);
  if (!parsed.objective) {
    return { type: "local_message", level: "error", text: "Goal objective is required." };
  }
  return {
    type: "goal_action",
    action: "set",
    objective: parsed.objective,
    ...(parsed.tokenBudget !== undefined ? { tokenBudget: parsed.tokenBudget } : {}),
  };
}

function parseGoalSetArgs(args: string): { objective: string; tokenBudget?: number } {
  const parts = args.split(/\s+/);
  let tokenBudget: number | undefined;
  const objectiveParts: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] ?? "";
    if (part === "--budget" || part === "-b") {
      const value = parts[index + 1];
      if (value) {
        tokenBudget = parseTokenBudget(value);
        index++;
      }
      continue;
    }
    if (part.startsWith("--budget=")) {
      tokenBudget = parseTokenBudget(part.slice("--budget=".length));
      continue;
    }
    objectiveParts.push(part);
  }
  return {
    objective: objectiveParts.join(" ").trim(),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  };
}

function parseTokenBudget(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const budget = Math.round(amount * multiplier);
  return Number.isFinite(budget) && budget > 0 ? budget : undefined;
}

function modelCompletions(ctx: SlashCommandContext, input: string): SlashCompletion[] {
  const query = commandArgument(input, "model");
  if (query === undefined) return [];

  const candidates = modelCandidates(ctx);
  const normalized = query.trim().toLowerCase();
  const matches = candidates
    .filter((model) => !normalized || fuzzyMatch(`${model.provider} ${model.model} ${model.provider}/${model.model} ${model.displayName ?? ""}`.toLowerCase(), normalized))
    .slice(0, 8);
  return matches.flatMap((model) => {
    const selection = modelDescriptorSelection(model);
    const canonical = modelSelectionLabel(selection);
    const description = model.provider;
    return [
      {
        value: `/model ${canonical}`,
        label: canonical,
        description,
        category: "model" as const,
      },
      {
        value: `/model ${model.model}`,
        label: model.model,
        description: `${description} model id`,
        category: "model" as const,
      },
    ];
  });
}

function reasoningCompletions(_ctx: SlashCommandContext, input: string): SlashCompletion[] {
  const thinkingQuery = commandArgument(input, "thinking");
  const reasoningQuery = commandArgument(input, "reasoning");
  const query = thinkingQuery ?? reasoningQuery;
  if (query === undefined) return [];
  const command = thinkingQuery !== undefined ? "thinking" : "reasoning";
  const normalized = query.trim().toLowerCase();
  const candidates: { value: ReasoningLevel | "hide" | "show"; description: string }[] = [
    ...REASONING_LEVELS.map((value) => ({ value, description: reasoningDescription(value) })),
    { value: "hide", description: "Hide thinking traces" },
    { value: "show", description: "Show thinking traces" },
  ];
  return candidates
    .filter((candidate) => !normalized || candidate.value.startsWith(normalized) || fuzzyMatch(candidate.value, normalized))
    .map((candidate) => ({
      value: `/${command} ${candidate.value}`,
      label: candidate.value,
      description: candidate.description,
      category: "model" as const,
    }));
}

const MCP_SUBCOMMANDS: Array<{ value: string; description: string }> = [
  { value: "status", description: "Show server health and tool counts" },
  { value: "list", description: "List configured MCP servers" },
  { value: "tools", description: "List tools for one MCP server" },
  { value: "reload", description: "Reload MCP configuration" },
  { value: "auth", description: "Authenticate one MCP server" },
  { value: "logout", description: "Clear MCP auth for one server" },
  { value: "add", description: "Add a remote HTTP or SSE MCP server" },
  { value: "remove", description: "Remove a user MCP server" },
];

function mcpCompletions(ctx: SlashCommandContext, input: string): SlashCompletion[] {
  const query = commandArgument(input, "mcp");
  if (query === undefined) return [];
  const tokens = query.trimStart().split(/\s+/).filter(Boolean);
  const action = tokens[0]?.toLowerCase();
  const commandText = query.trimStart();

  if (serverNameCompletingAction(action, commandText)) {
    const serverQuery = query.endsWith(" ") ? "" : tokens[tokens.length - 1]?.toLowerCase() ?? "";
    return (ctx.mcpServers ?? [])
      .filter((server) => !serverQuery || fuzzyMatch(server.name.toLowerCase(), serverQuery))
      .slice(0, 8)
      .map((server) => ({
        value: `/mcp ${action} ${server.name}`,
        label: server.name,
        description: `${server.status} ${server.transport ?? "mcp"} tools=${server.toolCount ?? "?"}`,
        category: "mcp" as const,
      }));
  }

  const normalized = query.trim().toLowerCase();
  return MCP_SUBCOMMANDS
    .filter((candidate) => !normalized || candidate.value.startsWith(normalized) || fuzzyMatch(candidate.value, normalized))
    .map((candidate) => ({
      value: `/mcp ${candidate.value}`,
      label: `/mcp ${candidate.value}`,
      description: candidate.description,
      category: "mcp" as const,
    }));
}

function serverNameCompletingAction(action: string | undefined, commandText: string): action is "status" | "tools" | "auth" | "logout" | "remove" {
  return (
    action === "status" ||
    action === "tools" ||
    action === "auth" ||
    action === "logout" ||
    action === "remove"
  ) && (commandText.endsWith(" ") || commandText.split(/\s+/).length > 1);
}

function mcpResult(args: string): SlashCommandResult {
  const tokens = parseMcpTokens(args);
  if (!tokens.ok) return localMcpError(tokens.error);
  const [rawAction, ...rest] = tokens.tokens;
  if (!rawAction) return { type: "open_view", view: "mcp" };
  const action = (rawAction ?? "status").toLowerCase();

  if (action === "list") return noExtraMcpArgs(action, rest) ?? { type: "mcp_action", action: "list" };
  if (action === "reload") return noExtraMcpArgs(action, rest) ?? { type: "mcp_action", action: "reload" };
  if (action === "status" || action === "server" || action === "show") {
    const parsed = parseOptionalServerAction("status", rest);
    return parsed.ok ? { type: "mcp_action", action: "status", ...(parsed.server ? { server: parsed.server } : {}) } : localMcpError(parsed.error);
  }
  if (action === "tools") return requiredServerResult("tools", rest);
  if (action === "remove") return requiredServerResult("remove", rest);
  if (action === "logout") return requiredServerResult("logout", rest);
  if (action === "auth" || action === "login") {
    const parsed = parseMcpAuth(rest);
    return parsed.ok
      ? { type: "mcp_action", action: "auth", server: parsed.server, ...(parsed.request ? { request: parsed.request } : {}) }
      : localMcpError(parsed.error);
  }
  if (action === "add") {
    const parsed = parseMcpAdd(rest);
    return parsed.ok ? { type: "mcp_action", action: "add", input: parsed.input } : localMcpError(parsed.error);
  }

  return localMcpError(`Unknown MCP command: ${rawAction}\nUsage: /mcp [status|list|tools|reload|add|remove|auth|logout]`);
}

function noExtraMcpArgs(action: string, rest: readonly string[]): SlashCommandResult | undefined {
  if (rest.length === 0) return undefined;
  return localMcpError(`Unexpected /mcp ${action} argument: ${rest.join(" ")}`);
}

function requiredServerResult(action: "tools" | "remove" | "logout", rest: readonly string[]): SlashCommandResult {
  const parsed = parseRequiredServerAction(action, rest);
  return parsed.ok ? { type: "mcp_action", action, server: parsed.server } : localMcpError(parsed.error);
}

function parseOptionalServerAction(action: string, rest: readonly string[]): { ok: true; server?: string } | { ok: false; error: string } {
  if (rest.length > 1) return { ok: false, error: `Unexpected /mcp ${action} argument: ${rest.slice(1).join(" ")}` };
  const server = rest[0];
  return { ok: true, ...(server ? { server } : {}) };
}

function parseRequiredServerAction(action: string, rest: readonly string[]): { ok: true; server: string } | { ok: false; error: string } {
  const server = rest[0];
  if (!server) return { ok: false, error: `Usage: /mcp ${action} <server>` };
  if (rest.length > 1) return { ok: false, error: `Unexpected /mcp ${action} argument: ${rest.slice(1).join(" ")}` };
  return { ok: true, server };
}

function parseMcpAuth(rest: readonly string[]): { ok: true; server: string; request?: RuntimeMcpAuthRequest } | { ok: false; error: string } {
  const server = rest[0];
  if (!server) return { ok: false, error: "Usage: /mcp auth <server> [--callback-url <url>] [--scope <scope>]" };
  const request: RuntimeMcpAuthRequest = {};
  for (let index = 1; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (token === "--callback-url") {
      const value = rest[index + 1];
      if (!value) return { ok: false, error: "--callback-url requires a value" };
      request.callbackUrl = value;
      index += 1;
      continue;
    }
    if (token === "--scope") {
      const value = rest[index + 1];
      if (!value) return { ok: false, error: "--scope requires a value" };
      request.scopes = [...(request.scopes ?? []), value];
      index += 1;
      continue;
    }
    return { ok: false, error: token.startsWith("-") ? `Unknown /mcp auth option: ${token}` : `Unexpected /mcp auth argument: ${token}` };
  }
  return { ok: true, server, ...(Object.keys(request).length > 0 ? { request } : {}) };
}

function parseMcpAdd(rest: readonly string[]): { ok: true; input: RuntimeMcpAddServerRequest } | { ok: false; error: string } {
  const name = rest[0];
  if (!name) return { ok: false, error: "Usage: /mcp add <name> --url <url> [--transport http|sse] [--description <text>]" };
  const input: RuntimeMcpAddServerRequest = { name };
  const blockedStdioOptions: string[] = [];
  for (let index = 1; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (token === "--transport") {
      const value = rest[index + 1];
      if (!value) return { ok: false, error: "--transport requires a value" };
      const transport = parseMcpTransport(value);
      if (!transport.ok) return transport;
      input.transport = transport.value;
      index += 1;
      continue;
    }
    if (token === "--url") {
      const value = rest[index + 1];
      if (!value) return { ok: false, error: "--url requires a value" };
      input.url = value;
      index += 1;
      continue;
    }
    if (token === "--description") {
      const value = rest[index + 1];
      if (!value) return { ok: false, error: "--description requires a value" };
      input.description = value;
      index += 1;
      continue;
    }
    if (token === "--enable" || token === "--enabled") {
      input.enabled = true;
      continue;
    }
    if (token === "--disable" || token === "--disabled") {
      input.enabled = false;
      continue;
    }
    if (token === "--command" || token === "--arg" || token === "--env") {
      blockedStdioOptions.push(token);
      const next = rest[index + 1];
      if (next && !next.startsWith("--")) index += 1;
      continue;
    }
    return { ok: false, error: token.startsWith("-") ? `Unknown /mcp add option: ${token}` : `Unexpected /mcp add argument: ${token}` };
  }

  if (blockedStdioOptions.length > 0 || input.transport === "stdio") {
    return {
      ok: false,
      error: "TUI can add remote HTTP/SSE MCP servers only. Use `chili mcp add ... --command ...` for local stdio servers.",
    };
  }
  if (!input.url) return { ok: false, error: "/mcp add requires --url for remote MCP servers." };
  if (!input.transport) input.transport = "http";
  return { ok: true, input };
}

function parseMcpTransport(value: string): { ok: true; value: RuntimeMcpTransport } | { ok: false; error: string } {
  if (value === "http" || value === "sse" || value === "stdio") return { ok: true, value };
  return { ok: false, error: "--transport must be http or sse in the TUI" };
}

function parseMcpTokens(input: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote) return { ok: false, error: `Unclosed quote in /mcp arguments.` };
  if (current) tokens.push(current);
  return { ok: true, tokens };
}

function localMcpError(text: string): SlashCommandResult {
  return { type: "local_message", level: "error", text };
}

function skillToggleCompletions(action: "enable" | "disable"): (ctx: SlashCommandContext, input: string) => SlashCompletion[] {
  return (ctx, input) => {
    const query = commandArgument(input, `skills ${action}`);
    if (query === undefined) return [];

    const parsed = parseSkillToggleCompletionQuery(query);
    const normalized = parsed.query.toLowerCase();
    return skillToggleCandidates(ctx, action)
      .filter((skill) => !normalized || skillMatches(skill, normalized))
      .slice(0, 8)
      .map((skill) => ({
        value: `/skills ${action}${parsed.scope ? ` --${parsed.scope}` : ""} ${skill.name}`,
        label: `$${skill.name}`,
        description: skillToggleDescription(skill),
        category: "skills" as const,
      }));
  };
}

function skillToggleResult(action: "enable" | "disable", args: string): LocalMessageResult | { type: "skills_action"; action: "enable" | "disable"; name: string; scope?: SkillSettingsScope } {
  const parsed = parseSkillToggleArgs(args);
  if (!parsed.ok) {
    return {
      type: "local_message",
      level: "error",
      text: parsed.error,
    };
  }
  return {
    type: "skills_action",
    action,
    name: parsed.name,
    ...(parsed.scope ? { scope: parsed.scope } : {}),
  };
}

type LocalMessageResult = { type: "local_message"; level: "error"; text: string };
type SkillToggleArgs = { ok: true; name: string; scope?: SkillSettingsScope } | { ok: false; error: string; scope?: SkillSettingsScope };

function parseSkillToggleArgs(args: string): SkillToggleArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const names: string[] = [];
  let scope: SkillSettingsScope | undefined;

  for (const token of tokens) {
    if (token === "--user" || token === "--project") {
      scope = token.slice(2) as SkillSettingsScope;
      continue;
    }
    if (token.startsWith("--")) {
      return skillToggleError(`Unknown skills option: ${token}`, scope);
    }
    names.push(token);
  }

  if (names.length === 0) return skillToggleError("Usage: /skills enable|disable [--user|--project] <name>", scope);
  if (names.length > 1) return skillToggleError(`Expected one skill name, got: ${names.join(" ")}`, scope);
  return {
    ok: true,
    name: names[0] ?? "",
    ...(scope ? { scope } : {}),
  };
}

function skillToggleError(error: string, scope: SkillSettingsScope | undefined): SkillToggleArgs {
  return {
    ok: false,
    error,
    ...(scope ? { scope } : {}),
  };
}

function parseSkillToggleCompletionQuery(query: string): { query: string; scope?: SkillSettingsScope } {
  const tokens = query.trimStart().split(/\s+/).filter(Boolean);
  let scope: SkillSettingsScope | undefined;
  const names: string[] = [];
  for (const token of tokens) {
    if (token === "--user" || token === "--project") {
      scope = token.slice(2) as SkillSettingsScope;
      continue;
    }
    if (token.startsWith("--")) continue;
    names.push(token);
  }
  if (query.endsWith(" ")) return { query: "", ...(scope ? { scope } : {}) };
  return {
    query: names[names.length - 1] ?? "",
    ...(scope ? { scope } : {}),
  };
}

function skillToggleCandidates(ctx: SlashCommandContext, action: "enable" | "disable"): SkillSummary[] {
  const skills = [...(ctx.allSkills ?? ctx.skills ?? [])]
    .filter((skill) => skill.hidden !== true)
    .sort((left, right) => left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath));
  if (action === "enable") return skills.filter((skill) => skill.disabled === true);
  return skills.filter((skill) => skill.disabled !== true);
}

function skillMatches(skill: SkillSummary, query: string): boolean {
  const haystack = `${skill.name} ${skill.description} ${skill.source} ${skill.baseDir} ${skill.filePath}`.toLowerCase();
  return haystack.includes(query) || fuzzyMatch(haystack, query);
}

function skillToggleDescription(skill: SkillSummary): string {
  const status = skill.disabled ? "disabled" : "enabled";
  const skillPath = (skill.baseDir || skill.filePath).replace(/\/SKILL\.md$/, "");
  return `${skill.source} ${status} ${skillPath}`;
}

function commandArgument(input: string, command: string): string | undefined {
  if (input === `${command} `) return "";
  if (input.startsWith(`${command} `)) return input.slice(command.length + 1);
  return undefined;
}

function modelCandidates(ctx: SlashCommandContext) {
  return ctx.modelCandidates ?? defaultModelCandidates();
}

function reasoningDescription(level: ReasoningLevel): string {
  switch (level) {
    case "off":
      return "No reasoning";
    case "minimal":
      return "Very brief reasoning";
    case "low":
      return "Light reasoning";
    case "medium":
      return "Moderate reasoning";
    case "high":
      return "Deep reasoning";
    case "xhigh":
      return "Maximum reasoning";
  }
}
