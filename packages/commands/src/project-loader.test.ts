import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createCommandRegistry } from "./registry.js";
import { loadCommandDirectory, loadProjectCommands, loadUserCommands } from "./project-loader.js";
import { resolveCommand } from "./resolve.js";

test("project loader derives a recursive /prompt project namespace", async () => {
  const cwd = await tempProject();
  await mkdir(path.join(cwd, ".chili/commands/review"), { recursive: true });
  await writeFile(
    path.join(cwd, ".chili/commands/review/security.md"),
    [
      "---",
      "description: Review the current change",
      "argumentHint: <files>",
      "model: chili-reviewer",
      "allowedTools: [Read, Grep]",
      "writeScope: [AGENTS.md]",
      "executeScope: [bun test]",
      "subtask: true",
      "hidden: false",
      "---",
      "Review $ARGUMENTS with focus on $1 and $2.",
    ].join("\n"),
  );

  const result = await loadProjectCommands({ cwd });
  const registry = createCommandRegistry(result.commands);
  const command = registry.findByPath("/prompt project review security");

  expect(result.diagnostics).toEqual([]);
  expect(command).toMatchObject({
    id: "prompt.project.review.security",
    name: "security",
    path: "/prompt project review security",
    description: "Review the current change",
    argumentHint: "<files>",
    group: "prompt",
    source: "project",
    executionTarget: "prompt",
  });
  expect(command?.metadata).toMatchObject({
    model: "chili-reviewer",
    allowedTools: ["Read", "Grep"],
    writeScope: ["AGENTS.md"],
    executeScope: ["bun test"],
    subtask: true,
  });
});

test("project prompt expansion runs only at its canonical namespace", async () => {
  const cwd = await tempProject();
  await writeFile(
    path.join(cwd, ".chili/commands/review.md"),
    "Review $ARGUMENTS\nfirst=$1\nsecond=$2\nliteral=@file\nshell=!{echo no}\n",
  );
  const result = await loadProjectCommands({ cwd });
  const registry = createCommandRegistry(result.commands);

  expect(resolveCommand(registry, {}, "/review src/index.ts").status).toBe("unknown");
  const resolved = resolveCommand(registry, {}, "/prompt project review src/index.ts tests/index.test.ts");
  expect(resolved.status).toBe("matched");
  if (resolved.status !== "matched" || !resolved.command.run) return;

  const output = await resolved.command.run({}, resolved.args);
  expect(output.prompt).toContain("Review src/index.ts tests/index.test.ts");
  expect(output.prompt).toContain("first=src/index.ts");
  expect(output.prompt).toContain("second=tests/index.test.ts");
  expect(output.prompt).toContain("literal=@file");
  expect(output.prompt).toContain("shell=!{echo no}");
  expect(output.metadata).toMatchObject({
    commandId: "prompt.project.review",
    commandPath: "/prompt project review",
    source: "project",
  });
});

test("user loader derives a distinct /prompt user namespace", async () => {
  const chiliHome = await mkdtemp(path.join(tmpdir(), "chili-home-"));
  await mkdir(path.join(chiliHome, "commands"), { recursive: true });
  await writeFile(path.join(chiliHome, "commands/fix-test.md"), "Fix $ARGUMENTS");

  const result = await loadUserCommands({ chiliHome });
  const registry = createCommandRegistry(result.commands);

  expect(registry.findByPath("/prompt user fix-test")).toMatchObject({
    id: "prompt.user.fix-test",
    source: "user",
  });
  expect(registry.findByPath("/prompt project fix-test")).toBeUndefined();
});

test("removed frontmatter fields reject the prompt instead of acting as compatibility input", async () => {
  const cwd = await tempProject();
  await writeFile(
    path.join(cwd, ".chili/commands/legacy.md"),
    "---\ncategory: quality\naliases: [old-review]\n---\nLegacy prompt",
  );

  const result = await loadProjectCommands({ cwd });

  expect(createCommandRegistry(result.commands).findByPath("/prompt project legacy")).toBeUndefined();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      level: "error",
      code: "unsupported_frontmatter_field",
      message: "Unsupported command frontmatter field: category",
    }),
  ]);
});

test("normalized source-local path collisions are diagnosed and never overwritten", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chili-commands-conflict-"));
  await writeFile(path.join(root, "Code Review.md"), "first");
  await writeFile(path.join(root, "code-review.md"), "second");

  const result = await loadCommandDirectory({ directory: root, source: "project" });
  const registry = createCommandRegistry(result.commands);

  expect(registry.findByPath("/prompt project code-review")?.origin).toEndWith("Code Review.md");
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      level: "error",
      code: "duplicate_command_path",
      path: "/prompt project code-review",
      commandIds: ["prompt.project.code-review", "prompt.project.code-review"],
    }),
  ]);
});

test("malformed frontmatter returns a diagnostic and skips the command", async () => {
  const cwd = await tempProject();
  await writeFile(path.join(cwd, ".chili/commands/broken.md"), "---\ndescription: Nope\nunterminated");

  const result = await loadProjectCommands({ cwd });

  expect(createCommandRegistry(result.commands).findByPath("/prompt project broken")).toBeUndefined();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ level: "error", code: "malformed_frontmatter" }),
  ]);
});

async function tempProject(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-commands-"));
  await mkdir(path.join(cwd, ".chili/commands"), { recursive: true });
  return cwd;
}
