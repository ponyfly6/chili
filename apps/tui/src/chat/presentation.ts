import type {
  ChatApprovalRow,
  ChatMessagePart,
  ChatMessageRow,
  ChatToolCallRow,
  ChatToolDisplayStatus,
  ChatToolInputSummary,
  ChatTranscriptItem,
} from "@chili/sdk";

export type ChatDisplayItem =
  | { kind: "user_text"; id: string; text: string }
  | { kind: "assistant_text"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string; collapsed: true }
  | { kind: "tool_activity"; id: string; activity: ToolActivityDisplay }
  | { kind: "tool_group"; id: string; label: string; tone: ToolActivityTone; activities: ToolActivityDisplay[] }
  | { kind: "approval"; id: string; approval: ChatApprovalRow }
  | { kind: "summary"; id: string; text: string };

export type ToolActivityTone = "muted" | "pending" | "error";

export interface ToolActivityDetail {
  label: string;
  lines: string[];
  tone: "muted" | "error";
  truncated: boolean;
}

export interface ToolActivityDisplay {
  id: string;
  callId: string;
  toolName: string;
  status: string;
  displayStatus: ChatToolDisplayStatus;
  label: string;
  tone: ToolActivityTone;
  source: "row" | "fallback";
  details: ToolActivityDetail[];
  inputSummary?: ChatToolInputSummary;
  input?: unknown;
  output?: string;
  error?: string;
  outputHint?: string;
  compactErrorLines?: string[];
}

interface BuildOptions {
  showToolDetails?: boolean;
}

interface ToolCallPartInfo {
  toolName: string;
  input?: unknown;
}

export function buildChatDisplayItems(items: readonly ChatTranscriptItem[], options: BuildOptions = {}): ChatDisplayItem[] {
  const showToolDetails = options.showToolDetails === true;
  const toolRowsById = new Set<string>();
  const toolCallParts = new Map<string, ToolCallPartInfo>();

  for (const item of items) {
    if (item.kind === "tool") {
      toolRowsById.add(item.id);
      continue;
    }
    if (item.kind !== "message") continue;
    for (const part of item.parts) {
      if (part.type !== "tool_call" || toolCallParts.has(part.callId)) continue;
      toolCallParts.set(part.callId, {
        toolName: part.toolName,
        ...(part.input === undefined ? {} : { input: part.input }),
      });
    }
  }

  const output: ChatDisplayItem[] = [];
  for (const item of items) {
    if (item.kind === "message") {
      output.push(...messageDisplayItems(item, toolRowsById, toolCallParts, showToolDetails));
      continue;
    }
    if (item.kind === "tool") {
      output.push({
        kind: "tool_activity",
        id: `tool:${item.id}`,
        activity: toolActivityFromRow(item, showToolDetails),
      });
      continue;
    }
    output.push({ kind: "approval", id: `approval:${item.id}`, approval: item });
  }

  return groupExplorationTools(output);
}

function messageDisplayItems(
  message: ChatMessageRow,
  toolRowsById: ReadonlySet<string>,
  toolCallParts: ReadonlyMap<string, ToolCallPartInfo>,
  showToolDetails: boolean,
): ChatDisplayItem[] {
  const output: ChatDisplayItem[] = [];
  for (const [index, part] of message.parts.entries()) {
    const id = `${message.id}:${part.id}:${index}`;
    if (part.type === "text") {
      if (message.role === "user") output.push({ kind: "user_text", id, text: part.text });
      else if (message.role === "assistant") output.push({ kind: "assistant_text", id, text: part.text });
      else output.push({ kind: "summary", id, text: `${message.role}: ${part.text}` });
      continue;
    }
    if (part.type === "reasoning") {
      output.push({ kind: "reasoning", id, text: part.text, collapsed: true });
      continue;
    }
    if (part.type === "summary") {
      output.push({ kind: "summary", id, text: part.text });
      continue;
    }
    if (part.type === "tool_result") {
      if (!toolRowsById.has(part.callId)) {
        output.push({
          kind: "tool_activity",
          id: `tool-result:${id}`,
          activity: fallbackToolResultActivity(part, toolCallParts.get(part.callId), showToolDetails),
        });
      }
      continue;
    }
    // Tool calls are represented by ChatToolCallRow when available. Keeping
    // them out of the normal transcript preserves the assistant reply as the
    // main reading surface.
  }
  return output;
}

function toolActivityFromRow(row: ChatToolCallRow, showToolDetails: boolean): ToolActivityDisplay {
  return toolActivity({
    id: row.id,
    callId: row.id,
    toolName: row.toolName,
    status: row.status,
    displayStatus: row.displayStatus,
    source: "row",
    inputSummary: row.inputSummary,
    showToolDetails,
    ...(row.input === undefined ? {} : { input: row.input }),
    ...(row.output === undefined ? {} : { output: row.output }),
    ...(row.error === undefined ? {} : { error: row.error }),
  });
}

