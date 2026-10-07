import type { SessionId, TurnId } from "@chili/protocol";
import { join } from "node:path";
import { createReadFileTool } from "../builtins/read-file.js";
import { createWriteFileTool } from "../builtins/write-file.js";
import { ToolExecutor } from "../executor.js";
import { withFileOperationLocks } from "../file-operation-lock.js";
import { InMemoryToolRegistry } from "../registry.js";

const [mode, workspace, session] = process.argv.slice(2);
if (!workspace || !session) throw new Error("workspace and session required");
if (mode === "hold") {
  await withFileOperationLocks([join(workspace, "a.txt")], new AbortController().signal, async () => {
    process.stdout.write("ready\n");
    await new Promise(() => setInterval(() => undefined, 1_000));
  });
} else {
  const registry = new InMemoryToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createWriteFileTool());
  const executor = new ToolExecutor({
    registry,
    events: { publish: async () => undefined },
    gate: { review: async () => ({ decision: "allow" }) },
  });
  const base = { cwd: workspace, sessionId: session as SessionId, turnId: "turn" as TurnId };
  const read = await executor.execute({ ...base, toolName: "read", input: { filePath: "a.txt" } });
  if (read.status !== "completed") throw read.error;
  process.stdout.write("ready\n");
  await Bun.stdin.text();
  const result = await executor.execute({ ...base, toolName: "write", input: { filePath: "a.txt", content: session } });
  process.stdout.write(`${result.status}\n`);
}
