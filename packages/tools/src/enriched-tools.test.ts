import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { createApplyPatchTool } from "./builtins/apply-patch.js";
import { createBashTool } from "./builtins/bash.js";
import type { BashRunRequest, BashRunner } from "./builtins/bash.js";
import { createEditTool } from "./builtins/edit.js";
import { createGlobTool } from "./builtins/glob.js";
import { createGrepTool } from "./builtins/grep.js";
import { createReadFileTool } from "./builtins/read-file.js";
import { createReadImageTool } from "./builtins/read-image.js";
import { createToolSearchTool } from "./builtins/tool-search.js";
import { createWriteFileTool } from "./builtins/write-file.js";
import { InMemoryToolRegistry } from "./registry.js";
import { ToolExecutor } from "./executor.js";
import { FileReadStateStore } from "./file-read-state.js";
import { StreamingToolOutputFile } from "./tool-output-storage.js";
import type { ExecuteToolInput, ToolAccessPolicyResolver, ToolExecutorOptions } from "./types.js";
import type { SnapshotProvider, SnapshotRecord, SnapshotRevertResult } from "./types.js";

test("write tools require observed target text or a fresh full read before modifying existing files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-read-state-"));
  try {
    await writeFile(join(workspace, "a.txt"), "old\n", "utf8");
    const registry = registryWithCoreTools();
    registry.register(createApplyPatchTool());
    const executor = createExecutor(registry);

    const unreadEdit = await executor.execute(toolInput("edit", { filePath: "a.txt", oldString: "old", newString: "new" }, workspace));
    expect(unreadEdit.status).toBe("failed");
    if (unreadEdit.status === "failed") expect(unreadEdit.error.message).toContain("Read a.txt before modifying");

    const read = await executor.execute(toolInput("read", { filePath: "a.txt" }, workspace));
    expect(read.status).toBe("completed");
    const edit = await executor.execute(toolInput("edit", { filePath: "a.txt", oldString: "old", newString: "new" }, workspace));
    expect(edit.status).toBe("completed");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("new\n");

    await writeFile(join(workspace, "a.txt"), "external\n", "utf8");
    const staleWrite = await executor.execute(toolInput("write", { filePath: "a.txt", content: "next\n" }, workspace));
    expect(staleWrite.status).toBe("failed");
    if (staleWrite.status === "failed") expect(staleWrite.error.message).toContain("File changed since it was read");

    await writeFile(join(workspace, "b.txt"), "before\nneedle\nother\n", "utf8");
    const partialRead = await executor.execute(toolInput("read", { filePath: "b.txt", offset: 2, limit: 1 }, workspace));
    expect(partialRead.status).toBe("completed");
    const partialEdit = await executor.execute(toolInput("edit", { filePath: "b.txt", oldString: "needle", newString: "changed" }, workspace));
    expect(partialEdit.status).toBe("completed");
    expect(await readFile(join(workspace, "b.txt"), "utf8")).toBe("before\nchanged\nother\n");

    await writeFile(join(workspace, "c.txt"), "first\nsecond\nthird\n", "utf8");
    const unrelatedRead = await executor.execute(toolInput("read", { filePath: "c.txt", offset: 1, limit: 1 }, workspace));
    expect(unrelatedRead.status).toBe("completed");
    const unseenEdit = await executor.execute(toolInput("edit", { filePath: "c.txt", oldString: "third", newString: "changed" }, workspace));
    expect(unseenEdit.status).toBe("failed");
    if (unseenEdit.status === "failed") expect(unseenEdit.error.message).toContain("Read the target text");

    await writeFile(join(workspace, "d.txt"), "before\nneedle\nother\n", "utf8");
    const staleRangeRead = await executor.execute(toolInput("read", { filePath: "d.txt", offset: 2, limit: 1 }, workspace));
    expect(staleRangeRead.status).toBe("completed");
    await writeFile(join(workspace, "d.txt"), "before\nneedle\nother\nextra\n", "utf8");
    const staleRangeEdit = await executor.execute(toolInput("edit", { filePath: "d.txt", oldString: "needle", newString: "changed" }, workspace));
    expect(staleRangeEdit.status).toBe("failed");
    if (staleRangeEdit.status === "failed") expect(staleRangeEdit.error.message).toContain("File changed since the target text was read");

    await writeFile(join(workspace, "e.txt"), "old\n", "utf8");
    const partialWriteRead = await executor.execute(toolInput("read", { filePath: "e.txt", offset: 1, limit: 1 }, workspace));
    expect(partialWriteRead.status).toBe("completed");
    const partialWrite = await executor.execute(toolInput("write", { filePath: "e.txt", content: "new\n" }, workspace));
    expect(partialWrite.status).toBe("failed");
    if (partialWrite.status === "failed") expect(partialWrite.error.message).toContain("Read e.txt before modifying");

    await writeFile(join(workspace, "f.txt"), "alpha\nneedle\nomega\n", "utf8");
    const patchRead = await executor.execute(toolInput("read", { filePath: "f.txt", offset: 2, limit: 1 }, workspace));
    expect(patchRead.status).toBe("completed");
    const patch = await executor.execute(
      toolInput(
        "apply_patch",
        {
          operations: [{ type: "replace", path: "f.txt", oldText: "needle", newText: "patched" }],
        },
        workspace,
      ),
    );
    expect(patch.status).toBe("completed");
    expect(await readFile(join(workspace, "f.txt"), "utf8")).toBe("alpha\npatched\nomega\n");

    const largeLines = Array.from({ length: 1200 }, (_, index) => `line-${index + 1}`);
    largeLines[1099] = "deep-needle";
    await writeFile(join(workspace, "large.txt"), `${largeLines.join("\n")}\n`, "utf8");
    const deepRead = await executor.execute(toolInput("read", { filePath: "large.txt", offset: 1100, limit: 1, maxBytes: 64 }, workspace));
    expect(deepRead.status).toBe("completed");
    if (deepRead.status === "completed") {
      expect(deepRead.result.output).toContain("deep-needle");
      expect(deepRead.result.metadata?.truncated).toBe(false);
    }
    const deepEdit = await executor.execute(
      toolInput("edit", { filePath: "large.txt", oldString: "deep-needle", newString: "deep-changed" }, workspace),
    );
    expect(deepEdit.status).toBe("completed");
    expect(await readFile(join(workspace, "large.txt"), "utf8")).toContain("deep-changed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("file read state evicts old range snapshots by content budget", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-read-state-lru-"));
  try {
    const first = join(workspace, "first.txt");
    const second = join(workspace, "second.txt");
    await writeFile(first, "alpha-first\n", "utf8");
    await writeFile(second, "beta-second\n", "utf8");
    const state = new FileReadStateStore({ maxRecords: 10, maxRangeContentBytes: 12 });

    await state.recordTextRangeRead(workspace, first, "alpha-first");
    await state.recordTextRangeRead(workspace, second, "beta-second");

    await expectRejectsWith(
      state.assertObservedText(workspace, first, "alpha-first"),
      "Read first.txt before modifying",
    );
    await state.assertObservedText(workspace, second, "beta-second");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read tool supports a configurable default byte limit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-read-default-limit-"));
  try {
    await writeFile(join(workspace, "large.txt"), "abcdefghij", "utf8");
    const registry = new InMemoryToolRegistry();
    registry.register(createReadFileTool({ defaultMaxBytes: 4 }));
    const executor = createExecutor(registry);

    const result = await executor.execute(toolInput("read", { filePath: "large.txt" }, workspace));

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.output).toBe("abcd\n[truncated after 4 bytes]");
    expect(result.result.metadata).toMatchObject({
      path: "large.txt",
      bytes: 10,
      truncated: true,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read tool rejects explicit byte limits above the configured ceiling", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-read-max-limit-"));
  try {
    await writeFile(join(workspace, "large.txt"), "abcdefghij", "utf8");
    const registry = new InMemoryToolRegistry();
    registry.register(createReadFileTool({ defaultMaxBytes: 4, maxBytesLimit: 8 }));
    const executor = createExecutor(registry);

    const result = await executor.execute(toolInput("read", { filePath: "large.txt", maxBytes: 20 }, workspace));

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error.message).toContain("maxBytes must be <= 8");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("workspace file tools reject symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-tools-symlink-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "outside-secret\n", "utf8");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwOKGAAAAABJRU5ErkJggg==", "base64");
    await writeFile(join(outside, "pixel.png"), png);
    await symlink(outside, join(workspace, "link"), "dir");

    const registry = registryWithCoreTools();
    registry.register(createApplyPatchTool());
    let bashRan = false;
    registry.register(createBashTool({
      runner: {
        async run(request) {
          bashRan = true;
          return {
            exitCode: 0,
            signal: null,
            stdout: request.cwd,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutBytes: request.cwd.length,
            stderrBytes: 0,
            outputLimitBytes: request.maxOutputBytes,
            durationMs: 1,
            timedOut: false,
            aborted: false,
          };
        },
      },
    }));
    const executor = createExecutor(registry);

    const read = await executor.execute(toolInput("read", { filePath: "link/secret.txt" }, workspace));
    expect(read.status).toBe("failed");
    if (read.status === "failed") expect(read.error.message).toContain("inside the workspace");

    const readImage = await executor.execute(toolInput("read_image", { filePath: "link/pixel.png" }, workspace));
    expect(readImage.status).toBe("failed");
    if (readImage.status === "failed") expect(readImage.error.message).toContain("inside the workspace");

    const write = await executor.execute(toolInput("write", { filePath: "link/write.txt", content: "escaped\n" }, workspace));
    expect(write.status).toBe("failed");
    if (write.status === "failed") expect(write.error.message).toContain("inside the workspace");

    const edit = await executor.execute(toolInput("edit", { filePath: "link/edit.txt", oldString: "", newString: "escaped\n" }, workspace));
    expect(edit.status).toBe("failed");
    if (edit.status === "failed") expect(edit.error.message).toContain("inside the workspace");

    const patch = await executor.execute(
      toolInput("apply_patch", { operations: [{ type: "create", path: "link/patch.txt", content: "escaped\n" }] }, workspace),
    );
    expect(patch.status).toBe("failed");
    if (patch.status === "failed") expect(patch.error.message).toContain("inside the workspace");

    const glob = await executor.execute(toolInput("glob", { pattern: "**/*.txt", path: "link" }, workspace));
    expect(glob.status).toBe("failed");
    if (glob.status === "failed") expect(glob.error.message).toContain("inside the workspace");

    const grep = await executor.execute(toolInput("grep", { pattern: "outside-secret", path: "link", headLimit: 1 }, workspace));
    expect(grep.status).toBe("failed");
    if (grep.status === "failed") expect(grep.error.message).toContain("inside the workspace");

    const bash = await executor.execute(toolInput("bash", { command: "pwd", cwd: "link" }, workspace));
    expect(bash.status).toBe("failed");
    if (bash.status === "failed") expect(bash.error.message).toContain("inside the authoritative workspace");
    expect(bashRan).toBe(false);

    await expectRejectsWith(readFile(join(outside, "write.txt"), "utf8"), "ENOENT");
    await expectRejectsWith(readFile(join(outside, "edit.txt"), "utf8"), "ENOENT");
    await expectRejectsWith(readFile(join(outside, "patch.txt"), "utf8"), "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("glob, grep, and tool_search expose repository discovery tools", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-search-"));
  try {
    await mkdir(join(workspace, "apps", "cli", "src"), { recursive: true });
    await mkdir(join(workspace, "packages", "mcp", "src"), { recursive: true });
    await writeFile(join(workspace, "alpha.ts"), "export const alpha = 1;\n", "utf8");
    await writeFile(join(workspace, "beta.md"), "alpha notes\n", "utf8");
    await writeFile(join(workspace, "apps", "cli", "src", "runner.ts"), "export const chiliNeedle = 'cli';\n", "utf8");
    await writeFile(join(workspace, "packages", "mcp", "src", "client.ts"), "export const chiliNeedle = 'mcp';\n", "utf8");
    const registry = registryWithCoreTools();
    const executor = createExecutor(registry);

    const glob = await executor.execute(toolInput("glob", { pattern: "**/*.ts" }, workspace));
    expect(glob.status).toBe("completed");
    if (glob.status === "completed") expect(glob.result.output).toContain("alpha.ts");

    const rootGlob = await executor.execute(toolInput("glob", { pattern: "**/*.ts", path: "." }, workspace));
    expect(rootGlob.status).toBe("completed");
    if (rootGlob.status === "completed") expect(rootGlob.result.output).toContain("alpha.ts");

    const emptyGlob = await executor.execute(toolInput("glob", { pattern: "**/*.missing" }, workspace));
    expect(emptyGlob.status).toBe("completed");
    if (emptyGlob.status === "completed") {
      expect(emptyGlob.result.output).toBe("(no matches)");
      expect(emptyGlob.result.metadata).toMatchObject({ count: 0, truncated: false });
    }

    const braceGlob = await executor.execute(toolInput("glob", { pattern: "**/*.{ts,tsx}" }, workspace));
    expect(braceGlob.status).toBe("failed");
    if (braceGlob.status === "failed") {
      expect(braceGlob.error.message).toBe("Invalid glob input: glob brace expansion is not supported; use separate glob calls instead");
    }

    await writeFile(join(workspace, "literal{draft}.ts"), "export const draft = true;\n", "utf8");
    const literalBraceGlob = await executor.execute(toolInput("glob", { pattern: "**/*{draft}.ts" }, workspace));
    expect(literalBraceGlob.status).toBe("completed");
    if (literalBraceGlob.status === "completed") {
      expect(literalBraceGlob.result.output).toBe("literal{draft}.ts");
    }

    const rangeBraceGlob = await executor.execute(toolInput("glob", { pattern: "release-{1..3}.txt" }, workspace));
    expect(rangeBraceGlob.status).toBe("failed");
    if (rangeBraceGlob.status === "failed") {
      expect(rangeBraceGlob.error.message).toContain("glob brace expansion is not supported");
    }

    const grep = await executor.execute(toolInput("grep", { pattern: "alpha", headLimit: 5 }, workspace));
    expect(grep.status).toBe("completed");
    if (grep.status === "completed") expect(grep.result.output).toContain("alpha");

    const rootGrep = await executor.execute(toolInput("grep", { pattern: "alpha", path: ".", headLimit: 5 }, workspace));
    expect(rootGrep.status).toBe("completed");
    if (rootGrep.status === "completed") expect(rootGrep.result.output).toContain("alpha");

    const splitPathsGrep = await executor.execute(
      toolInput("grep", { pattern: "chiliNeedle", path: "apps/cli/src packages/mcp/src", headLimit: 10 }, workspace),
    );
    expect(splitPathsGrep.status).toBe("completed");
    if (splitPathsGrep.status === "completed") {
      expect(splitPathsGrep.result.output).toContain("apps/cli/src/runner.ts");
      expect(splitPathsGrep.result.output).toContain("packages/mcp/src/client.ts");
    }

    const pathsGrep = await executor.execute(
      toolInput("grep", { pattern: "chiliNeedle", paths: ["apps/cli/src", "packages/mcp/src"], headLimit: 10 }, workspace),
    );
    expect(pathsGrep.status).toBe("completed");
    if (pathsGrep.status === "completed") {
      expect(pathsGrep.result.output).toContain("apps/cli/src/runner.ts");
      expect(pathsGrep.result.output).toContain("packages/mcp/src/client.ts");
    }

    const search = await executor.execute(toolInput("tool_search", { query: "write file" }, workspace));
    expect(search.status).toBe("completed");
    if (search.status === "completed") expect(search.result.output).toContain("write:");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_image returns image content for vision-capable models", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-read-image-"));
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwOKGAAAAABJRU5ErkJggg==", "base64");
    await writeFile(join(workspace, "pixel.png"), png);
    const registry = registryWithCoreTools();
    const executor = createExecutor(registry);

    const result = await executor.execute(toolInput("read_image", { filePath: "pixel.png" }, workspace));
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.output).toContain("MIME type: image/png");
    expect(result.result.content).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
    expect(result.result.metadata).toMatchObject({ path: "pixel.png", bytes: png.byteLength, mimeType: "image/png" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor applies per-tool output limits and persists full output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-output-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "large",
      description: "Emit a large result.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 4,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => ({ title: "large", output: "abcdefgh" }),
    });
    const executor = createExecutor(registry);

    const result = await executor.execute(toolInput("large", {}, workspace, "toolcall_large" as never));
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.output).toContain("full output saved");
    expect(result.result.metadata?.outputTruncated).toBe(true);
    const outputPath = String(result.result.metadata?.outputPath);
    expect(await readFile(join(workspace, outputPath), "utf8")).toBe("abcdefgh");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor preserves a registered streamed output sidecar", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-streamed-output-"));
  try {
    const fullOutput = "COMPLETE_STREAMED_OUTPUT\n";
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "streamed_large",
      description: "Emit a preview for already-persisted output.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 4,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async (_input, context) => {
        const writer = await StreamingToolOutputFile.open(workspace, context.outputArtifactId);
        await writer.append(fullOutput);
        await context.registerPersistedOutput(await writer.close());
        return {
          title: "streamed large",
          output: "preview-only",
        };
      },
    });
    const executor = createExecutor(registry);

    const result = await executor.execute(toolInput("streamed_large", {}, workspace, "toolcall_streamed" as ToolCallId));

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const outputPath = String(result.result.metadata?.outputPath);
    expect(await readFile(join(workspace, outputPath), "utf8")).toBe(fullOutput);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor accepts only one persisted-output registration per call", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-duplicate-registration-"));
  let registrationStatuses: string[] = [];
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "duplicate_registration",
      description: "Register the same sidecar twice concurrently.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      execute: async (_input, context) => {
        const writer = await StreamingToolOutputFile.open(
          workspace,
          context.outputArtifactId,
        );
        await writer.append("registered output");
        const persisted = await writer.close();
        const registrations = await Promise.allSettled([
          context.registerPersistedOutput(persisted),
          context.registerPersistedOutput(persisted),
        ]);
        registrationStatuses = registrations.map((registration) => registration.status).sort();
        return { title: "duplicate registration", output: "preview" };
      },
    });

    const result = await createExecutor(registry).execute(
      toolInput(
        "duplicate_registration",
        {},
        workspace,
        "toolcall_duplicate_registration" as ToolCallId,
      ),
    );

    expect(result.status).toBe("completed");
    expect(registrationStatuses).toEqual(["fulfilled", "rejected"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor rejects concurrent executions that reuse an active call id", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-active-call-id-"));
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  let releaseResolve!: () => void;
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "active_call_id",
      description: "Hold one call open while a duplicate arrives.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      execute: async (input: { output: string }, context) => {
        enteredResolve();
        await release;
        const writer = await StreamingToolOutputFile.open(workspace, context.outputArtifactId);
        await writer.append(input.output);
        await context.registerPersistedOutput(await writer.close());
        return { title: "active call", output: "preview" };
      },
    });
    const executor = createExecutor(registry);
    const callId = "toolcall_active_duplicate" as ToolCallId;
    const firstPromise = executor.execute(toolInput("active_call_id", { output: "AAAA" }, workspace, callId));
    await entered;

    const duplicate = await executor.execute(toolInput("active_call_id", { output: "BBBB" }, workspace, callId));
    releaseResolve();
    const first = await firstPromise;

    expect(first.status).toBe("completed");
    expect(duplicate.status).toBe("failed");
    if (duplicate.status === "failed") expect(duplicate.error.message).toContain("already active");
    if (first.status === "completed") {
      expect(await readFile(join(workspace, String(first.result.metadata?.outputPath)), "utf8")).toBe("AAAA");
    }
  } finally {
    releaseResolve();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor keeps sidecars distinct when provider call ids repeat across turns", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-repeated-call-id-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "repeated_call_id",
      description: "Persist output for a provider call id that may be reused.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      execute: async (input: { output: string }, context) => {
        const writer = await StreamingToolOutputFile.open(workspace, context.outputArtifactId);
        await writer.append(input.output);
        await context.registerPersistedOutput(await writer.close());
        return { title: "repeated call", output: "preview" };
      },
    });
    const executor = createExecutor(registry);
    const callId = "tool_0" as ToolCallId;
    const firstInput = toolInput("repeated_call_id", { output: "AAAA" }, workspace, callId);
    firstInput.turnId = "turn_repeat_1" as TurnId;
    const secondInput = toolInput("repeated_call_id", { output: "BBBB" }, workspace, callId);
    secondInput.turnId = "turn_repeat_2" as TurnId;

    const first = await executor.execute(firstInput);
    const second = await executor.execute(secondInput);

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed") return;
    const firstPath = String(first.result.metadata?.outputPath);
    const secondPath = String(second.result.metadata?.outputPath);
    expect(firstPath).not.toBe(secondPath);
    expect(await readFile(join(workspace, firstPath), "utf8")).toBe("AAAA");
    expect(await readFile(join(workspace, secondPath), "utf8")).toBe("BBBB");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor never persists a preview after rejecting a sidecar with a looser byte limit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-registration-limit-"));
  let registrationError = "";
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "loose_registration",
      description: "Register a sidecar created outside executor limits.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 4,
      execute: async (_input, context) => {
        const writer = await StreamingToolOutputFile.open(
          workspace,
          context.outputArtifactId,
        );
        await writer.append("COMPLETE_FULL_OUTPUT");
        const persisted = await writer.close();
        try {
          await context.registerPersistedOutput(persisted);
        } catch (error) {
          registrationError = error instanceof Error ? error.message : String(error);
        }
        await unlink(persisted.absolutePath);
        return { title: "loose registration", output: "preview-only" };
      },
    });
    const executor = createExecutor(registry, undefined, undefined, undefined, {
      maxPersistedOutputBytes: 4,
      maxPersistedOutputDirectoryBytes: 4,
    });

    const result = await executor.execute(
      toolInput("loose_registration", {}, workspace, "toolcall_loose_registration" as ToolCallId),
    );

    expect(registrationError).toContain("limit mismatch");
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.output).toContain("registered output artifact unavailable");
    expect(result.result.output).not.toContain("saved to");
    expect(result.result.metadata?.outputPath).toBeUndefined();
    expect(result.result.metadata?.outputPersistenceError).toContain("limit mismatch");
    const artifactNames = (await readdir(join(workspace, ".chili", "tool-results")))
      .filter((name) => name.endsWith(".txt"));
    expect(artifactNames).toEqual([]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor rejects untrusted accessor-backed registrations without evaluating fields", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-output-getters-"));
  const forgedPath = join(".chili", "tool-results", "toolcall_output_getters.txt");
  let pathReads = 0;
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "output_getters",
      description: "Register accessor-backed output metadata.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 4,
      execute: async (_input, context) => {
        await context.registerPersistedOutput({
          get relativePath() {
            pathReads += 1;
            return pathReads <= 3 ? forgedPath : "../../forged.txt";
          },
          bytes: 8,
          originalBytes: 8,
          limitBytes: 1024,
          truncated: false,
        }).catch(() => undefined);
        return { title: "getter output", output: "abcdefgh" };
      },
    });

    const result = await createExecutor(registry).execute(
      toolInput("output_getters", {}, workspace, "toolcall_output_getters" as ToolCallId),
    );

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(pathReads).toBe(0);
    expect(result.result.metadata?.outputPath).toBeUndefined();
    expect(result.result.metadata?.outputPersistenceError).toContain("not created by Chili storage");
    expect(result.result.output).toContain("registered output artifact unavailable");
    expect(result.result.output).not.toContain("../../forged.txt");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor revalidates a registered sidecar immediately before reuse", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-output-revalidation-"));
  let absolutePath = "";
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "output_revalidation",
      description: "Delete a registered sidecar before returning.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 4,
      execute: async (_input, context) => {
        const writer = await StreamingToolOutputFile.open(
          workspace,
          context.outputArtifactId,
        );
        await writer.append("COMPLETE_FULL_OUTPUT");
        const persisted = await writer.close();
        absolutePath = persisted.absolutePath;
        await context.registerPersistedOutput(persisted);
        await unlink(persisted.absolutePath);
        return { title: "revalidated output", output: "preview-only" };
      },
    });

    const result = await createExecutor(registry).execute(
      toolInput("output_revalidation", {}, workspace, "toolcall_output_revalidation" as ToolCallId),
    );

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.metadata?.outputPath).toBeUndefined();
    expect(typeof result.result.metadata?.outputPersistenceError).toBe("string");
    expect(result.result.output).toContain("registered output artifact unavailable");
    expect(result.result.output).not.toContain("full output saved");
    await expectRejectsWith(readFile(absolutePath, "utf8"), "ENOENT");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor does not rewrite tool payload text when registered output becomes invalid", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-output-text-integrity-"));
  let literal = "";
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "output_text_integrity",
      description: "Return payload text that resembles an executor notice.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 1_000,
      execute: async (_input, context) => {
        const writer = await StreamingToolOutputFile.open(
          workspace,
          context.outputArtifactId,
        );
        await writer.append("complete output");
        const persisted = await writer.close();
        literal = `payload says full output saved to ${persisted.relativePath}`;
        await context.registerPersistedOutput(persisted);
        await unlink(persisted.absolutePath);
        return { title: "text integrity", output: literal };
      },
    });

    const result = await createExecutor(registry).execute(
      toolInput("output_text_integrity", {}, workspace, "toolcall_output_text_integrity" as ToolCallId),
    );

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.output).toStartWith(literal);
    expect(result.result.output).toContain("registered output artifact unavailable");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor rejects forged persisted output metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-forged-output-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "forged_output",
      description: "Return a forged persisted-output path.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 4,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => ({
        title: "forged output",
        output: "abcdefgh",
        metadata: {
          outputPath: "../../not-created.txt",
          outputPersistedBytes: 8,
          outputPersistedLimitBytes: 8,
          outputPersistedTruncated: false,
        },
      }),
    });
    const executor = createExecutor(registry);

    const result = await executor.execute(
      toolInput("forged_output", {}, workspace, "toolcall_forged_output" as ToolCallId),
    );

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const safePath = String(result.result.metadata?.outputPath);
    expect(result.result.output).toContain(`full output saved to ${safePath}`);
    expect(result.result.output).not.toContain("../../not-created.txt");
    expect(result.result.metadata?.outputPath).toBe(safePath);
    expect(await readFile(join(workspace, safePath), "utf8")).toBe("abcdefgh");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor caps persisted large output sidecars", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-output-sidecar-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "large",
      description: "Emit a large result.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 4,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => ({ title: "large", output: "abcdefghij" }),
    });
    const executor = createExecutor(registry, undefined, undefined, undefined, { maxPersistedOutputBytes: 6 });

    const result = await executor.execute(toolInput("large", {}, workspace, "toolcall_large_capped" as ToolCallId));

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.output).toContain("first 6 of 10 bytes saved");
    expect(result.result.metadata).toMatchObject({
      outputTruncated: true,
      outputBytes: 10,
      outputLimitBytes: 4,
      outputPersistedBytes: 6,
      outputPersistedLimitBytes: 6,
      outputPersistedTruncated: true,
    });
    const outputPath = String(result.result.metadata?.outputPath);
    expect(await readFile(join(workspace, outputPath), "utf8")).toBe("abcdef");
    expect((await stat(join(workspace, outputPath))).size).toBe(6);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor keeps persisted output within byte limits at UTF-8 boundaries", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-output-sidecar-utf8-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "large_utf8",
      description: "Emit multibyte output.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 1,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => ({ title: "large utf8", output: "ééé" }),
    });
    const executor = createExecutor(registry, undefined, undefined, undefined, { maxPersistedOutputBytes: 3 });

    const result = await executor.execute(toolInput("large_utf8", {}, workspace, "toolcall_large_utf8" as ToolCallId));

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const sidecar = join(workspace, String(result.result.metadata?.outputPath));
    expect(await readFile(sidecar, "utf8")).toBe("é");
    expect((await stat(sidecar)).size).toBeLessThanOrEqual(3);
    expect(result.result.output).not.toContain("�");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor evicts old sidecars to enforce a directory byte budget", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-output-retention-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "large",
      description: "Emit a large result.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 4,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => ({ title: "large", output: "abcdefgh" }),
    });
    const executor = createExecutor(registry, undefined, undefined, undefined, {
      maxPersistedOutputBytes: 6,
      maxPersistedOutputDirectoryBytes: 8,
    });

    const oldResult = await executor.execute(toolInput("large", {}, workspace, "toolcall_old" as ToolCallId));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const newResult = await executor.execute(toolInput("large", {}, workspace, "toolcall_new" as ToolCallId));

    expect(oldResult.status).toBe("completed");
    expect(newResult.status).toBe("completed");
    if (oldResult.status !== "completed" || newResult.status !== "completed") return;
    const oldPath = String(oldResult.result.metadata?.outputPath);
    const newPath = String(newResult.result.metadata?.outputPath);
    await expectRejectsWith(readFile(join(workspace, oldPath), "utf8"), "ENOENT");
    expect(await readFile(join(workspace, newPath), "utf8")).toBe("abcdef");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor preserves a completed side effect when sidecar persistence is unsafe", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-tools-output-symlink-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const sideEffectMarker = join(workspace, "side-effect.txt");
  const events: ChiliEvent[] = [];
  try {
    await mkdir(join(workspace, ".chili"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(workspace, ".chili", "tool-results"), "dir");
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "large",
      description: "Emit a large result.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 4,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => {
        await writeFile(sideEffectMarker, "completed\n", "utf8");
        return { title: "large", output: "abcdSECRET_REMAINDER" };
      },
    });
    const executor = createExecutor(registry, undefined, undefined, events);

    const result = await executor.execute(toolInput("large", {}, workspace, "toolcall_symlink" as ToolCallId));

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(await readFile(sideEffectMarker, "utf8")).toBe("completed\n");
    expect(result.result.output).toStartWith("abcd\n[tool output truncated after 4 bytes;");
    expect(result.result.output).not.toContain("SECRET_REMAINDER");
    expect(result.result.metadata?.outputTruncated).toBe(true);
    expect(result.result.metadata?.outputPersistenceError).toContain("stay inside the workspace");
    expect(result.result.metadata?.outputPath).toBeUndefined();
    const finished = events.find(
      (event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished",
    );
    expect(finished?.payload.status).toBe("completed");
    expect(finished?.payload.output).not.toContain("SECRET_REMAINDER");
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool executor uses opaque sidecar filenames independent of provider call ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-tools-output-sidecar-path-"));
  const workspace = join(root, "workspace");
  try {
    await mkdir(workspace, { recursive: true });
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "large",
      description: "Emit a large result.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 4,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => ({ title: "large", output: "abcdefgh" }),
    });
    const executor = createExecutor(registry);

    const result = await executor.execute(toolInput("large", {}, workspace, "../../../escape" as ToolCallId));

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const outputPath = String(result.result.metadata?.outputPath);
    expect(outputPath).toStartWith(join(".chili", "tool-results"));
    expect(outputPath).not.toContain("..");
    expect(outputPath.split(/[\\/]/).at(-1)).toMatch(/^tooloutput_[a-f0-9-]{36}\.txt$/);
    expect(await readFile(join(workspace, outputPath), "utf8")).toBe("abcdefgh");
    await expectRejectsWith(readFile(join(root, "escape.txt"), "utf8"), "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scoped worker policy hides and rejects unauthorized write tools", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-readonly-"));
  try {
    const registry = registryWithCoreTools();
    registry.register(createApplyPatchTool());
    const executor = createExecutor(registry, {
      resolve: () => ({
        allowedTools: ["read", "tool_search"],
        writeScope: [],
      }),
    });

    const search = await executor.execute(toolInput("tool_search", { query: "write" }, workspace));
    expect(search.status).toBe("completed");
    if (search.status === "completed") expect(search.result.output).not.toContain("write:");

    const write = await executor.execute(toolInput("write", { filePath: "src/a.ts", content: "x" }, workspace));
    expect(write.status).toBe("failed");
    if (write.status === "failed") expect(write.error.message).toContain("not allowed by the current worker policy");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scoped worker policy enforces write scope for write and apply_patch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-write-"));
  try {
    const registry = registryWithCoreTools();
    registry.register(createApplyPatchTool());
    const executor = createExecutor(registry, {
      resolve: () => ({
        allowedTools: ["write", "apply_patch"],
        writeScope: ["packages/core"],
      }),
    });

    const inScope = await executor.execute(toolInput("write", { filePath: "packages/core/a.ts", content: "ok\n" }, workspace));
    expect(inScope.status).toBe("completed");

    const outOfScope = await executor.execute(toolInput("write", { filePath: "packages/server/a.ts", content: "no\n" }, workspace));
    expect(outOfScope.status).toBe("failed");
    if (outOfScope.status === "failed") expect(outOfScope.error.message).toContain("outside this worker's write scope");

    const patch = await executor.execute(
      toolInput(
        "apply_patch",
        {
          operations: [
            { type: "create", path: "packages/core/b.ts", content: "ok\n" },
            { type: "create", path: "packages/server/b.ts", content: "no\n" },
          ],
        },
        workspace,
      ),
    );
    expect(patch.status).toBe("failed");
    if (patch.status === "failed") expect(patch.error.message).toContain("outside this worker's write scope");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scoped worker policy allows only read-only bash without execute scope", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-bash-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool());
    const executor = createExecutor(registry, {
      resolve: () => ({
        allowedTools: ["bash"],
        executeScope: [],
      }),
    });

    const readOnly = await executor.execute(toolInput("bash", { command: "pwd" }, workspace));
    expect(readOnly.status).toBe("completed");

    for (const command of ["git branch", "git branch --list", "git status", "git diff"]) {
      const result = await executor.execute(toolInput("bash", { command }, workspace));
      expect(result.status).toBe("completed");
    }

    const build = await executor.execute(toolInput("bash", { command: "bun test" }, workspace));
    expect(build.status).toBe("failed");
    if (build.status === "failed") expect(build.error.message).toContain("does not have execute scope");

    const findDelete = await executor.execute(toolInput("bash", { command: "find . -delete" }, workspace));
    expect(findDelete.status).toBe("failed");
    if (findDelete.status === "failed") expect(findDelete.error.message).toContain("does not have execute scope");

    for (const command of ["sed -i 's/a/b/' file", "awk -i inplace '{print}' file", "git branch -D foo"]) {
      const result = await executor.execute(toolInput("bash", { command }, workspace));
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.error.message).toContain("does not have execute scope");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scoped worker policy rejects unsandboxed bash even with broad execute scope", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-unsandboxed-bash-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool());
    const executor = createExecutor(registry, {
      resolve: () => ({
        allowedTools: ["bash"],
        executeScope: ["*"],
      }),
    });

    const result = await executor.execute(toolInput("bash", {
      command: "remindctl status",
      sandboxPermissions: "require_escalated",
      justification: "Check whether Reminders access is available.",
    }, workspace));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.message).toContain("cannot request execution outside the host sandbox");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scoped worker policy also rejects dynamic unsandboxed approval requests", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-dynamic-unsandboxed-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "dynamic_approval",
      description: "Request another permission while executing.",
      risk: "execute",
      inputSchema: { type: "object" },
      approval: () => false,
      async execute(_input, context) {
        await context.requestApproval({
          permission: "bash.unsandboxed",
          patterns: ["remindctl status"],
          maxApprovalScope: "once",
        });
        return { title: "dynamic_approval", output: "unexpected" };
      },
    });
    const executor = createExecutor(registry, {
      resolve: () => ({ allowedTools: ["dynamic_approval"], executeScope: ["*"] }),
    });

    const result = await executor.execute(toolInput("dynamic_approval", {}, workspace));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.message).toContain("cannot request execution outside the host sandbox");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("child-style bash registries do not expose or accept sandbox escalation", async () => {
  const tool = createBashTool({ allowEscalation: false });
  expect(tool.description).not.toContain("elevated execution");
  expect(JSON.stringify(tool.inputSchema)).not.toContain("sandboxPermissions");
  expect(JSON.stringify(tool.inputSchema)).not.toContain("sandbox_permissions");
  expect(await tool.validate?.({
    command: "remindctl status",
    sandbox_permissions: "require_escalated",
    justification: "access Reminders",
  })).toEqual({
    ok: false,
    message: "sandbox escalation is unavailable for this tool registry",
  });
});

