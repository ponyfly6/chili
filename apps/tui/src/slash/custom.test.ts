import { expect, test } from "bun:test";
import { customSlashCommandsFromRuntime } from "./custom.js";
import { resolveSlashCommand, slashCompletions } from "./registry.js";
import type { SlashCommandContext } from "./types.js";

test("adapts runtime command descriptors as TUI slash commands", async () => {
  const state = customSlashCommandsFromRuntime({
    commands: [
      {
        name: "review security",
        aliases: [],
        description: "Review security",
        category: "project",
        source: "project",
        argumentHint: "[path]",
        hidden: false,
      },
    ],
    diagnostics: [],
    directories: ["/repo/.chili/commands"],
    skippedConflicts: [],
  });
  const ctx = { model: {}, cwd: "/repo" } as SlashCommandContext;

  expect(slashCompletions(state.commands, ctx, "/review s", 8).map((completion) => completion.value)).toEqual([
    "/review security",
  ]);

  const match = resolveSlashCommand(state.commands, "/review security src/auth.ts");
  expect(match?.args).toBe("src/auth.ts");
  const result = await match?.command.run(ctx, match.args);
  expect(result).toEqual({
    type: "submit_command",
    commandName: "review security",
    args: "src/auth.ts",
  });
});

test("adapts builtin runtime command descriptors as TUI slash commands", async () => {
  const state = customSlashCommandsFromRuntime({
    commands: [
      {
        name: "init",
        aliases: [],
        description: "Create or update AGENTS.md repository guidelines",
        category: "builtin",
        source: "builtin",
        argumentHint: "[focus]",
        hidden: false,
      },
    ],
    diagnostics: [],
    directories: [],
    skippedConflicts: [],
  });
  const ctx = { model: {}, cwd: "/repo" } as SlashCommandContext;

  expect(slashCompletions(state.commands, ctx, "/in", 8).map((completion) => completion.value)).toEqual([
    "/init",
  ]);

  const match = resolveSlashCommand(state.commands, "/init testing setup");
  expect(match?.args).toBe("testing setup");
  const result = await match?.command.run(ctx, match.args);
  expect(result).toEqual({
    type: "submit_command",
    commandName: "init",
    args: "testing setup",
  });
});
