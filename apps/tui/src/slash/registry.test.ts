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