test("bash supports workspace-scoped cwd and env overrides", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-bash-cwd-"));
  try {
    await mkdir(join(workspace, "subdir"), { recursive: true });
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool());
    const executor = createExecutor(registry);

    const result = await executor.execute(
      toolInput("bash", { command: "printf \"$CHILI_TEST_ENV:$(basename \"$PWD\")\"", cwd: "subdir", env: { CHILI_TEST_ENV: "ok" } }, workspace),
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result.output).toBe("ok:subdir");
      expect(result.result.metadata).toMatchObject({
        sandboxPermissions: "use_default",
        executionMode: "unsandboxed",
        sandbox: "none",
        timedOut: false,
        stdoutBytes: 9,
        outputLimitBytes: 256_000,
      });
    }

    const absoluteInside = await executor.execute(
      toolInput("bash", { command: "basename \"$PWD\"", cwd: join(workspace, "subdir") }, workspace),
    );
    expect(absoluteInside.status).toBe("completed");
    if (absoluteInside.status === "completed") expect(absoluteInside.result.output).toBe("subdir\n");

    const outside = await executor.execute(toolInput("bash", { command: "pwd", cwd: ".." }, workspace));
    expect(outside.status).toBe("failed");
    if (outside.status === "failed") {
      expect(outside.error.message).toContain("cwd must stay inside the authoritative workspace");
      expect(outside.error.message).toContain(workspace);
      expect(outside.error.message).toContain(": ..");
    }

    const absoluteOutsidePath = join(workspace, "..");
    const absoluteOutside = await executor.execute(
      toolInput("bash", { command: "pwd", cwd: absoluteOutsidePath }, workspace),
    );
    expect(absoluteOutside.status).toBe("failed");
    if (absoluteOutside.status === "failed") {
      expect(absoluteOutside.error.message).toContain(`inside the authoritative workspace ${workspace}`);
      expect(absoluteOutside.error.message).toContain(`: ${absoluteOutsidePath}`);
    }

    const missing = await executor.execute(toolInput("bash", { command: "pwd", cwd: "missing" }, workspace));
    expect(missing.status).toBe("failed");
    if (missing.status === "failed") {
      expect(missing.error.message).toContain("cwd must resolve to an existing directory inside the authoritative workspace");
      expect(missing.error.message).toContain(`${workspace}: missing`);
    }

    await writeFile(join(workspace, "not-a-directory.txt"), "file\n", "utf8");
    const fileCwd = await executor.execute(toolInput("bash", { command: "pwd", cwd: "not-a-directory.txt" }, workspace));
    expect(fileCwd.status).toBe("failed");
    if (fileCwd.status === "failed") {
      expect(fileCwd.error.message).toContain("cwd must resolve to an existing directory inside the authoritative workspace");
      expect(fileCwd.error.message).toContain("resolved path is not a directory");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash validates and normalizes explicit sandbox escalation requests", async () => {
  const tool = createBashTool();
  const schema = JSON.stringify(tool.inputSchema);
  expect(schema).toContain("authoritative workspace root");
  expect(schema).toContain("absolute paths must remain inside it");
  expect(schema).toContain("working_directory");

  expect(await tool.validate?.({
    command: "pwd",
    cwd: "subdir",
    workingDirectory: "other",
  })).toEqual({
    ok: false,
    message: "cwd, workingDirectory, and working_directory must match when multiple aliases are provided",
  });

  expect(await tool.validate?.({
    command: "pwd",
    workingDirectory: "subdir",
    working_directory: "subdir",
  })).toEqual({
    ok: true,
    value: {
      command: "pwd",
      sandboxPermissions: "use_default",
      cwd: "subdir",
    },
  });

  const missingJustification = await tool.validate?.({
    command: "osascript -e 'return 1'",
    sandbox_permissions: "require_escalated",
  });
  expect(missingJustification).toEqual({
    ok: false,
    message: "justification must be a non-empty string when sandboxPermissions is require_escalated",
  });

  const mismatchedAliases = await tool.validate?.({
    command: "pwd",
    sandboxPermissions: "use_default",
    sandbox_permissions: "require_escalated",
    justification: "needs desktop IPC",
  });
  expect(mismatchedAliases).toEqual({
    ok: false,
    message: "sandboxPermissions and sandbox_permissions must match when both are provided",
  });

  const hiddenEnvironment = await tool.validate?.({
    command: "remindctl status",
    sandbox_permissions: "require_escalated",
    justification: "access Reminders through desktop IPC",
    env: { PATH: "/tmp/unreviewed-bin" },
  });
  expect(hiddenEnvironment).toEqual({
    ok: false,
    message: "env overrides are not allowed when sandboxPermissions is require_escalated",
  });

  for (const command of ["remindctl\tstatus", "remindctl status\u001b[2J"]) {
    expect(await tool.validate?.({
      command,
      sandbox_permissions: "require_escalated",
      justification: "access Reminders through desktop IPC",
    })).toEqual({
      ok: false,
      message: "elevated command must not contain control or bidirectional formatting characters",
    });
  }
  expect(await tool.validate?.({
    command: "remindctl status",
    sandbox_permissions: "require_escalated",
    justification: "access Reminders\u202e through desktop IPC",
  })).toEqual({
    ok: false,
    message: "elevated justification must not contain control or bidirectional formatting characters",
  });

  const validated = await tool.validate?.({
    command: "osascript -e 'return 1'",
    sandbox_permissions: "require_escalated",
    justification: "  access Reminders through desktop IPC  ",
    cwd: "subdir",
  });
  expect(validated).toEqual({
    ok: true,
    value: {
      command: "osascript -e 'return 1'",
      sandboxPermissions: "require_escalated",
      justification: "access Reminders through desktop IPC",
      cwd: "subdir",
    },
  });
  if (!validated?.ok) return;
  expect(tool.approval?.(validated.value)).toMatchObject({
    permission: "bash.unsandboxed",
    patterns: ["osascript -e 'return 1'"],
    maxApprovalScope: "once",
    metadata: {
      sandboxPermissions: "require_escalated",
      justification: "access Reminders through desktop IPC",
      cwd: "subdir",
      envKeys: [],
    },
  });
});

