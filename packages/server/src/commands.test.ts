import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createFilesystemPromptCommandControl } from "./commands.js";

test("filesystem command control lists and expands project commands", async () => {
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

  expect(list.commands.map((command) => command.name)).toEqual(["joke"]);
  expect(list.commands[0]).toMatchObject({
    description: "Tell a joke",
    argumentHint: "[topic]",
    source: "project",
  });

  const result = await commands.run({ name: "joke", args: "typescript" });
  expect(result.prompt).toBe("Tell a short joke about typescript.");
});
