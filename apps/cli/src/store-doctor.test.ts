import { expect, test } from "bun:test";
import type { SqliteEventStoreDiagnostics } from "@chili/store";
import { formatStoreDoctorText } from "./store-doctor.js";

test("formatStoreDoctorText surfaces file and largest-payload diagnostics", () => {
  const report: SqliteEventStoreDiagnostics = {
    path: "/repo/.chili/chili.sqlite",
    files: {
      database: { path: "/repo/.chili/chili.sqlite", exists: true, bytes: 1_024 },
      wal: { path: "/repo/.chili/chili.sqlite-wal", exists: true, bytes: 2_048 },
      shm: { path: "/repo/.chili/chili.sqlite-shm", exists: true, bytes: 32_768 },
    },
    toolResultFiles: {
      path: "/repo/.chili/tool-results",
      exists: true,
      files: 1,
      totalBytes: 49_152,
      largestFiles: [
        { path: "/repo/.chili/tool-results/toolcall_big.txt", exists: true, bytes: 49_152 },
      ],
    },
    configuredWal: {
      autoCheckpointPages: 256,
      journalSizeLimitBytes: 16 * 1024 * 1024,
    },
    pragmas: {
      journalMode: "wal",
      pageSize: 4_096,
      pageCount: 8,
      freelistCount: 1,
    },
    events: {
      rows: 42,
      totalPayloadBytes: 10_240,
      byType: [{ type: "message.part_delta", rows: 30, payloadBytes: 8_192 }],
      bySession: [{ sessionId: "session_hot", rows: 40, payloadBytes: 9_500 }],
      largestPayloads: [{
        id: "event_big",
        type: "tool.call_finished",
        sessionId: "session_hot",
        threadId: "thread_hot",
        time: 1,
        payloadBytes: 4_096,
      }],
    },
    messageParts: {
      rows: 4,
      totalDataBytes: 2_048,
      byType: [{ type: "text", rows: 4, dataBytes: 2_048 }],
      toolResultsByTool: [{ toolName: "read", rows: 3, outputBytes: 16_384 }],
      largestParts: [{
        id: "part_big",
        messageId: "message_big",
        sessionId: "session_hot",
        type: "text",
        dataBytes: 1_536,
      }],
    },
    toolCalls: {
      rows: 2,
      totalOutputBytes: 12_288,
      byTool: [{ toolName: "bash", rows: 2, outputBytes: 12_288 }],
      largestOutputs: [{
        id: "tool_big",
        sessionId: "session_hot",
        threadId: "thread_hot",
        toolName: "bash",
        status: "completed",
        outputBytes: 12_000,
      }],
    },
  };
  const output = formatStoreDoctorText(report);

  expect(output).toContain("Store doctor: /repo/.chili/chili.sqlite");
  expect(output).toContain("wal=2.0 KiB");
  expect(output).toContain("toolcall_big.txt\t48.0 KiB");
  expect(output).toContain("autocheckpoint_pages=256");
  expect(output).toContain("message.part_delta\t30\t8.0 KiB");
  expect(output).toContain("event_big\ttool.call_finished\tsession_hot\t4.0 KiB");
  expect(output).toContain("read\t3\t16.0 KiB");
  expect(output).toContain("tool_big\tbash\tcompleted\t11.7 KiB");
});
