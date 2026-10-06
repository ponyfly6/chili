import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import { targetPathsForSession } from "./context-targets.js";

const sessionId = "session_targets" as SessionId;
const messageId = "message_targets" as MessageId;
function toolMessage(input: unknown, name = "read"): Message {
  return { id: messageId, sessionId, role: "assistant", createdAt: 1 as TimestampMs, parts: [{
    id: "part_targets" as PartId, messageId, sessionId, type: "tool_call", callId: "call_targets" as ToolCallId,
    toolName: name, input, status: "completed",
  }] };
}

test("context target discovery canonicalizes aliases and bounds missing, patch and external paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-context-targets-"));
  const cwd = join(root, "repo");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "real.ts"), "content");
  await symlink(join(cwd, "src", "real.ts"), join(cwd, "alias.ts"));
  await symlink(root, join(cwd, "escape"));
  try {
    const messages = [
      toolMessage({ path: "alias.ts" }), toolMessage({ file_path: "./src/real.ts" }),
      toolMessage({ paths: ["src/new.ts", "../outside", "escape/outside"] }),
      toolMessage({ operations: [{ path: "src/old.ts", movePath: "src/moved.ts" }] }, "apply_patch"),
      toolMessage({ patchText: "*** Begin Patch\n*** Add File: src/created.ts\n+hello\n*** End Patch" }, "apply_patch"),
      toolMessage({ path: "untrusted-extension.ts" }, "mcp/arbitrary"),
    ];
    const targets = await targetPathsForSession({ messages: async (id) => { expect(id).toBe(sessionId); return messages; } }, sessionId, cwd);
    const canonical = await realpath(cwd);
    expect(new Set(targets)).toEqual(new Set(["src/real.ts", "src/new.ts", "src/old.ts", "src/moved.ts", "src/created.ts"].map((path) => join(canonical, path))));
    const bounded = await targetPathsForSession({ messages: async () => [toolMessage({ paths: Array.from({ length: 500 }, (_, index) => `src/${index}.ts`) })] }, sessionId, cwd);
    expect(bounded).toHaveLength(64);
  } finally { await rm(root, { recursive: true, force: true }); }
});
