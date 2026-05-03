import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createCommandRegistry } from "./registry.js";
import { loadCommandDirectory, loadProjectCommands, loadUserCommands } from "./project-loader.js";
import { resolveCommand } from "./resolve.js";

test("project loader reads markdown commands with frontmatter", async () => {
  const cwd = await tempProject();
  await writeFile(
    path.join(cwd, ".chili/commands/review.md"),
    [
      "---",
      "description: Review the current change",
      "argumentHint: <files>",
      "model: chili-reviewer",
      "allowedTools: [Read, Grep]",
      "subtask: true",
      "category: quality",
      "hidden: false",
      "---",
      "Review $ARGUMENTS with focus on $1 and $2.",
      "",
    ].join("\n"),
  );

  const result = await loadProjectCommands({ cwd });

  expect(result.diagnostics).toEqual([]);
  expect(result.commands).toHaveLength(1);

  const command = result.commands[0];
  expect(command?.name).toBe("review");
  expect(command?.description).toBe("Review the current change");
  expect(command?.argumentHint).toBe("<files>");
  expect(command?.category).toBe("quality");
  expect(command?.hidden).toBe(false);
  expect(command?.metadata).toMatchObject({
    model: "chili-reviewer",
    allowedTools: ["Read", "Grep"],
    subtask: true,
  });
});

test("project prompt command expands arguments without shell execution", async () => {
  const cwd = await tempProject();
  await writeFile(
    path.join(cwd, ".chili/commands/review.md"),
    "Review $ARGUMENTS\nfirst=$1\nsecond=$2\nliteral=@file\nshell=!{echo no}\n",
  );

  const { commands } = await loadProjectCommands({ cwd });
  const resolved = resolveCommand(commands, "/review src/index.ts tests/index.test.ts");

  expect(resolved.status).toBe("matched");
  if (resolved.status !== "matched") return;

  const output = await resolved.command.run({}, resolved.args);
  expect(output.type).toBe("prompt");
  if (output.type !== "prompt") return;

  expect(output.prompt).toContain("Review src/index.ts tests/index.test.ts");
  expect(output.prompt).toContain("first=src/index.ts");
  expect(output.prompt).toContain("second=tests/index.test.ts");
  expect(output.prompt).toContain("literal=@file");
  expect(output.prompt).toContain("shell=!{echo no}");
});

test("loader reads nested markdown commands as multi-token command names", async () => {
  const cwd = await tempProject();
  await mkdir(path.join(cwd, ".chili/commands/review"), { recursive: true });
  await writeFile(path.join(cwd, ".chili/commands/review/security.md"), "Review security for $ARGUMENTS");

  const { commands } = await loadProjectCommands({ cwd });
  const resolved = resolveCommand(commands, "/review security src/auth.ts");
  expect(resolved.status).toBe("matched");
  if (resolved.status !== "matched") return;

  expect(resolved.command.name).toBe("review security");
  expect(resolved.path).toEqual(["review", "security"]);
  const output = await resolved.command.run({}, resolved.args);
  expect(output.prompt).toBe("Review security for src/auth.ts");
});

test("registry keeps first command when user and project commands conflict", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chili-commands-conflict-"));
  await mkdir(path.join(root, "project-commands"), { recursive: true });
  await mkdir(path.join(root, "user-commands"), { recursive: true });
  await writeFile(path.join(root, "project-commands/review.md"), "project review");
  await writeFile(path.join(root, "user-commands/review.md"), "user review");

  const project = await loadCommandDirectory({ directory: path.join(root, "project-commands"), source: "project" });
  const user = await loadCommandDirectory({ directory: path.join(root, "user-commands"), source: "user" });
  const registry = createCommandRegistry(project.commands);
  const results = registry.registerMany(user.commands);

  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    status: "skipped",
    reason: "name_conflict",
    name: "review",
  });

  const resolved = resolveCommand(registry, "/review");
  expect(resolved.status).toBe("matched");
  if (resolved.status !== "matched") return;
  expect(resolved.command.source).toBe("project");
});

test("user loader reads commands from a chili home directory", async () => {
  const chiliHome = await mkdtemp(path.join(tmpdir(), "chili-home-"));
  await mkdir(path.join(chiliHome, "commands"), { recursive: true });
  await writeFile(path.join(chiliHome, "commands/fix-test.md"), "Fix $ARGUMENTS");

  const result = await loadUserCommands({ chiliHome });

  expect(result.commands).toHaveLength(1);
  expect(result.commands[0]?.name).toBe("fix-test");
  expect(result.commands[0]?.source).toBe("user");
});

test("malformed frontmatter returns a diagnostic and skips the command", async () => {
  const cwd = await tempProject();
  await writeFile(path.join(cwd, ".chili/commands/broken.md"), "---\ndescription: Nope\nunterminated");

  const result = await loadProjectCommands({ cwd });

  expect(result.commands).toEqual([]);
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      level: "error",
      code: "malformed_frontmatter",
    }),
  ]);
});

async function tempProject(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-commands-"));
  await mkdir(path.join(cwd, ".chili/commands"), { recursive: true });
  return cwd;
}
