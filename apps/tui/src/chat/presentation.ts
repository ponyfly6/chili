import type {
  ChatApprovalRow,
  ChatMessagePart,
  ChatMessageRow,
  ChatSessionView,
  ChatToolCallRow,
  ChatToolDisplayStatus,
  ChatToolInputSummary,
  ChatTranscriptItem,
  RuntimeToolOutputDelta,
} from "@chili/sdk";
import {
  explorationToolKind,
  inputSummaryFromUnknown,
  isExplorationTool,
  renderToolActivity,
  type ToolActivityDetail,
  type ToolRenderBodyKind,
  type ToolRenderMode,
} from "./tool-renderers.js";

export type ChatDisplayItem =
  | { kind: "user_text"; id: string; text: string; time?: number }
  | { kind: "user_image"; id: string; label: string; time?: number }
  | { kind: "assistant_text"; id: string; text: string; streaming?: boolean; time?: number }
  | { kind: "reasoning"; id: string; text: string; collapsed: true; active?: boolean; time?: number }
  | { kind: "tool_activity"; id: string; activity: ToolActivityDisplay; time?: number }
  | { kind: "tool_group"; id: string; label: string; tone: ToolActivityTone; metadata: ToolGroupMetadata; activities: ToolActivityDisplay[]; time?: number }
  | { kind: "approval"; id: string; approval: ChatApprovalRow; time?: number }
  | { kind: "summary"; id: string; text: string; time?: number };

export type ToolActivityTone = "muted" | "pending" | "error";

export interface ToolActivityDisplay {
  id: string;
  callId: string;
  toolName: string;
  status: string;
  displayStatus: ChatToolDisplayStatus;
  label: string;
  mode: ToolRenderMode;
  title: string;
  tone: ToolActivityTone;
  source: "row" | "fallback";
  details: ToolActivityDetail[];
  summary?: string;
  bodyKind: ToolRenderBodyKind;
  bodyLines: string[];
  bodyTruncated: boolean;
  inputSummary?: ChatToolInputSummary;
  input?: unknown;
  output?: string;
  error?: string;
  liveOutput?: RuntimeToolOutputDelta[];
  outputHint?: string;
  compactErrorLines?: string[];
}

export interface ToolGroupMetadata {
  activeHint?: string;
  hasErrors: boolean;
  collapsedCount: number;
  readCount: number;
  searchCount: number;
  listCount: number;
  activeCount: number;
  errorCount: number;
}

interface BuildOptions {
  showToolDetails?: boolean;
  hideThinking?: boolean;
  sessionStatus?: ChatSessionView["status"];
  activeToolCount?: number;
  groupExplorationTools?: boolean;
}

interface ToolCallPartInfo {
  toolName: string;
  input?: unknown;
}

export function buildChatDisplayItems(items: readonly ChatTranscriptItem[], options: BuildOptions = {}): ChatDisplayItem[] {
  const showToolDetails = options.showToolDetails === true;
  const streamingMessageId = streamingAssistantMessageId(items, options);
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
      output.push(...messageDisplayItems(item, toolRowsById, toolCallParts, showToolDetails, options.hideThinking === true, item.id === streamingMessageId));
      continue;
    }
    if (item.kind === "tool") {
      output.push({
        kind: "tool_activity",
        id: `tool:${item.id}`,
        activity: toolActivityFromRow(item, showToolDetails),
        time: item.updatedAt,
      });
      continue;
    }
    output.push({ kind: "approval", id: `approval:${item.id}`, approval: item, time: item.resolvedAt ?? item.createdAt });
  }

  return options.groupExplorationTools === false ? output : groupExplorationTools(output);
}

