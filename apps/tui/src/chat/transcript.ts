import type { ChatMessagePart, ChatToolInputSummary, ChatTranscriptItem } from "@chili/sdk";

export type TranscriptLineTone = "heading" | "text" | "muted" | "error";

export interface TranscriptSourceLine {
  key: string;
  text: string;
  tone: TranscriptLineTone;
}

export function buildTranscriptLines(items: readonly ChatTranscriptItem[]): TranscriptSourceLine[] {
  if (items.length === 0) return [];
  return items.flatMap((item, index) => {
    const isLast = index === items.length - 1;
    if (item.kind === "message") return messageLines(item, isLast);
    if (item.kind === "tool") return toolLines(item, isLast);
    return approvalLines(item, isLast);
  });
}

export function buildTranscriptText(items: readonly ChatTranscriptItem[]): string {
  return buildTranscriptLines(items).map((line) => line.text).join("\n");
}

function messageLines(item: Extract<ChatTranscriptItem, { kind: "message" }>, isLast: boolean): TranscriptSourceLine[] {
  const lines: TranscriptSourceLine[] = [
    sourceLine(`message:${item.id}:header`, `message ${item.role} ${item.id}`, "heading"),
  ];
  appendOptionalField(lines, `message:${item.id}`, "threadId", item.threadId);
  appendOptionalField(lines, `message:${item.id}`, "createdAt", String(item.createdAt));
  appendOptionalField(lines, `message:${item.id}`, "completedAt", item.completedAt === undefined ? undefined : String(item.completedAt));

  for (const [partIndex, part] of item.parts.entries()) {
    lines.push(...messagePartLines(item.id, part, partIndex));
  }
  if (!isLast) lines.push(sourceLine(`message:${item.id}:spacer`, "", "muted"));
  return lines;
}

function messagePartLines(messageId: string, part: ChatMessagePart, index: number): TranscriptSourceLine[] {
  const key = `message:${messageId}:part:${part.id}:${index}`;
  if (part.type === "text") {
    return blockLines({
      key,
      label: `  part text ${part.id}`,
      value: part.text,
      tone: "text",
      valueTone: "text",
    });
  }
  if (part.type === "reasoning") {
    return blockLines({
      key,
      label: `  part reasoning ${part.id}${part.redacted ? " redacted" : ""}`,
      value: part.text,
      tone: "muted",
      valueTone: "muted",
    });
  }
  if (part.type === "summary") {
    return blockLines({
      key,
      label: `  part summary ${part.id}`,
      value: part.text,
      tone: "muted",
      valueTone: "muted",
    });
  }
  if (part.type === "tool_call") {
    const lines = [
      sourceLine(
        `${key}:header`,
        `  part tool_call ${part.id} callId=${part.callId} tool=${part.toolName} status=${part.status}${part.displayStatus ? ` displayStatus=${part.displayStatus}` : ""}`,
        "heading",
      ),
    ];
    lines.push(...blockLines({ key: `${key}:input`, label: "    input", value: part.input, tone: "muted", valueTone: "text", emptyText: "(none)" }));
    return lines;
  }

  const lines = [
    sourceLine(`${key}:header`, `  part tool_result ${part.id} callId=${part.callId}${part.synthetic ? " synthetic" : ""}`, "heading"),
  ];
  lines.push(...blockLines({ key: `${key}:output`, label: "    output", value: part.output, tone: "muted", valueTone: "text" }));
  if (part.error !== undefined) {
    lines.push(...blockLines({ key: `${key}:error`, label: "    error", value: part.error, tone: "error", valueTone: "error" }));
  }
  return lines;
}

function toolLines(item: Extract<ChatTranscriptItem, { kind: "tool" }>, isLast: boolean): TranscriptSourceLine[] {
  const lines: TranscriptSourceLine[] = [
    sourceLine(`tool:${item.id}:header`, `tool ${item.toolName} ${item.displayStatus} ${item.id}`, item.displayStatus === "failed" ? "error" : "heading"),
    sourceLine(`tool:${item.id}:status`, `  status: ${item.status}`, "muted"),
    sourceLine(`tool:${item.id}:display-status`, `  displayStatus: ${item.displayStatus}`, item.displayStatus === "failed" ? "error" : "muted"),
    sourceLine(`tool:${item.id}:waiting`, `  waitingForApproval: ${item.waitingForApproval ? "true" : "false"}`, "muted"),
  ];
  appendOptionalField(lines, `tool:${item.id}`, "sessionId", item.sessionId);
  appendOptionalField(lines, `tool:${item.id}`, "threadId", item.threadId);
  appendOptionalField(lines, `tool:${item.id}`, "approvalId", item.approvalId);
  appendOptionalField(lines, `tool:${item.id}`, "approvalStatus", item.approvalStatus);
  appendOptionalField(lines, `tool:${item.id}`, "approvalDecision", item.approvalDecision);
  lines.push(...summaryBlockLines(`tool:${item.id}:summary`, item.inputSummary));
  lines.push(...blockLines({ key: `tool:${item.id}:input`, label: "  input", value: item.input, tone: "muted", valueTone: "text", emptyText: "(none)" }));
  if (item.output !== undefined) {
    lines.push(...blockLines({ key: `tool:${item.id}:output`, label: "  output", value: item.output, tone: "muted", valueTone: "text" }));
  }
  if (item.error !== undefined) {
    lines.push(...blockLines({ key: `tool:${item.id}:error`, label: "  error", value: item.error, tone: "error", valueTone: "error" }));
  }
  if (!isLast) lines.push(sourceLine(`tool:${item.id}:spacer`, "", "muted"));
  return lines;
}

