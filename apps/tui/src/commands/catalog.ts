import {
  bindBuiltinCommands,
  createCommandRegistry,
  importRuntimeCommandCatalog,
  splitCommandArguments,
  type CommandCompletionInput,
  type CommandSuggestion,
} from "@chili/commands";
import type { RuntimeCommandCatalog, RuntimeMcpAddServerRequest, RuntimeMcpAuthRequest, RuntimeMcpTransport } from "@chili/protocol";
import type { SkillSettingsScope, SkillSummary } from "@chili/skills";
import {
  REASONING_LEVELS,
  defaultModelCandidates,
  isReasoningLevel,
  modelDescriptorSelection,
  modelSelectionLabel,
  parseModelCommand,
  type ReasoningLevel,
} from "../model-state.js";
import type { TuiCommand, TuiCommandContext, TuiCommandResult } from "./types.js";

const idle = (context: TuiCommandContext) => context.busy
  ? { enabled: false, reason: "Wait for the active turn to finish." }
  : { enabled: true };

export function createTuiCommandRegistry(runtimeCatalog?: RuntimeCommandCatalog) {
  const builtins = bindBuiltinCommands<TuiCommandContext, TuiCommandResult>({
    help: { run: () => ({ type: "open_view", view: "help" }) },
    status: { run: () => ({ type: "open_view", view: "status" }) },
    theme: { run: () => ({ type: "open_theme_picker" }) },
    permissions: { run: () => ({ type: "open_permissions_picker" }) },
    rename: {
      run: (_context, input) => input.raw.trim()
        ? { type: "rename_session", title: input.raw.trim().replace(/\s+/g, " ") }
        : { type: "open_rename_prompt" },
    },
    model: { run: () => ({ type: "open_model_picker" }) },
    "model.select": { complete: modelCompletions, run: modelResult },
    "model.service": {
      complete: choiceCompletions("model", [
        ["standard", "Use standard service"],
        ["fast", "Use fast service"],
      ]),
      run: (context, input) => {
        if (context.serviceTierConfigurable === false) {
          return localError("Service tiers are not available for the selected model.");
        }
        return input.raw === "standard" || input.raw === "fast"
          ? { type: "set_service_tier", serviceTier: input.raw }
          : localError(`Unknown service tier: ${input.raw}`);
      },
    },
    thinking: { run: () => ({ type: "open_reasoning_picker" }) },
    "thinking.effort": {
      complete: reasoningCompletions,
      run: (context, input) => {
        const level = input.raw.trim().toLowerCase();
        if (!isReasoningLevel(level)) return localError(`Unknown reasoning effort: ${input.raw}`);
        if (context.availableReasoningLevels && !context.availableReasoningLevels.includes(level)) {
          return localError(`${level} reasoning is not available for the selected model.`);
        }
        return { type: "set_reasoning", level };
      },
    },
    "thinking.traces": {
      complete: choiceCompletions("model", [["show", "Show thinking traces"], ["hide", "Hide thinking traces"]]),
      run: (_context, input) => input.raw === "show" || input.raw === "hide"
        ? { type: "set_hide_thinking", hidden: input.raw === "hide" }
        : localError(`Unknown trace visibility: ${input.raw}`),
    },
    session: { run: () => ({ type: "open_resume_picker" }) },
    "session.new": { available: idle, run: () => confirm("Start a new session?", { type: "new_session" }) },
    "session.list": { run: () => ({ type: "open_resume_picker" }) },
    "session.resume": {
      available: idle,
      run: (_context, input) => input.raw.trim()
        ? { type: "resume_session", target: input.raw.trim() }
        : { type: "open_resume_picker" },
    },
    "session.rename": {
      run: (_context, input) => input.raw.trim()
        ? { type: "rename_session", title: input.raw.trim().replace(/\s+/g, " ") }
        : { type: "open_rename_prompt" },
    },
    "session.delegation": {
      complete: choiceCompletions("session", [
        ["off", "Disable delegation for this session"],
        ["explicit", "Delegate only when explicitly requested"],
        ["proactive", "Allow proactive parallel delegation"],
        ["status", "Show the effective delegation policy"],
      ]),
      run: (_context, input) => delegationResult(input.raw),
    },
    agents: { run: () => ({ type: "open_view", view: "agents" }) },
    "agents.list": { run: () => ({ type: "open_view", view: "agents" }) },
    "agents.stop": { run: (_context, input) => agentActionResult("stop", input.raw) },
    "agents.resume": { run: (_context, input) => agentActionResult("resume", input.raw) },
    auth: { run: () => authResult("status") },
    "auth.status": { run: () => authResult("status") },
    "auth.login": { available: idle, run: () => authResult("login") },
    "auth.logout": { available: idle, run: () => confirm("Log out from ChatGPT Codex?", authResult("logout")) },
    skills: { run: () => ({ type: "insert_prompt", text: "$" }) },
    "skills.browse": { run: () => ({ type: "insert_prompt", text: "$" }) },
    "skills.enable": { complete: skillCompletions("enable"), run: (_context, input) => skillResult("enable", input.raw) },
    "skills.disable": { complete: skillCompletions("disable"), run: (_context, input) => skillResult("disable", input.raw) },
    "skills.reload": { run: () => ({ type: "reload_skills" }) },
    mcp: { run: () => ({ type: "open_view", view: "mcp" }) },
    "mcp.status": { complete: serverCompletions, run: (_context, input) => ({ type: "mcp_action", action: "status", ...(input.raw.trim() ? { server: input.raw.trim() } : {}) }) },
    "mcp.tools": { complete: serverCompletions, run: (_context, input) => serverResult("tools", input.raw) },
    "mcp.reload": { run: () => ({ type: "mcp_action", action: "reload" }) },
    "mcp.add": { run: (_context, input) => mcpAddResult(input.raw) },
    "mcp.remove": { complete: serverCompletions, run: (_context, input) => confirm(`Remove MCP server ${input.raw.trim()}?`, serverResult("remove", input.raw)) },
    "mcp.auth": { complete: serverCompletions, run: (_context, input) => mcpAuthResult(input.raw) },
    "mcp.logout": { complete: serverCompletions, run: (_context, input) => confirm(`Log out MCP server ${input.raw.trim()}?`, serverResult("logout", input.raw)) },
    commands: { run: () => ({ type: "open_view", view: "help" }) },
    "commands.reload": { run: () => ({ type: "reload_commands" }) },
    "commands.diagnostics": { run: (context) => diagnosticsResult(context) },
    "app.exit": { run: () => confirm("Exit Chili?", { type: "exit_app" }) },
  });
  const runtime = runtimeCatalog
    ? importRuntimeCommandCatalog<TuiCommandContext, TuiCommandResult>(runtimeCatalog, (node, _context, input) => ({
      type: "submit_command",
      commandId: node.id,
      args: input.raw,
    }))
    : [];
  return createCommandRegistry<TuiCommandContext, TuiCommandResult>([...builtins, ...runtime]);
}

