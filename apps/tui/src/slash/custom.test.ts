import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { loadCustomSlashCommands } from "./custom.js";
import { resolveSlashCommand, slashCompletions } from "./registry.js";
import type { SlashCommandContext } from "./types.js";

test("loads project markdown commands as TUI slash commands", async () => {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(path.join(tmpdir(), "chili-tui-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-tui-project-"));
  process.env.HOME = home;
  await mkdir(path.join(cwd, ".chili/commands/review"), { recursive: true });
  await writeFile(path.join(cwd, ".chili/commands/review/security.md"), "Review $ARGUMENTS with $1.");

  try {
    const state = await loadCustomSlashCommands(cwd);
    const ctx = { model: {}, cwd } as SlashCommandContext;

    expect(state.diagnostics).toEqual([]);
    expect(slashCompletions(state.commands, ctx, "/review s", 8).map((completion) => completion.value)).toEqual([
      "/review security",
    ]);

    const match = resolveSlashCommand(state.commands, "/review security src/auth.ts");
    expect(match?.args).toBe("src/auth.ts");
    const result = await match?.command.run(ctx, match.args);
    expect(result).toEqual({
      type: "submit_prompt",
      prompt: "Review src/auth.ts with src/auth.ts.",
      commandName: "review security",
    });
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
