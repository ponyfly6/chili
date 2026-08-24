import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  createFilesystemPromptCommandControl,
  PromptCommandNotFoundError,
  PromptCommandUsageError,
} from "./commands.js";

test("filesystem command control publishes one canonical recursive prompt catalog", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "chili-command-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-command-project-"));
  await mkdir(path.join(cwd, ".chili/commands/review"), { recursive: true });
  await mkdir(path.join(home, "commands"), { recursive: true });
  await writeFile(
    path.join(cwd, ".chili/commands/review/typescript.md"),
    [
      "---",
      "description: Review TypeScript",
      "argumentHint: \"<files...>\"",
      "allowedTools: [read, grep]",
      "---",
      "Review $ARGUMENTS",
    ].join("\n"),
  );
  await writeFile(path.join(home, "commands/review.md"), "User review $ARGUMENTS");

  const commands = createFilesystemPromptCommandControl({ cwd, chiliHome: home });
  const catalog = await commands.list();
  const nodes = flatten(catalog.roots);

  expect(nodes.map((command) => command.path)).toEqual([
    "/prompt",
    "/prompt builtin",
    "/prompt builtin init",
    "/prompt project",
    "/prompt project review",
    "/prompt project review typescript",
    "/prompt user",
    "/prompt user review",
  ]);
  expect(nodes.find((command) => command.id === "prompt.project.review.typescript")).toMatchObject({
    title: "Review TypeScript",
    source: "project",
    argumentMode: "variadic",
    argumentHint: "<files...>",
    executionTarget: "prompt",
  });
  expect(catalog.diagnostics).toEqual([]);
  expect(JSON.stringify(catalog)).not.toContain("aliases");
  expect(JSON.stringify(catalog)).not.toContain("directories");
  expect(JSON.stringify(catalog)).not.toContain("skippedConflicts");
});

test("filesystem command control executes prompt leaves by stable ID", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "chili-command-run-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-command-run-project-"));
  await mkdir(path.join(cwd, ".chili/commands"), { recursive: true });
  await writeFile(
    path.join(cwd, ".chili/commands/review.md"),
    [
      "---",
      "description: Review files",
      "allowedTools: [read, grep]",
      "writeScope: [REPORT.md]",
      "---",
      "Review $1 from $ARGUMENTS",
    ].join("\n"),
  );
  const commands = createFilesystemPromptCommandControl({ cwd, chiliHome: home });

  const result = await commands.run({
    commandId: "prompt.project.review",
    args: "\"src/main.ts\" tests/main.test.ts",
    cwd,
  });

  expect(result.command).toMatchObject({
    id: "prompt.project.review",
    path: "/prompt project review",
    source: "project",
  });
  expect(result.metadata).toMatchObject({
    commandId: "prompt.project.review",
    commandPath: "/prompt project review",
    source: "project",
    allowedTools: ["read", "grep"],
    writeScope: ["REPORT.md"],
  });
  expect(result.prompt).toBe("Review src/main.ts from \"src/main.ts\" tests/main.test.ts");
});

test("command execution loads and caches project commands by authoritative cwd", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "chili-command-cwd-home-"));
  const defaultCwd = await mkdtemp(path.join(tmpdir(), "chili-command-cwd-default-"));
  const sessionCwd = await mkdtemp(path.join(tmpdir(), "chili-command-cwd-session-"));
  await mkdir(path.join(defaultCwd, ".chili/commands"), { recursive: true });
  await mkdir(path.join(sessionCwd, ".chili/commands"), { recursive: true });
  await writeFile(
    path.join(defaultCwd, ".chili/commands/review.md"),
    "Default workspace review $ARGUMENTS",
  );
  await writeFile(
    path.join(sessionCwd, ".chili/commands/review.md"),
    "Session workspace review $ARGUMENTS",
  );
  const commands = createFilesystemPromptCommandControl({ cwd: defaultCwd, chiliHome: home });

  const listed = await commands.list();
  expect(flatten(listed.roots).find((command) => command.id === "prompt.project.review")?.source)
    .toBe("project");

  const sessionResult = await commands.run({
    commandId: "prompt.project.review",
    args: "src/session.ts",
    cwd: sessionCwd,
  });
  const defaultResult = await commands.run({
    commandId: "prompt.project.review",
    args: "src/default.ts",
  });

  expect(sessionResult.prompt).toBe("Session workspace review src/session.ts");
  expect(sessionResult.metadata.filePath).toBe(path.join(sessionCwd, ".chili/commands/review.md"));
  expect(defaultResult.prompt).toBe("Default workspace review src/default.ts");
  expect(defaultResult.metadata.filePath).toBe(path.join(defaultCwd, ".chili/commands/review.md"));
});

