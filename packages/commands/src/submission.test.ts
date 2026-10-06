import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemPromptCommandControl,
  type PromptCommandRunResult,
} from "./control.js";
import { createMcpPromptCommands } from "./mcp-prompts.js";
import { createCommandRegistry, serializeCommandCatalog } from "./registry.js";
import { findRuntimeCommandNode } from "./control.js";
import { createCommandRunInput } from "./template.js";
import { preparePromptCommandSubmission } from "./submission.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })));
});

test("project command submission preserves expanded text, visible invocation and every tool scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-command-submission-"));
  fixtures.push(root);
  const cwd = join(root, "project");
  const chiliHome = join(root, "home");
  await mkdir(join(cwd, ".chili/commands"), { recursive: true });
  await mkdir(chiliHome);
  await writeFile(join(cwd, ".chili/commands/review.md"), [
    "---",
    "allowedTools: [read, write, bash]",
    "writeScope: [REPORT.md]",
    "executeScope: [bun test]",
    "---",
    "Review $ARGUMENTS",
  ].join("\n"));

  const control = createFilesystemPromptCommandControl({ cwd, chiliHome });
  const submission = await preparePromptCommandSubmission(control, {
    commandId: "prompt.project.review",
    args: "  src/main.ts  ",
    cwd,
  });

  expect(submission).toEqual({
    text: "Review src/main.ts",
    displayText: "/prompt project review src/main.ts",
    toolPolicy: {
      allowedTools: ["read", "write", "bash"],
      writeScope: ["REPORT.md"],
      executeScope: ["bun test"],
    },
  });
});

test("MCP command submission keeps the server prompt and tool restrictions without changing the chosen model", async () => {
  const calls: unknown[] = [];
  const registry = createCommandRegistry(createMcpPromptCommands([{
    serverName: "docs",
    name: "review",
    arguments: [{ name: "file", required: true }],
  }], {
    renderPrompt(request, context) {
      calls.push({ request, context });
      return {
        prompt: `Review ${request.arguments.file}`,
        metadata: { allowedTools: [" read ", "grep"], model: "command-model-hint" },
      };
    },
  }));
  const catalog = serializeCommandCatalog(registry, { cwd: "/workspace" });
  const submission = await preparePromptCommandSubmission({
    async run(invocation): Promise<PromptCommandRunResult> {
      const command = registry.findById(invocation.commandId)!;
      const args = invocation.args ?? "";
      const result = await command.run!(
        { cwd: invocation.cwd! },
        createCommandRunInput(`${command.path} ${args}`, args, command.path),
      );
      return {
        prompt: result.prompt,
        metadata: result.metadata,
        command: findRuntimeCommandNode(catalog.roots, command.id)!,
      };
    },
  }, { commandId: "prompt.mcp.docs.review", args: "README.md", cwd: "/workspace" });

  expect(calls).toEqual([{
    request: { serverName: "docs", promptName: "review", arguments: { file: "README.md" } },
    context: { cwd: "/workspace" },
  }]);
  expect(submission).toEqual({
    text: "Review README.md",
    displayText: "/prompt mcp docs review README.md",
    toolPolicy: { allowedTools: ["read", "grep"] },
  });
});

test("submission without arguments or policy leaves the canonical command path intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-command-unrestricted-"));
  fixtures.push(root);
  await mkdir(join(root, ".chili/commands"), { recursive: true });
  await writeFile(join(root, ".chili/commands/hello.md"), "Say hello");
  const control = createFilesystemPromptCommandControl({ cwd: root, chiliHome: join(root, "home") });

  expect(await preparePromptCommandSubmission(control, {
    commandId: "prompt.project.hello",
    args: "  ",
  })).toEqual({ text: "Say hello", displayText: "/prompt project hello" });
});

test("filesystem command restrictions preserve explicit empty sets through loading and submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-command-empty-policy-"));
  fixtures.push(root);
  await mkdir(join(root, ".chili/commands"), { recursive: true });
  for (const field of ["allowedTools", "writeScope", "executeScope"]) {
    for (const value of ["[]", "", "[   ]"]) {
      await writeFile(join(root, ".chili/commands/limited.md"), `---\n${field}: ${value}\n---\nDo only authorized work`);
      const control = createFilesystemPromptCommandControl({ cwd: root, chiliHome: join(root, "home") });
      expect(await preparePromptCommandSubmission(control, { commandId: "prompt.project.limited" }))
        .toMatchObject({ toolPolicy: { [field]: [] } });
    }
  }
});

test("invalid command restriction metadata is rejected instead of broadening capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-command-invalid-policy-"));
  fixtures.push(root);
  await mkdir(join(root, ".chili/commands"), { recursive: true });
  await writeFile(join(root, ".chili/commands/limited.md"), "Do only authorized work");
  const control = createFilesystemPromptCommandControl({ cwd: root, chiliHome: join(root, "home") });
  const result = await control.run({ commandId: "prompt.project.limited" });
  for (const field of ["allowedTools", "writeScope", "executeScope"]) {
    for (const value of [null, false, "read", ["read", 1]]) {
      await expect(preparePromptCommandSubmission({
        async run() { return { ...result, metadata: { ...result.metadata, [field]: value } }; },
      }, { commandId: "prompt.project.limited" })).rejects.toThrow(`command.metadata.${field}`);
    }
  }
});
