import { expect, test } from "bun:test";
import { createDefaultSlashCommands, resolveSlashCommand, slashCompletions } from "./registry.js";
import type { SlashCommandContext } from "./types.js";
import type { SkillSummary } from "@chili/skills";

test("resolves ChatGPT Codex auth slash commands", async () => {
  const commands = createDefaultSlashCommands();
  const ctx = { model: {} } as SlashCommandContext;

  expect(await resolveSlashCommand(commands, "/login")?.command.run(ctx, "")).toEqual({
    type: "auth_action",
    action: "login",
    provider: "openai-codex",
  });
  expect(await resolveSlashCommand(commands, "/logout")?.command.run(ctx, "")).toEqual({
    type: "auth_action",
    action: "logout",
    provider: "openai-codex",
  });
  expect(await resolveSlashCommand(commands, "/auth")?.command.run(ctx, "")).toEqual({
    type: "auth_action",
    action: "status",
    provider: "openai-codex",
  });
});

test("includes auth commands in slash completions", () => {
  const completions = slashCompletions(createDefaultSlashCommands(), { model: {} } as SlashCommandContext, "/lo", 8);
  expect(completions.map((completion) => completion.value)).toContain("/login");
});

test("sorts prefix slash completions before fuzzy matches", () => {
  const completions = slashCompletions(createDefaultSlashCommands(), { model: {} } as SlashCommandContext, "/mo", 8);
  expect(completions[0]?.value).toBe("/model");
  expect(completions.map((completion) => completion.value)).toContain("/commands reload");
});

test("resolves commands view and reload slash commands", async () => {
  const commands = createDefaultSlashCommands();
  const ctx = { model: {} } as SlashCommandContext;

  expect(await resolveSlashCommand(commands, "/commands")?.command.run(ctx, "")).toEqual({
    type: "open_view",
    view: "help",
  });
  expect(await resolveSlashCommand(commands, "/commands reload")?.command.run(ctx, "")).toEqual({
    type: "reload_commands",
  });
});

test("resolves MCP slash commands and remote add arguments", async () => {
  const commands = createDefaultSlashCommands();
  const ctx = { model: {} } as SlashCommandContext;

  expect(await resolveSlashCommand(commands, "/mcp")?.command.run(ctx, "")).toEqual({
    type: "open_view",
    view: "mcp",
  });
  expect(await resolveSlashCommand(commands, "/mcp status github")?.command.run(ctx, "status github")).toEqual({
    type: "mcp_action",
    action: "status",
    server: "github",
  });
  expect(await resolveSlashCommand(commands, "/mcp tools github")?.command.run(ctx, "tools github")).toEqual({
    type: "mcp_action",
    action: "tools",
    server: "github",
  });
  expect(await resolveSlashCommand(commands, "/mcp auth github --callback-url http://localhost/cb --scope repo --scope read:user")?.command.run(ctx, "auth github --callback-url http://localhost/cb --scope repo --scope read:user")).toEqual({
    type: "mcp_action",
    action: "auth",
    server: "github",
    request: {
      callbackUrl: "http://localhost/cb",
      scopes: ["repo", "read:user"],
    },
  });
  expect(await resolveSlashCommand(commands, "/mcp add github --url https://example.test/mcp --transport sse --description \"GitHub MCP\" --disable")?.command.run(ctx, "add github --url https://example.test/mcp --transport sse --description \"GitHub MCP\" --disable")).toEqual({
    type: "mcp_action",
    action: "add",
    input: {
      name: "github",
      url: "https://example.test/mcp",
      transport: "sse",
      description: "GitHub MCP",
      enabled: false,
    },
  });
});

test("MCP slash command blocks local stdio add from the TUI", async () => {
  const commands = createDefaultSlashCommands();
  const ctx = { model: {} } as SlashCommandContext;

  expect(await resolveSlashCommand(commands, "/mcp add local --command npx")?.command.run(ctx, "add local --command npx")).toEqual({
    type: "local_message",
    level: "error",
    text: "TUI can add remote HTTP/SSE MCP servers only. Use `chili mcp add ... --command ...` for local stdio servers.",
  });
});

test("completes MCP subcommands and server names", () => {
  const commands = createDefaultSlashCommands();
  const ctx = {
    model: {},
    mcpServers: [
      { name: "github", status: "running", enabled: true, transport: "http", toolCount: 3 },
      { name: "filesystem", status: "disabled", enabled: false, transport: "stdio", toolCount: 0 },
    ],
  } as unknown as SlashCommandContext;

  expect(slashCompletions(commands, ctx, "/mcp t", 8).map((completion) => completion.value)).toContain("/mcp tools");
  expect(slashCompletions(commands, ctx, "/mcp tools g", 8).map((completion) => completion.value)).toContain("/mcp tools github");
  expect(slashCompletions(commands, ctx, "/mc", 8).map((completion) => completion.value)).toContain("/mcp");
});

test("resolves goal slash commands without lowercasing objectives", async () => {
  const commands = createDefaultSlashCommands();
  const ctx = { model: {} } as SlashCommandContext;
  const match = resolveSlashCommand(commands, "/goal Ship The Goal --budget 50k");

  expect(match?.args).toBe("Ship The Goal --budget 50k");
  expect(await match?.command.run(ctx, match.args)).toEqual({
    type: "goal_action",
    action: "set",
    objective: "Ship The Goal",
    tokenBudget: 50_000,
  });
  expect(await resolveSlashCommand(commands, "/goal pause")?.command.run(ctx, "pause")).toEqual({
    type: "goal_action",
    action: "pause",
  });
  expect(await resolveSlashCommand(commands, "/goal")?.command.run(ctx, "")).toEqual({
    type: "goal_action",
    action: "show",
  });
});