export function tuiCommands(runtimeCatalog?: RuntimeCommandCatalog): readonly TuiCommand[] {
  return createTuiCommandRegistry(runtimeCatalog).roots();
}

function modelResult(context: TuiCommandContext, input: { raw: string }): TuiCommandResult {
  const match = parseModelCommand(input.raw, modelCandidates(context));
  if (!match.selection) return { type: "open_model_picker", ...(match.query ? { query: match.query } : {}) };
  return { type: "set_model", selection: match.selection, ...(match.reasoningLevel ? { reasoningLevel: match.reasoningLevel } : {}) };
}

function modelCompletions(context: TuiCommandContext, input: CommandCompletionInput): CommandSuggestion[] {
  const query = input.query.toLowerCase();
  return modelCandidates(context)
    .filter((model) => !query || fuzzy(`${model.provider} ${model.model} ${model.displayName ?? ""}`.toLowerCase(), query))
    .slice(0, 64)
    .map((model) => {
      const value = modelSelectionLabel(modelDescriptorSelection(model));
      return suggestion(`${input.invocation} ${value}`, value, model.provider, "model");
    });
}

function choiceCompletions(group: string, choices: readonly (readonly [string, string])[]) {
  return (_context: TuiCommandContext, input: CommandCompletionInput) => choices
    .filter(([value]) => !input.query || fuzzy(value, input.query.toLowerCase()))
    .map(([value, description]) => suggestion(`${input.invocation} ${value}`, value, description, group));
}

