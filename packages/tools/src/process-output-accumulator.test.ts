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
      maxBytes: 18,
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
    expect(snapshot.previewBytes).toBeLessThanOrEqual(18);
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
    expect(await readFile(join(workspace, snapshot.outputPath!), "utf8")).toBe(
      "out-one\n[stderr]\nerr-one\n[stdout]\nout-tail\n",
    );
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
