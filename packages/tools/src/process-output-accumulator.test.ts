import { expect, test } from "bun:test";
import type { ToolCallId } from "@chili/protocol";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessOutputAccumulator } from "./process-output-accumulator.js";

test("process output accumulator keeps the final 2000 of 3000 lines and persists all output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-lines-"));
  try {
    const accumulator = new ProcessOutputAccumulator({
      cwd: workspace,
      callId: "toolcall_lines" as ToolCallId,
      maxLines: 2_000,
      maxBytes: 1024 * 1024,
    });
    const output = `${Array.from({ length: 3_000 }, (_, index) => index + 1).join("\n")}\n`;
    const bytes = Buffer.from(output);
    for (let offset = 0; offset < bytes.length; offset += 997) {
      await accumulator.append({ stream: "stdout", chunk: bytes.subarray(offset, offset + 997) });
    }

    const snapshot = await accumulator.finish();

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.truncatedBy).toBe("lines");
    expect(snapshot.totalLines).toBe(3_000);
    expect(snapshot.totalBytes).toBe(bytes.byteLength);
    expect(snapshot.preview).toStartWith("1001\n");
    expect(snapshot.preview).toEndWith("2999\n3000\n");
    expect(snapshot.previewLines).toBe(2_000);
    expect(snapshot.outputPath).toBe(join(".chili", "tool-results", "toolcall_lines.txt"));
    expect(await readFile(join(workspace, snapshot.outputPath!), "utf8")).toBe(output);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("process output accumulator keeps a UTF-8-safe interleaved tail and caps its sidecar", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-utf8-"));
  try {
    const accumulator = new ProcessOutputAccumulator({
      cwd: workspace,
      callId: "toolcall_utf8" as ToolCallId,
      maxLines: 100,
      maxBytes: 24,
      maxPersistedBytes: 12,
    });
    const stdout = Buffer.from("开头\n中间\n结尾🙂\n");
    await accumulator.append({ stream: "stdout", chunk: stdout.subarray(0, 2) });
    await accumulator.append({ stream: "stderr", chunk: Buffer.from("错误\n") });
    await accumulator.append({ stream: "stdout", chunk: stdout.subarray(2, 11) });
    await accumulator.append({ stream: "stdout", chunk: stdout.subarray(11) });

    const snapshot = await accumulator.finish();

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.truncatedBy).toBe("bytes");
    expect(snapshot.previewBytes).toBeLessThanOrEqual(24);
    expect(snapshot.preview).toContain("结尾🙂");
    expect(snapshot.preview).not.toContain("�");
    expect(snapshot.persistedBytes).toBeLessThanOrEqual(12);
    expect(snapshot.persistedTruncated).toBe(true);
    expect(await readFile(join(workspace, snapshot.outputPath!), "utf8")).not.toContain("�");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("process output accumulator preserves stdout and stderr identity", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-streams-"));
  try {
    const accumulator = new ProcessOutputAccumulator({
      cwd: workspace,
      callId: "toolcall_streams" as ToolCallId,
      maxLines: 100,
      maxBytes: 5,
    });
    await accumulator.append({ stream: "stdout", chunk: Buffer.from("out-one\n") });
    await accumulator.append({ stream: "stderr", chunk: Buffer.from("err-one\n") });
    await accumulator.append({ stream: "stdout", chunk: Buffer.from("out-tail\n") });

    const snapshot = await accumulator.finish();

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.previewBytes).toBeLessThanOrEqual(5);
    expect(snapshot.previewLines).toBeLessThanOrEqual(100);
    expect(await readFile(join(workspace, snapshot.outputPath!), "utf8")).toBe(
      "out-one\n[stderr]\nerr-one\n[stdout]\nout-tail\n",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("process output accumulator removes partial internal stream markers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-partial-stream-marker-"));
  try {
    const accumulator = new ProcessOutputAccumulator({
      cwd: workspace,
      callId: "toolcall_partial_stream_marker" as ToolCallId,
      maxLines: 100,
      maxBytes: 15,
    });
    await accumulator.append({ stream: "stdout", chunk: Buffer.from("x".repeat(20)) });
    await accumulator.append({ stream: "stderr", chunk: Buffer.from("TAIL") });

    const snapshot = await accumulator.finish();

    expect(snapshot.preview).toBe("[stderr]\nTAIL");
    expect(snapshot.preview).not.toContain("[stderr]\nderr]\n");
    expect(snapshot.previewBytes).toBeLessThanOrEqual(15);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("process output accumulator honors a zero-line preview budget", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-zero-lines-"));
  try {
    const accumulator = new ProcessOutputAccumulator({
      cwd: workspace,
      callId: "toolcall_zero_lines" as ToolCallId,
      maxLines: 0,
      maxBytes: 100,
    });
    await accumulator.append({ stream: "stderr", chunk: Buffer.from("hidden") });

    const snapshot = await accumulator.finish();

    expect(snapshot.preview).toBe("");
    expect(snapshot.previewLines).toBe(0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("process output accumulator keeps stderr identity when the preview starts mid-stream", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-stderr-tail-"));
  try {
    const accumulator = new ProcessOutputAccumulator({
      cwd: workspace,
      callId: "toolcall_stderr_tail" as ToolCallId,
      maxLines: 100,
      maxBytes: 32,
    });
    await accumulator.append({
      stream: "stderr",
      chunk: Buffer.from(`${"e".repeat(100)}\nFINAL_STDERR_MARKER\n`),
    });

    const snapshot = await accumulator.finish();

    expect(snapshot.preview).toStartWith("[stderr]\n");
    expect(snapshot.preview).toContain("FINAL_STDERR_MARKER");
    expect(snapshot.previewBytes).toBeLessThanOrEqual(32);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("literal stream markers in payload do not change preview identity", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-literal-stream-marker-"));
  try {
    const accumulator = new ProcessOutputAccumulator({
      cwd: workspace,
      callId: "toolcall_literal_stream_marker" as ToolCallId,
      maxLines: 100,
      maxBytes: 32,
    });
    await accumulator.append({
      stream: "stderr",
      chunk: Buffer.from(`${"x".repeat(100)}[stdout]\nTAIL_MARKER_12`),
    });

    const snapshot = await accumulator.finish();

    expect(snapshot.preview).toBe("[stderr]\n[stdout]\nTAIL_MARKER_12");
    expect(snapshot.previewBytes).toBeLessThanOrEqual(32);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("literal stderr markers in stdout remain payload", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-literal-stderr-marker-"));
  try {
    const accumulator = new ProcessOutputAccumulator({
      cwd: workspace,
      callId: "toolcall_literal_stderr_marker" as ToolCallId,
      maxLines: 100,
      maxBytes: 24,
    });
    await accumulator.append({
      stream: "stdout",
      chunk: Buffer.from(`${"x".repeat(100)}[stderr]\nSTDOUT_TAIL`),
    });

    const snapshot = await accumulator.finish();

    expect(snapshot.preview).toEndWith("[stderr]\nSTDOUT_TAIL");
    expect(snapshot.preview).not.toStartWith("[stderr]\n");
    expect(snapshot.previewBytes).toBeLessThanOrEqual(24);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("process output accumulator remains bounded when sidecar creation is unsafe", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-output-unsafe-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  try {
    await mkdir(join(workspace, ".chili"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(workspace, ".chili", "tool-results"), "dir");
    const accumulator = new ProcessOutputAccumulator({
      cwd: workspace,
      callId: "toolcall_unsafe" as ToolCallId,
      maxLines: 2,
      maxBytes: 16,
    });
    await accumulator.append({ stream: "stdout", chunk: Buffer.from("one\ntwo\nthree\nfour\n") });

    const snapshot = await accumulator.finish();

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.previewLines).toBeLessThanOrEqual(2);
    expect(snapshot.outputPath).toBeUndefined();
    expect(snapshot.persistenceError).toContain("stay inside the workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