test("bash reports the actual sandbox execution mode in result metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-bash-sandbox-metadata-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool({
      runner: {
        async run(request) {
          return {
            exitCode: 0,
            signal: null,
            stdout: "ok",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutBytes: 2,
            stderrBytes: 0,
            outputLimitBytes: request.maxOutputBytes,
            durationMs: 1,
            timedOut: false,
            aborted: false,
            sandbox: "macos-seatbelt",
          };
        },
      },
    }));
    const executor = createExecutor(registry);

    const result = await executor.execute(toolInput("bash", { command: "pwd" }, workspace));

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.metadata).toMatchObject({
      sandboxPermissions: "use_default",
      executionMode: "sandboxed",
      sandbox: "macos-seatbelt",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash publishes live stdout and stderr tool output deltas", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-bash-stream-"));
  const events: ChiliEvent[] = [];
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool());
    const executor = createExecutor(registry, undefined, undefined, events);

    const result = await executor.execute(
      toolInput("bash", { command: "printf out1; printf err1 >&2; sleep 0.05; printf out2; printf err2 >&2" }, workspace, "toolcall_bash_stream" as ToolCallId),
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result.output).toContain("out1out2");
      expect(result.result.output).toContain("[stderr]\nerr1err2");
    }

    const deltas = events.filter((event): event is Extract<ChiliEvent, { type: "tool.output_delta" }> => event.type === "tool.output_delta");
    expect(deltas.map((event) => String(event.payload.callId))).toEqual(deltas.map(() => "toolcall_bash_stream"));
    expect(deltas.filter((event) => event.payload.stream === "stdout").map((event) => event.payload.delta).join("")).toBe("out1out2");
    expect(deltas.filter((event) => event.payload.stream === "stderr").map((event) => event.payload.delta).join("")).toBe("err1err2");
    expect(events.at(-1)?.type).toBe("tool.call_finished");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash limits verbose output by line count and persists complete output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-bash-lines-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool());
    const executor = createExecutor(registry);

    const result = await executor.execute(
      toolInput("bash", { command: "seq 3000" }, workspace, "toolcall_bash_lines" as ToolCallId),
    );

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.output).toStartWith("[command output truncated:");
    expect(result.result.output).toContain("1001\n");
    expect(result.result.output).toContain("2999\n3000\n");
    expect(result.result.output).not.toContain("\n1\n2\n3\n");
    expect(result.result.output.split("\n").length).toBeLessThanOrEqual(2_010);
    const outputPath = String(result.result.metadata?.outputPath);
    expect(outputPath).toStartWith(join(".chili", "tool-results"));
    const sidecar = await readFile(join(workspace, outputPath), "utf8");
    expect(sidecar).toStartWith("1\n2\n3\n");
    expect(sidecar).toEndWith("2998\n2999\n3000\n");
    expect(result.result.metadata).toMatchObject({
      outputTruncated: true,
      outputLines: 3_000,
      outputPreviewLines: 2_000,
      outputPersistedTruncated: false,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash persists complete verbose output beyond the legacy capture cap", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-bash-bytes-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool());
    const executor = createExecutor(registry);
    const command = `node -e 'process.stdout.write("x".repeat(300000)); process.stdout.write("\\nFINAL_CAPTURE_MARKER\\n")'`;

    const result = await executor.execute(
      toolInput("bash", { command }, workspace, "toolcall_bash_bytes" as ToolCallId),
    );

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.output).toContain("FINAL_CAPTURE_MARKER");
    expect(Number(result.result.metadata?.outputBytes)).toBeGreaterThan(256_000);
    const outputPath = String(result.result.metadata?.outputPath);
    expect(await readFile(join(workspace, outputPath), "utf8")).toEndWith("FINAL_CAPTURE_MARKER\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash reports partial artifacts without comparing formatted and raw byte counts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-bash-artifact-bytes-"));
  try {
    const chunk = Buffer.alloc(8 * 1024, 120);
    const chunks = 140;
    const runner: BashRunner = {
      async run(request) {
        for (let index = 0; index < chunks; index += 1) {
          await request.onRawOutput?.({
            stream: index % 2 === 0 ? "stdout" : "stderr",
            chunk,
          });
        }
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: true,
          stderrTruncated: true,
          stdoutBytes: (chunks / 2) * chunk.byteLength,
          stderrBytes: (chunks / 2) * chunk.byteLength,
          outputLimitBytes: 256_000,
          durationMs: 1,
          timedOut: false,
          aborted: false,
        };
      },
    };
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool({ runner }));
    const executor = createExecutor(registry);

    const result = await executor.execute(
      toolInput("bash", { command: "printf fake" }, workspace, "toolcall_bash_artifact_bytes" as ToolCallId),
    );

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.metadata?.outputPersistedTruncated).toBe(true);
    expect(result.result.output).toContain("first 1048576 of 1148270 bytes saved");
    expect(result.result.output).not.toContain("first 1048576 of 1146880");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash runner injection receives resolved request and formats process output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-bash-runner-"));
  const events: ChiliEvent[] = [];
  const controller = new AbortController();
  let seen: BashRunRequest | undefined;
  try {
    await mkdir(join(workspace, "subdir"), { recursive: true });
    const runner: BashRunner = {
      async run(request) {
        seen = request;
        await request.onOutput?.({ stream: "stdout", delta: "live-out" });
        await request.onOutput?.({ stream: "stderr", delta: "live-err" });
        return {
          exitCode: null,
          signal: "SIGTERM",
          stdout: "captured stdout",
          stderr: "captured stderr",
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutBytes: 15,
          stderrBytes: 15,
          outputLimitBytes: request.maxOutputBytes,
          durationMs: 42,
          timedOut: true,
          aborted: false,
        };
      },
    };
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool({ runner }));
    const executor = createExecutor(registry, undefined, undefined, events);
    const input = toolInput(
      "bash",
      {
        command: "printf fake",
        cwd: "subdir",
        timeoutMs: 123,
        maxOutputBytes: 17,
        sandbox_permissions: "require_escalated",
        justification: "  needs desktop IPC  ",
      },
      workspace,
      "toolcall_fake_bash_runner" as ToolCallId,
    );
    input.signal = controller.signal;

    const result = await executor.execute(input);

    expect(result.status).toBe("completed");
    expect(seen).toMatchObject({
      command: "printf fake",
      workspaceRoot: workspace,
      cwd: join(workspace, "subdir"),
      timeoutMs: 123,
      maxOutputBytes: 17,
      sandboxPermissions: "require_escalated",
      signal: controller.signal,
    });
    expect(typeof seen?.onOutput).toBe("function");
    if (result.status === "completed") {
      expect(result.result.title).toBe("timed out after 123ms");
      expect(result.result.output).toContain("captured stdout");
      expect(result.result.output).toContain("[stderr]\ncaptured stderr");
      expect(result.result.output).toContain("[process timed out after 123ms and was terminated]");
      expect(result.result.metadata).toMatchObject({
        command: "printf fake",
        cwd: join(workspace, "subdir"),
        envKeys: [],
        sandboxPermissions: "require_escalated",
        executionMode: "unsandboxed",
        justification: "needs desktop IPC",
        sandbox: "none",
        signal: "SIGTERM",
        timedOut: true,
        stdoutBytes: 15,
        stderrBytes: 15,
        outputLimitBytes: 17,
      });
    }
    const deltas = events.filter((event): event is Extract<ChiliEvent, { type: "tool.output_delta" }> => event.type === "tool.output_delta");
    expect(deltas.map((event) => event.payload.delta)).toEqual(["live-out", "live-err"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash approval metadata is unchanged by runner injection", () => {
  const runner: BashRunner = {
    async run() {
      throw new Error("not used");
    },
  };
  const input = {
    command: "rm -rf *",
    cwd: "subdir",
    env: { ZED: "1", ALPHA: "2" },
  };

  expect(createBashTool({ runner }).approval?.(input)).toEqual(createBashTool().approval?.(input));
});

