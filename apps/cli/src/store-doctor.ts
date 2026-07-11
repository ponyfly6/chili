import { basename } from "node:path";
import type { SqliteEventStoreDiagnostics } from "@chili/store";

export function formatStoreDoctorText(report: SqliteEventStoreDiagnostics): string {
  return [
    `Store doctor: ${report.path}`,
    `files database=${formatBytes(report.files.database.bytes)} wal=${formatBytes(report.files.wal.bytes)} shm=${formatBytes(report.files.shm.bytes)}`,
    `tool_results files=${report.toolResultFiles.files} total=${formatBytes(report.toolResultFiles.totalBytes)} path=${report.toolResultFiles.path}`,
    ...tableLines("largest tool result files", ["file", "size"], report.toolResultFiles.largestFiles.map((row) => [
      basename(row.path),
      formatBytes(row.bytes),
    ])),
    `sqlite journal=${report.pragmas.journalMode} page_size=${report.pragmas.pageSize} page_count=${report.pragmas.pageCount} freelist=${report.pragmas.freelistCount}`,
    `configured_wal autocheckpoint_pages=${report.configuredWal.autoCheckpointPages} journal_size_limit=${formatBytes(report.configuredWal.journalSizeLimitBytes)}`,
    `events rows=${report.events.rows} payload=${formatBytes(report.events.totalPayloadBytes)}`,
    ...tableLines("events by type", ["type", "rows", "payload"], report.events.byType.map((row) => [
      row.type,
      String(row.rows),
      formatBytes(row.payloadBytes),
    ])),
    ...tableLines("events by session", ["session", "rows", "payload"], report.events.bySession.map((row) => [
      row.sessionId ?? "<none>",
      String(row.rows),
      formatBytes(row.payloadBytes),
    ])),
    ...tableLines("largest event payloads", ["event", "type", "session", "payload"], report.events.largestPayloads.map((row) => [
      row.id,
      row.type,
      row.sessionId ?? "<none>",
      formatBytes(row.payloadBytes),
    ])),
    `message_parts rows=${report.messageParts.rows} data=${formatBytes(report.messageParts.totalDataBytes)}`,
    ...tableLines("message_parts by type", ["type", "rows", "data"], report.messageParts.byType.map((row) => [
      row.type,
      String(row.rows),
      formatBytes(row.dataBytes),
    ])),
    ...tableLines("tool_results by tool", ["tool", "rows", "output"], report.messageParts.toolResultsByTool.map((row) => [
      row.toolName,
      String(row.rows),
      formatBytes(row.outputBytes),
    ])),
    ...tableLines("largest message_parts", ["part", "type", "session", "data"], report.messageParts.largestParts.map((row) => [
      row.id,
      row.type,
      row.sessionId,
      formatBytes(row.dataBytes),
    ])),
    `tool_calls rows=${report.toolCalls.rows} output=${formatBytes(report.toolCalls.totalOutputBytes)}`,
    ...tableLines("tool_calls by tool", ["tool", "rows", "output"], report.toolCalls.byTool.map((row) => [
      row.toolName,
      String(row.rows),
      formatBytes(row.outputBytes),
    ])),
    ...tableLines("largest tool outputs", ["tool_call", "tool", "status", "output"], report.toolCalls.largestOutputs.map((row) => [
      row.id,
      row.toolName,
      row.status,
      formatBytes(row.outputBytes),
    ])),
  ].join("\n");
}

function tableLines(title: string, header: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [`${title}: none`];
  return [
    `${title}:`,
    header.join("\t"),
    ...rows.map((row) => row.join("\t")),
  ];
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}
