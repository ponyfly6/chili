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
  expect(await resolveSlashCommand(commands, "/reasoning")?.command.run(ctx, "")).toEqual({
    type: "open_reasoning_picker",
  });
  expect(slashCompletions(commands, ctx, "/thinking h", 8).map((completion) => completion.value)).toContain("/thinking high");
  expect(slashCompletions(commands, ctx, "/thinking h", 8).map((completion) => completion.value)).toContain("/thinking hide");
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