test("snapshot creation failure fails closed before write tools mutate files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-snapshot-fail-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(createWriteFileTool());
    const executor = createExecutor(registry, undefined, failingSnapshotProvider());

    const result = await executor.execute(toolInput("write", { filePath: "new.txt", content: "next\n" }, workspace));
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error.message).toContain("Snapshot failed before write");
    await expect(stat(join(workspace, "new.txt"))).rejects.toThrow();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scoped worker policy allows scoped team task updates without file write scope", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-team-task-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(fakeTeamTaskUpdateTool());
    registry.register(createToolSearchTool(registry));
    const executor = createExecutor(registry, {
      resolve: () => ({
        allowedTools: ["team_task_update", "tool_search"],
        writeScope: [],
        teamId: "team_1",
        taskId: "task_1",
        memberPath: "/root/worker",
      }),
    });

    const search = await executor.execute(toolInput("tool_search", { query: "select:team_task_update" }, workspace));
    expect(search.status).toBe("completed");
    if (search.status === "completed") expect(search.result.output).toContain("team_task_update:");

    const update = await executor.execute(
      toolInput("team_task_update", {
        teamId: "team_1",
        taskId: "task_1",
        status: "in_progress",
        summary: "halfway",
        metadata: { workerProgress: { percent: 50 } },
      }, workspace),
    );
    expect(update.status).toBe("completed");

    const otherTask = await executor.execute(
      toolInput("team_task_update", { teamId: "team_1", taskId: "task_2", summary: "no" }, workspace),
    );
    expect(otherTask.status).toBe("failed");
    if (otherTask.status === "failed") expect(otherTask.error.message).toContain("team task scope");

    for (const status of ["pending", "blocked", "completed", "failed", "cancelled"]) {
      const result = await executor.execute(
        toolInput("team_task_update", { teamId: "team_1", taskId: "task_1", status }, workspace),
      );
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.error.message).toContain("complete_task");
    }

    for (const metadata of [
      { verification: { status: "passed" } },
      { merge: { status: "pending" } },
      { worktree: null },
      { chiliTeamDispatch: null },
      { writeScope: ["."] },
    ]) {
      const result = await executor.execute(
        toolInput("team_task_update", { teamId: "team_1", taskId: "task_1", metadata }, workspace),
      );
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.error.message).toContain("runtime-owned");
    }

    for (const updateInput of [
      { ownerPath: "/root/worker" },
      { title: "rewrite" },
      { description: "rewrite" },
      { dependsOn: [] },
      { error: "pretend failure" },
    ]) {
      const result = await executor.execute(toolInput("team_task_update", {
        teamId: "team_1",
        taskId: "task_1",
        ...updateInput,
      }, workspace));
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.error.message).toContain("cannot change team task field");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scoped worker policy restricts team messages to the worker identity", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-team-message-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(fakeTeamMessageSendTool());
    const executor = createExecutor(registry, {
      resolve: () => ({
        allowedTools: ["team_message_send"],
        writeScope: [],
        teamId: "team_1",
        taskId: "task_1",
        memberPath: "/root/worker",
      }),
    });

    const message = await executor.execute(
      toolInput(
        "team_message_send",
        {
          teamId: "team_1",
          from: "/root/worker",
          to: "/root/lead",
          content: "done",
          taskId: "task_1",
        },
        workspace,
      ),
    );
    expect(message.status).toBe("completed");

    const impersonation = await executor.execute(
      toolInput(
        "team_message_send",
        {
          teamId: "team_1",
          from: "/root/other",
          to: "/root/lead",
          content: "no",
          taskId: "task_1",
        },
        workspace,
      ),
    );
    expect(impersonation.status).toBe("failed");
    if (impersonation.status === "failed") expect(impersonation.error.message).toContain("member path");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scoped worker policy confines direct agent messages to parent and descendants", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-agent-message-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(fakeAgentMessageSendTool());
    const executor = createExecutor(registry, {
      resolve: () => ({
        allowedTools: ["agent_message_send"],
        writeScope: [],
        memberPath: "/root/worker",
      }),
    });

    for (const to of ["parent", "/root", "/root/worker/reader"]) {
      const allowed = await executor.execute(toolInput(
        "agent_message_send",
        { from: "/root/worker", to, content: "hello" },
        workspace,
      ));
      expect(allowed.status).toBe("completed");
    }

    const sibling = await executor.execute(toolInput(
      "agent_message_send",
      { from: "/root/worker", to: "/root/other", content: "no" },
      workspace,
    ));
    expect(sibling.status).toBe("failed");
    if (sibling.status === "failed") expect(sibling.error.message).toContain("parent or descendants");

    const impersonation = await executor.execute(toolInput(
      "agent_message_send",
      { from: "/root/other", to: "parent", content: "no" },
      workspace,
    ));
    expect(impersonation.status).toBe("failed");
    if (impersonation.status === "failed") expect(impersonation.error.message).toContain("sender");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function registryWithCoreTools(): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createReadImageTool());
  registry.register(createEditTool());
  registry.register(createWriteFileTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(createToolSearchTool(registry));
  return registry;
}

