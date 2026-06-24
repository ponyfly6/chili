import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createFilesystemPromptCommandControl } from "./commands.js";

test("filesystem command control lists and expands project commands with builtin fallback", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "chili-command-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-command-project-"));
  await mkdir(path.join(cwd, ".chili/commands"), { recursive: true });
  await writeFile(
    path.join(cwd, ".chili/commands/joke.md"),
    [
      "---",
      "description: Tell a joke",
      "argumentHint: \"[topic]\"",
      "---",
      "Tell a short joke about $ARGUMENTS.",
    ].join("\n"),
  );

  const commands = createFilesystemPromptCommandControl({ cwd, chiliHome: home });
  const list = await commands.list();

  expect(list.commands.map((command) => command.name)).toEqual(["joke", "init"]);
  expect(list.commands[0]).toMatchObject({
    description: "Tell a joke",
    argumentHint: "[topic]",
    source: "project",
  });
  expect(list.commands[1]).toMatchObject({
    name: "init",
    source: "builtin",
  });

  const result = await commands.run({ name: "joke", args: "typescript" });
  expect(result.prompt).toBe("Tell a short joke about typescript.");
});

test("filesystem command control lists and runs builtin init when command dirs are empty", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "chili-command-empty-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-command-empty-project-"));
  const commands = createFilesystemPromptCommandControl({ cwd, chiliHome: home });

  const list = await commands.list();

  expect(list.commands.map((command) => command.name)).toEqual(["init"]);
  expect(list.commands[0]).toMatchObject({
    name: "init",
    source: "builtin",
    argumentHint: "[focus]",
  });

  const result = await commands.run({ name: "init", args: "testing setup" });
  expect(result.command).toMatchObject({ name: "init", source: "builtin" });
  expect(result.metadata).toMatchObject({
    commandName: "init",
    source: "builtin",
    allowedTools: ["read", "glob", "grep", "git_status", "git_diff", "edit", "write", "apply_patch", "tool_search"],
    writeScope: ["AGENTS.md"],
  });
  expect(result.prompt).toContain("testing setup");
  expect(result.prompt).toContain("AGENTS.md");
  expect(result.prompt).toContain("# Repository Guidelines");
});

test("project custom init overrides builtin init", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "chili-command-override-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-command-override-project-"));
  await mkdir(path.join(cwd, ".chili/commands"), { recursive: true });
  await writeFile(path.join(cwd, ".chili/commands/init.md"), "Project init for $ARGUMENTS");
  const commands = createFilesystemPromptCommandControl({ cwd, chiliHome: home });

  const list = await commands.list();
  expect(list.commands.filter((command) => command.name === "init")).toEqual([
    expect.objectContaining({ name: "init", source: "project" }),
  ]);

  const result = await commands.run({ name: "init", args: "docs" });
  expect(result.command).toMatchObject({ name: "init", source: "project" });
  expect(result.prompt).toBe("Project init for docs");
});

test("user custom init overrides builtin init", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "chili-command-user-override-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-command-user-override-project-"));
  await mkdir(path.join(home, "commands"), { recursive: true });
  await writeFile(path.join(home, "commands/init.md"), "User init for $ARGUMENTS");
  const commands = createFilesystemPromptCommandControl({ cwd, chiliHome: home });

  const list = await commands.list();
  expect(list.commands.filter((command) => command.name === "init")).toEqual([
    expect.objectContaining({ name: "init", source: "user" }),
  ]);

  const result = await commands.run({ name: "init", args: "docs" });
  expect(result.command).toMatchObject({ name: "init", source: "user" });
  expect(result.prompt).toBe("User init for docs");
});