function messageDisplayItems(
  message: ChatMessageRow,
  toolRowsById: ReadonlySet<string>,
  toolCallParts: ReadonlyMap<string, ToolCallPartInfo>,
  showToolDetails: boolean,
  hideThinking: boolean,
  streaming: boolean,
): ChatDisplayItem[] {
  const output: ChatDisplayItem[] = [];
  const streamingTextPartIndex = streaming ? lastTextPartIndex(message.parts) : -1;
  const hideStreamingAssistantText = hideThinking && message.role === "assistant" && streaming;
  const hideAssistantTrace = hideThinking && message.role === "assistant" && (hideStreamingAssistantText || message.parts.some((part) => part.type === "tool_call"));
  let hiddenTraceShown = false;
  const showHiddenTrace = (active: boolean) => {
    if (hiddenTraceShown) return;
    output.push({ kind: "reasoning", id: `${message.id}:hidden-thinking`, text: "", collapsed: true, time: message.createdAt, ...(active ? { active } : {}) });
    hiddenTraceShown = true;
  };

  for (const [index, part] of message.parts.entries()) {
    const id = `${message.id}:${part.id}:${index}`;
    if (part.type === "text") {
      if (hideAssistantTrace && part.text.trim()) {
        showHiddenTrace(hideStreamingAssistantText);
        continue;
      }
      if (message.role === "user") output.push({ kind: "user_text", id, text: part.text, time: message.createdAt });
      else if (message.role === "assistant") output.push({ kind: "assistant_text", id, text: part.text, time: message.createdAt, ...(index === streamingTextPartIndex ? { streaming: true } : {}) });
      else output.push({ kind: "summary", id, text: `${message.role}: ${part.text}`, time: message.createdAt });
      continue;
    }
    if (part.type === "image") {
      const label = part.displayText ?? part.sourcePath ?? part.filename ?? part.mimeType;
      if (message.role === "user") output.push({ kind: "user_image", id, label, time: message.createdAt });
      else output.push({ kind: "summary", id, text: `image: ${label}`, time: message.createdAt });
      continue;
    }
    if (part.type === "reasoning") {
      if (hideAssistantTrace) {
        if (part.text.trim()) showHiddenTrace(hideStreamingAssistantText);
        continue;
      }
      output.push({ kind: "reasoning", id, text: part.text, collapsed: true, time: message.createdAt, ...(streaming ? { active: true } : {}) });
      continue;
    }
    if (part.type === "summary") {
      output.push({ kind: "summary", id, text: part.text, time: message.createdAt });
      continue;
    }
    if (part.type === "tool_result") {
      if (!toolRowsById.has(part.callId)) {
        output.push({
          kind: "tool_activity",
          id: `tool-result:${id}`,
          activity: fallbackToolResultActivity(part, toolCallParts.get(part.callId), showToolDetails),
          time: message.createdAt,
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
    ...(row.liveOutput === undefined ? {} : { liveOutput: row.liveOutput }),
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
  liveOutput?: RuntimeToolOutputDelta[];
}): ToolActivityDisplay {
  const summary = input.inputSummary ?? inputSummaryFromUnknown(input.toolName, input.input);
  const rendered = renderToolActivity({
    id: input.id,
    callId: input.callId,
    toolName: input.toolName,
    status: input.status,
    displayStatus: input.displayStatus,
    source: input.source,
    inputSummary: summary,
    showToolDetails: input.showToolDetails,
    ...(input.input === undefined ? {} : { input: input.input }),
    ...(input.output === undefined ? {} : { output: input.output }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.liveOutput === undefined ? {} : { liveOutput: input.liveOutput }),
  });

  return {
    id: input.id,
    callId: input.callId,
    toolName: input.toolName,
    status: input.status,
    displayStatus: input.displayStatus,
    label: rendered.label,
    mode: rendered.mode,
    title: rendered.title,
    tone: toolTone(input.displayStatus),
    source: input.source,
    details: rendered.details,
    ...(rendered.summary === undefined ? {} : { summary: rendered.summary }),
    bodyKind: rendered.bodyKind,
    bodyLines: rendered.bodyLines,
    bodyTruncated: rendered.bodyTruncated,
    ...(summary ? { inputSummary: summary } : {}),
    ...(input.input === undefined ? {} : { input: input.input }),
    ...(input.output === undefined ? {} : { output: input.output }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.liveOutput === undefined ? {} : { liveOutput: input.liveOutput }),
    ...(rendered.outputHint === undefined ? {} : { outputHint: rendered.outputHint }),
    ...(rendered.compactErrorLines === undefined ? {} : { compactErrorLines: rendered.compactErrorLines }),
  };
}

export function groupExplorationTools(items: readonly ChatDisplayItem[]): ChatDisplayItem[] {
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
      metadata: explorationGroupMetadata(activities),
      activities,
      ...(pending[0]?.time === undefined ? {} : { time: pending[0].time }),
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
  const reads = activities.filter((activity) => explorationToolKind(activity.toolName) === "read").length;
  const searches = activities.filter((activity) => explorationToolKind(activity.toolName) === "search").length;
  const lists = activities.filter((activity) => explorationToolKind(activity.toolName) === "list").length;
  const parts: string[] = [];
  if (reads > 0) parts.push(`${reads} ${plural(reads, "file", "files")}`);
  if (searches > 0) parts.push(`searched ${searches} ${plural(searches, "pattern", "patterns")}`);
  if (lists > 0) parts.push(`listed ${lists} ${plural(lists, "path", "paths")}`);
  const verb = activities.some((activity) => activity.tone === "pending") ? "Exploring" : "Explored";
  const suffix = activities.some((activity) => activity.tone === "error") ? " with errors" : "";
  return parts.length > 0 ? `${verb} ${parts.join(", ")}${suffix}` : `${verb} ${activities.length} tools${suffix}`;
}

function explorationGroupMetadata(activities: readonly ToolActivityDisplay[]): ToolGroupMetadata {
  const active = activities.filter((activity) => activity.tone === "pending");
  const errors = activities.filter((activity) => activity.tone === "error");
  const readCount = activities.filter((activity) => explorationToolKind(activity.toolName) === "read").length;
  const searchCount = activities.filter((activity) => explorationToolKind(activity.toolName) === "search").length;
  const listCount = activities.filter((activity) => explorationToolKind(activity.toolName) === "list").length;
  return {
    ...(active.length > 0 ? { activeHint: active.length === 1 ? active[0]?.label ?? "Tool running" : `${active.length} tools running` } : {}),
    hasErrors: errors.length > 0,
    collapsedCount: activities.length,
    readCount,
    searchCount,
    listCount,
    activeCount: active.length,
    errorCount: errors.length,
  };
}

function groupTone(activities: readonly ToolActivityDisplay[]): ToolActivityTone {
  if (activities.some((activity) => activity.tone === "error")) return "error";
  if (activities.some((activity) => activity.tone === "pending")) return "pending";
  return "muted";
}

function toolTone(status: ChatToolDisplayStatus): ToolActivityTone {
  if (status === "failed" || status === "rejected" || status === "cancelled") return "error";
  if (status === "queued" || status === "checking" || status === "running" || status === "waiting_permission") return "pending";
  return "muted";
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}

function streamingAssistantMessageId(items: readonly ChatTranscriptItem[], options: BuildOptions): string | undefined {
  if (options.sessionStatus !== "running") return undefined;
  if ((options.activeToolCount ?? 0) > 0) return undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "message" || item.role !== "assistant" || item.completedAt !== undefined) continue;
    if (lastTextPartIndex(item.parts) >= 0) return item.id;
  }
  return undefined;
}

function lastTextPartIndex(parts: readonly ChatMessagePart[]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === "text") return index;
  }
  return -1;
}
