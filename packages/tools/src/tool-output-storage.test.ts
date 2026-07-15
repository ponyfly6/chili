import { expect, test } from "bun:test";
import type { ToolCallId } from "@chili/protocol";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamingToolOutputFile } from "./tool-output-storage.js";

test("streaming tool output publishes one complete writer for duplicate call ids", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-output-duplicate-call-"));
  try {
    const callId = "toolcall_duplicate" as ToolCallId;
    const first = await StreamingToolOutputFile.open(workspace, callId);
    await first.append("AAAA");
    const second = await StreamingToolOutputFile.open(workspace, callId);
    await second.append("BBBBBBBB");
    await first.append("CCCC");

    await first.close();
    const published = await second.close();

    expect(await readFile(published.absolutePath, "utf8")).toBe("BBBBBBBB");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("streaming tool output refuses a final-path symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-output-final-symlink-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  try {
    await mkdir(join(workspace, ".chili", "tool-results"), { recursive: true });
    await writeFile(outside, "outside-secret", "utf8");
    await symlink(outside, join(workspace, ".chili", "tool-results", "toolcall_symlink.txt"));

    await expect(
      StreamingToolOutputFile.open(workspace, "toolcall_symlink" as ToolCallId),
    ).rejects.toThrow("inside the workspace");
    expect(await readFile(outside, "utf8")).toBe("outside-secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