function reasoningCompletions(context: TuiCommandContext, input: CommandCompletionInput): CommandSuggestion[] {
  const levels = context.availableReasoningLevels ?? REASONING_LEVELS;
  return choiceCompletions(
    "model",
    levels.map((level) => [level, reasoningDescription(level)] as const),
  )(context, input);
}

function serverCompletions(context: TuiCommandContext, input: CommandCompletionInput): CommandSuggestion[] {
  const query = input.query.toLowerCase();
  return (context.mcpServers ?? [])
    .filter((server) => !query || fuzzy(server.name.toLowerCase(), query))
    .map((server) => suggestion(
      `${input.invocation} ${server.name}`,
      server.name,
      `${server.status} ${server.transport ?? "mcp"} tools=${server.toolCount ?? "?"}`,
      "mcp",
    ));
}

function skillCompletions(action: "enable" | "disable") {
  return (context: TuiCommandContext, input: CommandCompletionInput): CommandSuggestion[] => {
    const parsed = parseSkillArgs(input.raw, false);
    const query = parsed.ok ? parsed.name.toLowerCase() : "";
    const scope = parsed.ok ? parsed.scope : undefined;
    return skillCandidates(context, action)
      .filter((skill) => !query || fuzzy(`${skill.name} ${skill.description}`.toLowerCase(), query))
      .slice(0, 16)
      .map((skill) => suggestion(
        `${input.invocation}${scope ? ` --${scope}` : ""} ${skill.name}`,
        `$${skill.name}`,
        `${skill.source} ${skill.disabled ? "disabled" : "enabled"}`,
        "skills",
      ));
  };
}

function suggestion(value: string, label: string, description: string, group: string): CommandSuggestion {
  return {
    id: value,
    value,
    label,
    description,
    group,
    source: "builtin",
    argumentHint: "",
    hidden: false,
    enabled: true,
    intent: "execute",
  };
}

function skillResult(action: "enable" | "disable", raw: string): TuiCommandResult {
  const parsed = parseSkillArgs(raw, true);
  return parsed.ok
    ? { type: "skills_action", action, name: parsed.name, ...(parsed.scope ? { scope: parsed.scope } : {}) }
    : localError(parsed.error);
}

function parseSkillArgs(raw: string, required: boolean):
  | { ok: true; name: string; scope?: SkillSettingsScope }
  | { ok: false; error: string } {
  const names: string[] = [];
  let scope: SkillSettingsScope | undefined;
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    if (token === "--user" || token === "--project") scope = token.slice(2) as SkillSettingsScope;
    else if (token.startsWith("--")) return { ok: false, error: `Unknown skills option: ${token}` };
    else names.push(token);
  }
  if (required && names.length === 0) return { ok: false, error: "Skill name is required." };
  if (names.length > 1) return { ok: false, error: `Expected one skill name, got: ${names.join(" ")}` };
  return { ok: true, name: names[0] ?? "", ...(scope ? { scope } : {}) };
}

function skillCandidates(context: TuiCommandContext, action: "enable" | "disable"): SkillSummary[] {
  return [...(context.allSkills ?? context.skills ?? [])]
    .filter((skill) => skill.hidden !== true && (action === "enable" ? skill.disabled === true : skill.disabled !== true))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function serverResult(action: "tools" | "remove" | "logout", raw: string): TuiCommandResult {
  const server = raw.trim();
  return server ? { type: "mcp_action", action, server } : localError(`MCP ${action} requires a server.`);
}

function mcpAuthResult(raw: string): TuiCommandResult {
  const tokens = splitCommandArguments(raw);
  const server = tokens.shift();
  if (!server) return localError("MCP auth requires a server.");
  const request: RuntimeMcpAuthRequest = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const value = tokens[index + 1];
    if (token === "--callback-url" && value) {
      request.callbackUrl = value;
      index += 1;
    } else if (token === "--scope" && value) {
      request.scopes = [...(request.scopes ?? []), value];
      index += 1;
    } else {
      return localError(`Unknown MCP auth option: ${token ?? ""}`);
    }
  }
  return { type: "mcp_action", action: "auth", server, ...(Object.keys(request).length ? { request } : {}) };
}

