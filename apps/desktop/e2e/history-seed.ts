import { SqliteEventStore } from "@chili/store";
import type { RuntimeEvent } from "@chili/protocol";

const [database, sessionId] = process.argv.slice(2);
if (!database || !sessionId || !database.includes("chili-electron-e2e-")) throw new Error("History seed requires an isolated E2E database");
const store = new SqliteEventStore(database);
let sequence = 0;
const append = (type: string, payload: unknown) => store.append({ id: `history_fixture_${sequence++}`, time: Date.now(), sessionId, type, payload } as RuntimeEvent);
try {
  for (let i = 0; i < 61; i++) {
    const messageId = `history_message_${i}`;
    await append("message.created", { messageId, role: i % 2 ? "user" : "assistant" });
    await append("message.part_added", { messageId, part: { id: `history_part_${i}`, messageId, sessionId, type: "text",
      text: i === 25 ? "Oversized history body\n" + "中文🙂".repeat(600_000) : `History row ${i}.\n\n` + "Readable paragraph. ".repeat(35) } });
  }
  await append("message.part_added", { messageId: "history_message_60", part: { id: "history_tool_part", messageId: "history_message_60", sessionId, type: "tool_call", callId: "history_tool", toolName: "history_probe", input: {}, status: "completed" } });
  await append("tool.call_started", { callId: "history_tool", turnId: "history_turn", toolName: "history_probe", input: { code: "ARGUMENT_START " + "a".repeat(5_000_000) } });
  await append("tool.call_finished", { callId: "history_tool", status: "completed", output: "OUTPUT_START " + "中🙂".repeat(800_000) });
} finally { store.close(); }