test("filesystem command control preserves builtin prompt metadata", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "chili-command-empty-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-command-empty-project-"));
  const commands = createFilesystemPromptCommandControl({ cwd, chiliHome: home });

  const result = await commands.run({
    commandId: "prompt.builtin.init",
    args: "testing setup",
  });

  expect(result.command).toMatchObject({
    id: "prompt.builtin.init",
    path: "/prompt builtin init",
    source: "builtin",
  });
  expect(result.metadata).toMatchObject({
    commandId: "prompt.builtin.init",
    commandPath: "/prompt builtin init",
    source: "builtin",
    allowedTools: ["read", "glob", "grep", "git_status", "git_diff", "edit", "write", "apply_patch", "tool_search"],
    writeScope: ["AGENTS.md"],
  });
  expect(result.prompt).toContain("testing setup");
  expect(result.prompt).toContain("# Repository Guidelines");
});

test("reload retains usable commands while surfacing project and user diagnostics", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "chili-command-diagnostic-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-command-diagnostic-project-"));
  await mkdir(path.join(cwd, ".chili/commands"), { recursive: true });
  await mkdir(path.join(home, "commands"), { recursive: true });
  await writeFile(
    path.join(cwd, ".chili/commands/legacy.md"),
    "---\ncategory: old\n---\nlegacy",
  );
  await writeFile(
    path.join(home, "commands/broken.md"),
    "---\ndescription: Broken",
  );
  const commands = createFilesystemPromptCommandControl({ cwd, chiliHome: home });

  const catalog = await commands.reload();

  expect(flatten(catalog.roots).map((command) => command.id)).toContain("prompt.builtin.init");
  expect(catalog.diagnostics).toEqual([
    expect.objectContaining({
      level: "error",
      code: "unsupported_frontmatter_field",
      message: "Unsupported command frontmatter field: category",
    }),
    expect.objectContaining({
      level: "error",
      code: "malformed_frontmatter",
      message: "Frontmatter starts with --- but has no closing --- delimiter.",
    }),
  ]);
});

test("catalog snapshots are deep clones", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "chili-command-clone-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-command-clone-project-"));
  await mkdir(path.join(cwd, ".chili/commands"), { recursive: true });
  await writeFile(
    path.join(cwd, ".chili/commands/broken.md"),
    "---\nunknown: true\n---\nbroken",
  );
  const commands = createFilesystemPromptCommandControl({ cwd, chiliHome: home });

  const first = await commands.list();
  first.roots[0]!.children.splice(0);
  first.diagnostics[0]!.message = "mutated";

  const second = await commands.list();
  expect(flatten(second.roots).map((command) => command.id)).toContain("prompt.builtin.init");
  expect(second.diagnostics[0]?.message).toBe("Unsupported command frontmatter field: unknown");
});

test("unknown IDs and non-executable namespaces retain explicit error semantics", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "chili-command-errors-home-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-command-errors-project-"));
  await mkdir(path.join(cwd, ".chili/commands"), { recursive: true });
  const commands = createFilesystemPromptCommandControl({ cwd, chiliHome: home });

  await expect(commands.run({ commandId: "required", args: "docs" }))
    .rejects.toBeInstanceOf(PromptCommandNotFoundError);
  await expect(commands.run({ commandId: "prompt.project" }))
    .rejects.toBeInstanceOf(PromptCommandNotFoundError);

  expect(new PromptCommandUsageError("prompt.mcp.docs.review", "/prompt mcp docs review <file>"))
    .toMatchObject({
      commandId: "prompt.mcp.docs.review",
      usage: "/prompt mcp docs review <file>",
      message: "Command prompt.mcp.docs.review requires: /prompt mcp docs review <file>",
    });
});

function flatten<T extends { children: T[] }>(roots: readonly T[]): T[] {
  return roots.flatMap((command) => [command, ...flatten(command.children)]);
}
