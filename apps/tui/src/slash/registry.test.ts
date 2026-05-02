import { expect, test } from "bun:test";
import { createDefaultSlashCommands, resolveSlashCommand, slashCompletions } from "./registry.js";
import type { SlashCommandContext } from "./types.js";

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
  expect(await resolveSlashCommand(commands, "/reasoning")?.command.run(ctx, "")).toEqual({
    type: "open_reasoning_picker",
  });
  expect(slashCompletions(commands, ctx, "/thinking h", 8).map((completion) => completion.value)).toContain("/thinking high");
});