function fallbackToolResultActivity(
  part: Extract<ChatMessagePart, { type: "tool_result" }>,
  call: ToolCallPartInfo | undefined,
  showToolDetails: boolean,
): ToolActivityDisplay {
  const toolName = call?.toolName ?? "tool";
  return toolActivity({
    id: part.callId,
    callId: part.callId,
    toolName,
    status: part.error ? "failed" : "completed",
    displayStatus: part.error ? "failed" : "succeeded",
    source: "fallback",
    inputSummary: inputSummaryFromUnknown(toolName, call?.input),
    output: part.output,
    showToolDetails,
    ...(call?.input === undefined ? {} : { input: call.input }),
    ...(part.error === undefined ? {} : { error: part.error }),
  });
}

function toolActivity(input: {
  id: string;
  callId: string;
  toolName: string;
  status: string;
  displayStatus: ChatToolDisplayStatus;
  source: "row" | "fallback";
  showToolDetails: boolean;
  inputSummary?: ChatToolInputSummary;
  input?: unknown;
  output?: string;
  error?: string;
}): ToolActivityDisplay {
  const summary = input.inputSummary ?? inputSummaryFromUnknown(input.toolName, input.input);
  const error = input.error;
  const output = input.output;
  const details = input.showToolDetails ? toolDetails(input.toolName, input.input, output, error) : [];
  const compactErrorLines = details.length === 0 && error
    ? previewTextLines(error, { maxLines: 4, maxLineLength: 180 }).lines
    : details.length === 0 && input.displayStatus === "failed" && output
      ? previewTextLines(output, { maxLines: 4, maxLineLength: 180 }).lines
      : undefined;
  const outputHint = details.length === 0 && !error && output && isLargeOutput(output)
    ? hiddenOutputHint(output)
    : undefined;

  return {
    id: input.id,
    callId: input.callId,
    toolName: input.toolName,
    status: input.status,
    displayStatus: input.displayStatus,
    label: toolActivityLabel(input.toolName, input.displayStatus, summary),
    tone: toolTone(input.displayStatus),
    source: input.source,
    details,
    ...(summary ? { inputSummary: summary } : {}),
    ...(input.input === undefined ? {} : { input: input.input }),
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
    ...(outputHint === undefined ? {} : { outputHint }),
    ...(compactErrorLines === undefined ? {} : { compactErrorLines }),
  };
}

function groupExplorationTools(items: readonly ChatDisplayItem[]): ChatDisplayItem[] {
  const output: ChatDisplayItem[] = [];
  let pending: Extract<ChatDisplayItem, { kind: "tool_activity" }>[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    if (pending.length === 1) {
      const [single] = pending;
      if (single) output.push(single);
      pending = [];
      return;
    }
    const activities = pending.map((item) => item.activity);
    const first = activities[0];
    const last = activities[activities.length - 1];
    output.push({
      kind: "tool_group",
      id: `tool-group:${first?.id ?? "start"}:${last?.id ?? "end"}`,
      label: explorationGroupLabel(activities),
      tone: groupTone(activities),
      activities,
    });
    pending = [];
  };

  for (const item of items) {
    if (item.kind === "tool_activity" && isExplorationTool(item.activity.toolName)) {
      pending.push(item);
      continue;
    }
    flush();
    output.push(item);
  }
  flush();
  return output;
}

function explorationGroupLabel(activities: readonly ToolActivityDisplay[]): string {
  const reads = activities.filter((activity) => isReadTool(activity.toolName)).length;
  const searches = activities.filter((activity) => isSearchTool(activity.toolName)).length;
  const lists = activities.filter((activity) => isListTool(activity.toolName)).length;
  const parts: string[] = [];
  if (reads > 0) parts.push(`${reads} ${plural(reads, "file", "files")}`);
  if (searches > 0) parts.push(`searched ${searches} ${plural(searches, "pattern", "patterns")}`);
  if (lists > 0) parts.push(`listed ${lists} ${plural(lists, "path", "paths")}`);
  return parts.length > 0 ? `Explored ${parts.join(", ")}` : `Explored ${activities.length} tools`;
}

function groupTone(activities: readonly ToolActivityDisplay[]): ToolActivityTone {
  if (activities.some((activity) => activity.tone === "error")) return "error";
  if (activities.some((activity) => activity.tone === "pending")) return "pending";
  return "muted";
}