function mcpAddResult(raw: string): TuiCommandResult {
  const tokens = splitCommandArguments(raw);
  const name = tokens.shift();
  if (!name) return localError("MCP add requires a name.");
  const input: RuntimeMcpAddServerRequest = { name };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const value = tokens[index + 1];
    if (token === "--url" && value) {
      input.url = value;
      index += 1;
    } else if (token === "--transport" && value) {
      if (value !== "http" && value !== "sse") return localError("TUI supports HTTP/SSE MCP servers only.");
      input.transport = value as RuntimeMcpTransport;
      index += 1;
    } else if (token === "--description" && value) {
      input.description = value;
      index += 1;
    } else if (token === "--enable" || token === "--enabled") input.enabled = true;
    else if (token === "--disable" || token === "--disabled") input.enabled = false;
    else if (token === "--command" || token === "--arg" || token === "--env") {
      return localError("TUI can add remote HTTP/SSE MCP servers only. Use the CLI for local stdio servers.");
    } else return localError(`Unknown MCP add option: ${token ?? ""}`);
  }
  if (!input.url) return localError("MCP add requires --url.");
  input.transport ??= "http";
  return { type: "mcp_action", action: "add", input };
}

function diagnosticsResult(context: TuiCommandContext): TuiCommandResult {
  const diagnostics = context.commandDiagnostics ?? [];
  return {
    type: "local_message",
    level: diagnostics.some((diagnostic) => diagnostic.level === "error") ? "error" : "info",
    text: diagnostics.length
      ? diagnostics.map((diagnostic) => `[${diagnostic.level}] ${diagnostic.message}`).join("\n")
      : "No command diagnostics.",
  };
}

function confirm(title: string, result: TuiCommandResult): TuiCommandResult {
  return { type: "confirm", title, result };
}

function authResult(action: "login" | "logout" | "status"): TuiCommandResult {
  return { type: "auth_action", action, provider: "openai-codex" };
}

function delegationResult(raw: string): TuiCommandResult {
  const policy = raw.trim().toLowerCase();
  if (!policy || policy === "status") return { type: "delegation_action", action: "status" };
  if (policy === "off" || policy === "explicit" || policy === "proactive") {
    return { type: "delegation_action", action: "set", policy };
  }
  return localError(`Unknown delegation policy: ${raw.trim() || "none"}. Use off, explicit, proactive, or status.`);
}

function localError(text: string): TuiCommandResult {
  return { type: "local_message", level: "error", text };
}

function modelCandidates(context: TuiCommandContext) {
  return context.modelCandidates ?? defaultModelCandidates();
}

function fuzzy(value: string, query: string): boolean {
  let index = 0;
  for (const char of query) {
    index = value.indexOf(char, index);
    if (index < 0) return false;
    index += 1;
  }
  return true;
}

function reasoningDescription(level: ReasoningLevel): string {
  switch (level) {
    case "off": return "No reasoning";
    case "minimal": return "Very brief reasoning";
    case "low": return "Light reasoning";
    case "medium": return "Moderate reasoning";
    case "high": return "Deep reasoning";
    case "xhigh": return "Maximum reasoning";
    case "max": return "Maximum reasoning for the hardest problems";
    case "ultra": return "Maximum reasoning with proactive agents";
  }
}

function agentActionResult(action: "stop" | "resume", raw: string): TuiCommandResult {
  const agentId = raw.trim();
  return agentId ? { type: "agent_action", action, agentId } : localError(`Agent ${action} requires an agent id.`);
}