function approvalLines(item: Extract<ChatTranscriptItem, { kind: "approval" }>, isLast: boolean): TranscriptSourceLine[] {
  const lines: TranscriptSourceLine[] = [
    sourceLine(`approval:${item.id}:header`, `approval ${item.id} ${item.status}`, item.decision === "deny" ? "error" : "heading"),
    sourceLine(`approval:${item.id}:permission`, `  permission: ${item.permission}`, "muted"),
  ];
  appendOptionalField(lines, `approval:${item.id}`, "toolName", item.toolName);
  appendOptionalField(lines, `approval:${item.id}`, "callId", item.callId);
  appendOptionalField(lines, `approval:${item.id}`, "toolStatus", item.toolStatus);
  appendOptionalField(lines, `approval:${item.id}`, "toolDisplayStatus", item.toolDisplayStatus);
  appendOptionalField(lines, `approval:${item.id}`, "decision", item.decision);
  appendOptionalField(lines, `approval:${item.id}`, "feedback", item.feedback);
  appendOptionalField(lines, `approval:${item.id}`, "sessionId", item.sessionId);
  appendOptionalField(lines, `approval:${item.id}`, "threadId", item.threadId);
  lines.push(...listBlockLines(`approval:${item.id}:patterns`, "  patterns", item.patterns));
  lines.push(...summaryBlockLines(`approval:${item.id}:summary`, item.inputSummary));
  if (item.toolInput !== undefined) {
    lines.push(...blockLines({ key: `approval:${item.id}:tool-input`, label: "  toolInput", value: item.toolInput, tone: "muted", valueTone: "text" }));
  }
  if (!isLast) lines.push(sourceLine(`approval:${item.id}:spacer`, "", "muted"));
  return lines;
}

function summaryBlockLines(key: string, summary: ChatToolInputSummary): TranscriptSourceLine[] {
  return blockLines({ key, label: "  inputSummary", value: summary, tone: "muted", valueTone: "text" });
}

function listBlockLines(key: string, label: string, values: readonly string[]): TranscriptSourceLine[] {
  const lines = [sourceLine(`${key}:label`, `${label}:`, "muted")];
  if (values.length === 0) {
    lines.push(sourceLine(`${key}:empty`, "    (empty)", "muted"));
    return lines;
  }
  for (const [index, value] of values.entries()) {
    lines.push(sourceLine(`${key}:item:${index}`, `    - ${value}`, "text"));
  }
  return lines;
}

function blockLines(input: {
  key: string;
  label: string;
  value: unknown;
  tone: TranscriptLineTone;
  valueTone: TranscriptLineTone;
  emptyText?: string;
}): TranscriptSourceLine[] {
  const lines = [sourceLine(`${input.key}:label`, `${input.label}:`, input.tone)];
  const prefix = `${leadingWhitespace(input.label)}  `;
  for (const [index, line] of valueLines(input.value, input.emptyText).entries()) {
    lines.push(sourceLine(`${input.key}:line:${index}`, `${prefix}${line}`, input.valueTone));
  }
  return lines;
}

function valueLines(value: unknown, emptyText = "(empty)"): string[] {
  if (value === undefined) return [emptyText];
  if (typeof value === "string") return stringLines(value, emptyText);
  return stringLines(formatJson(value), emptyText);
}

function stringLines(value: string, emptyText: string): string[] {
  if (value.length === 0) return [emptyText];
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function appendOptionalField(lines: TranscriptSourceLine[], key: string, label: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  lines.push(sourceLine(`${key}:${label}`, `  ${label}: ${value}`, "muted"));
}

function leadingWhitespace(value: string): string {
  return value.match(/^\s*/)?.[0] ?? "";
}

function sourceLine(key: string, text: string, tone: TranscriptLineTone): TranscriptSourceLine {
  return { key, text, tone };
}