function toolActivityLabel(toolName: string, status: ChatToolDisplayStatus, summary: ChatToolInputSummary): string {
  const normalized = normalizeToolName(toolName || summary.title);
  if (normalized === "bash" || normalized === "run_shell_command") {
    return labelWithTarget(statusVerb(status, "Ran", "Running"), summary.command ?? summary.detail ?? summary.title);
  }
  if (isReadTool(normalized)) {
    return labelWithTarget(statusVerb(status, "Read", "Reading"), displayPath(summary.path ?? summary.detail ?? summary.scope ?? "file"));
  }
  if (isSearchTool(normalized)) {
    const target = summary.pattern
      ? `${summary.pattern}${summary.scope ? ` in ${summary.scope}` : ""}`
      : summary.detail ?? summary.scope ?? "pattern";
    return labelWithTarget(statusVerb(status, "Searched", "Searching"), target);
  }
  if (isListTool(normalized)) {
    const target = summary.pattern
      ? `${summary.pattern}${summary.path ? ` under ${summary.path}` : ""}`
      : summary.path ?? summary.detail ?? summary.scope ?? "paths";
    return labelWithTarget(statusVerb(status, "Listed", "Listing"), target);
  }
  if (normalized === "edit" || normalized === "replace") {
    return labelWithTarget(statusVerb(status, "Edited", "Editing"), displayPath(summary.path ?? summary.detail ?? "file"));
  }
  if (normalized === "write" || normalized === "write_file") {
    return labelWithTarget(statusVerb(status, "Wrote", "Writing"), displayPath(summary.path ?? summary.detail ?? "file"));
  }
  if (normalized === "apply_patch") {
    return labelWithTarget(statusVerb(status, "Patched", "Patching"), displayPath(summary.path ?? summary.detail ?? "files"));
  }
  const detail = summary.command ?? summary.detail ?? summary.path ?? summary.pattern ?? summary.scope;
  return labelWithTarget(statusVerb(status, `Ran ${summary.title}`, `Running ${summary.title}`), detail);
}

function statusVerb(status: ChatToolDisplayStatus, succeeded: string, active: string): string {
  if (status === "succeeded") return succeeded;
  if (status === "running") return active;
  if (status === "queued") return "Queued";
  if (status === "checking") return "Checking";
  if (status === "waiting_permission") return "Waiting approval for";
  if (status === "failed") return "Failed";
  if (status === "rejected") return "Rejected";
  return "Cancelled";
}

function labelWithTarget(verb: string, target: string | undefined): string {
  const trimmed = target?.replace(/\s+/g, " ").trim();
  return trimmed ? `${verb} ${trimmed}` : verb;
}

function toolTone(status: ChatToolDisplayStatus): ToolActivityTone {
  if (status === "failed" || status === "rejected" || status === "cancelled") return "error";
  if (status === "queued" || status === "checking" || status === "running" || status === "waiting_permission") return "pending";
  return "muted";
}

function toolDetails(toolName: string, input: unknown, output: string | undefined, error: string | undefined): ToolActivityDetail[] {
  const details: ToolActivityDetail[] = [];
  if (input !== undefined) {
    const preview = previewTextLines(formatInput(input), { maxLines: 8, maxLineLength: 180 });
    details.push({ label: "input", tone: "muted", lines: preview.lines, truncated: preview.truncated });
  }
  if (error) {
    const preview = previewTextLines(error, { maxLines: 5, maxLineLength: 180 });
    details.push({ label: "error", tone: "error", lines: preview.lines, truncated: preview.truncated });
  }
  if (output) {
    const preview = previewTextLines(output, {
      maxLines: normalizeToolName(toolName) === "bash" ? 5 : 8,
      maxLineLength: 180,
    });
    details.push({ label: "output", tone: "muted", lines: preview.lines, truncated: preview.truncated });
  }
  return details;
}

function previewTextLines(value: string, options: { maxLines: number; maxLineLength: number }): { lines: string[]; truncated: boolean } {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  const sourceLines = normalized.length > 0 ? normalized.split("\n") : [""];
  const lines = sourceLines.slice(0, options.maxLines).map((line) => shortenLine(line, options.maxLineLength));
  const truncated = sourceLines.length > options.maxLines || lines.some((line, index) => line !== sourceLines[index]);
  return { lines, truncated };
}

function hiddenOutputHint(value: string): string {
  const lines = Math.max(1, value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length);
  return `output hidden (${lines} ${plural(lines, "line", "lines")}, details available)`;
}

function isLargeOutput(value: string): boolean {
  return value.length > 180 || value.includes("\n") || /^diff --git/m.test(value);
}

function inputSummaryFromUnknown(toolName: string, input: unknown): ChatToolInputSummary {
  const title = toolName || "tool";
  const record = recordValue(input);
  const path = record ? firstString(record, ["filePath", "file_path", "path"]) : undefined;
  const pattern = record ? firstString(record, ["pattern", "query"]) : undefined;
  const command = record ? firstString(record, ["command", "cmd"]) : undefined;
  const detail = command ?? (pattern && path ? `${pattern} in ${path}` : undefined) ?? path ?? previewUnknown(input, 120);
  return {
    title,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(path ? { path, scope: path } : {}),
    ...(pattern ? { pattern } : {}),
  };
}

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function previewUnknown(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return shortenLine(formatInput(value).replace(/\s+/g, " ").trim(), maxLength);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function shortenLine(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}~`;
}

function displayPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function normalizeToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/^tool\./, "");
}

function isExplorationTool(toolName: string): boolean {
  return isReadTool(toolName) || isSearchTool(toolName) || isListTool(toolName);
}

function isReadTool(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return normalized === "read" || normalized === "read_file";
}

function isSearchTool(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return normalized === "grep" || normalized === "search" || normalized === "rg";
}

function isListTool(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return normalized === "glob" || normalized === "list" || normalized === "list_files" || normalized === "ls";
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}