function fakeTeamTaskUpdateTool() {
  return {
    name: "team_task_update",
    description: "Update status, owner, summary, or metadata for a team task.",
    risk: "write" as const,
    inputSchema: { type: "object" },
    approval: (): false => false,
    execute: async () => ({ title: "team_task_update", output: "updated" }),
  };
}

function fakeTeamMessageSendTool() {
  return {
    name: "team_message_send",
    description: "Send a durable message to a team member or broadcast to the team.",
    risk: "write" as const,
    inputSchema: { type: "object" },
    approval: (): false => false,
    execute: async () => ({ title: "team_message_send", output: "sent" }),
  };
}

function fakeAgentMessageSendTool() {
  return {
    name: "agent_message_send",
    description: "Send a direct agent message.",
    risk: "write" as const,
    inputSchema: { type: "object" },
    approval: (): false => false,
    execute: async () => ({ title: "agent_message_send", output: "sent" }),
  };
}

function createExecutor(
  registry: InMemoryToolRegistry,
  policyResolver?: ToolAccessPolicyResolver,
  snapshotProvider?: SnapshotProvider,
  events?: ChiliEvent[],
  outputOptions?: Pick<ToolExecutorOptions, "maxPersistedOutputBytes" | "maxPersistedOutputDirectoryBytes">,
): ToolExecutor {
  return new ToolExecutor({
    registry,
    events: { publish: async (event: ChiliEvent) => { events?.push(event); } },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    ...(policyResolver ? { policyResolver } : {}),
    ...(snapshotProvider ? { snapshotProvider } : {}),
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    ...outputOptions,
  });
}

function toolInput(toolName: string, input: unknown, cwd: string, callId?: ToolCallId): ExecuteToolInput {
  const value: ExecuteToolInput = {
    sessionId: "session_tools" as SessionId,
    turnId: "turn_tools" as TurnId,
    toolName,
    input,
    cwd,
  };
  if (callId) value.callId = callId;
  return value;
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

async function expectRejectsWith(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) expect(error.message).toContain(message);
    return;
  }
  throw new Error(`Expected promise to reject with ${message}`);
}

function failingSnapshotProvider(): SnapshotProvider {
  return {
    async create(): Promise<SnapshotRecord | undefined> {
      throw new Error("snapshot store unavailable");
    },
    async revert(): Promise<SnapshotRevertResult> {
      throw new Error("not used");
    },
  };
}