test("resolves permissions slash commands to the permissions picker", async () => {
  const commands = createDefaultSlashCommands();
  const ctx = { model: {} } as SlashCommandContext;

  expect(await resolveSlashCommand(commands, "/permissions")?.command.run(ctx, "")).toEqual({
    type: "open_permissions_picker",
  });
  expect(await resolveSlashCommand(commands, "/approvals")?.command.run(ctx, "")).toEqual({
    type: "open_permissions_picker",
  });
  expect(slashCompletions(commands, ctx, "/per", 8).map((completion) => completion.value)).toContain("/permissions");
  expect(slashCompletions(commands, ctx, "/app", 8).map((completion) => completion.value)).toContain("/approvals");
});

test("resolves model slash command to model selection actions", async () => {
  const commands = createDefaultSlashCommands();
  const ctx = {
    model: {},
    modelCandidates: [
      { provider: "openai-codex", model: "gpt-5.5", displayName: "GPT-5.5" },
      { provider: "openai-codex", model: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
    ],
  } as unknown as SlashCommandContext;

  expect(await resolveSlashCommand(commands, "/model openai-codex/gpt-5.3-codex:high")?.command.run(ctx, "openai-codex/gpt-5.3-codex:high")).toEqual({
    type: "set_model",
    selection: { provider: "openai-codex", model: "gpt-5.3-codex" },
    reasoningLevel: "high",
  });
  expect(await resolveSlashCommand(commands, "/model")?.command.run(ctx, "")).toEqual({
    type: "open_model_picker",
  });
});

test("resolves thinking slash command and completions", async () => {
  const commands = createDefaultSlashCommands();
  const ctx = { model: {} } as SlashCommandContext;

  expect(await resolveSlashCommand(commands, "/thinking xhigh")?.command.run(ctx, "xhigh")).toEqual({
    type: "set_reasoning",
    level: "xhigh",
  });
  expect(await resolveSlashCommand(commands, "/thinking hide")?.command.run(ctx, "hide")).toEqual({
    type: "set_hide_thinking",
    hidden: true,
  });
  expect(await resolveSlashCommand(commands, "/reasoning show")?.command.run(ctx, "show")).toEqual({
    type: "set_hide_thinking",
    hidden: false,
  });
  expect(await resolveSlashCommand(commands, "/hide-thinking")?.command.run(ctx, "")).toEqual({
    type: "set_hide_thinking",
    hidden: true,
  });
  expect(await resolveSlashCommand(commands, "/show-thinking")?.command.run(ctx, "")).toEqual({
    type: "set_hide_thinking",
    hidden: false,
  });
  expect(await resolveSlashCommand(commands, "/reasoning")?.command.run(ctx, "")).toEqual({
    type: "open_reasoning_picker",
  });
  expect(slashCompletions(commands, ctx, "/thinking h", 8).map((completion) => completion.value)).toContain("/thinking high");
  expect(slashCompletions(commands, ctx, "/thinking h", 8).map((completion) => completion.value)).toContain("/thinking hide");
  expect(slashCompletions(commands, ctx, "/hide", 8).map((completion) => completion.value)).toContain("/hide-thinking");
  expect(slashCompletions(commands, ctx, "/show", 8).map((completion) => completion.value)).toContain("/show-thinking");
});

test("resolves skills enable and disable commands", async () => {
  const commands = createDefaultSlashCommands();
  const ctx = { model: {} } as SlashCommandContext;

  expect(await resolveSlashCommand(commands, "/skills disable reviewer")?.command.run(ctx, "reviewer")).toEqual({
    type: "skills_action",
    action: "disable",
    name: "reviewer",
  });
  expect(await resolveSlashCommand(commands, "/skills enable --user reviewer")?.command.run(ctx, "--user reviewer")).toEqual({
    type: "skills_action",
    action: "enable",
    name: "reviewer",
    scope: "user",
  });
});

test("completes skills enable and disable from skill state", () => {
  const commands = createDefaultSlashCommands();
  const ctx = {
    model: {},
    skills: [skillSummary("reviewer")],
    allSkills: [
      skillSummary("reviewer"),
      skillSummary("writer", { disabled: true }),
    ],
  } as unknown as SlashCommandContext;

  expect(slashCompletions(commands, ctx, "/skills disable rev", 8).map((completion) => completion.value)).toContain("/skills disable reviewer");
  expect(slashCompletions(commands, ctx, "/skills enable wri", 8).map((completion) => completion.value)).toContain("/skills enable writer");
  expect(slashCompletions(commands, ctx, "/skills enable --user wri", 8).map((completion) => completion.value)).toContain("/skills enable --user writer");
});

function skillSummary(name: string, options: Partial<SkillSummary> = {}): SkillSummary {
  const source = options.source ?? "project";
  const baseDir = options.baseDir ?? `/repo/.chili/skills/${name}`;
  return {
    name,
    source,
    description: options.description ?? `${name} skill`,
    filePath: options.filePath ?? `${baseDir}/SKILL.md`,
    baseDir,
    ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
    ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
  };
}
