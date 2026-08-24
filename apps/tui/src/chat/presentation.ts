import type {
  ChatApprovalRow,
  ChatMessagePart,
  ChatMessageRow,
  ChatSessionView,
  ChatToolCallRow,
  ChatToolDisplayStatus,
  ChatToolExecutionContext,
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
import type { InlineAgentBatchDisplay } from "./AgentBatchCells.js";

export type ChatDisplayItem =
  | { kind: "user_message"; id: string; text: string; imageLabels: string[]; time?: number }
  | {
      kind: "assistant_text";
      id: string;
      text: string;
      phase?: Extract<ChatMessagePart, { type: "text" }>["phase"];
      streaming?: boolean;
      time?: number;
    }
  | { kind: "reasoning"; id: string; text: string; collapsed: true; active?: boolean; time?: number }
  | { kind: "tool_activity"; id: string; activity: ToolActivityDisplay; time?: number }
  | { kind: "tool_group"; id: string; label: string; tone: ToolActivityTone; metadata: ToolGroupMetadata; activities: ToolActivityDisplay[]; time?: number }
  | { kind: "agent_batch"; id: string; batch: InlineAgentBatchDisplay; time?: number }
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
  executionContext?: ChatToolExecutionContext;
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
  failedCount: number;
  compactFailureLines?: string[];
}

interface BuildOptions {
  showToolDetails?: boolean;
  hideThinking?: boolean;
  sessionStatus?: ChatSessionView["status"];
  activeToolCount?: number;
  groupExplorationTools?: boolean;
  cwd?: string;
  agentBatches?: readonly InlineAgentBatchDisplay[];
}

interface ToolCallPartInfo {
  toolName: string;
  input?: unknown;
}

export function buildChatDisplayItems(items: readonly ChatTranscriptItem[], options: BuildOptions = {}): ChatDisplayItem[] {
  const showToolDetails = options.showToolDetails === true;
  const cwd = options.cwd ?? process.cwd();
  const streamingMessageId = streamingAssistantMessageId(items, options);
  const toolRowsById = new Set<string>();
  const toolCallParts = new Map<string, ToolCallPartInfo>();
  const agentBatchesByCallId = new Map((options.agentBatches ?? []).flatMap((batch) => batch.callId ? [[batch.callId, batch] as const] : []));
  const renderedAgentBatchIds = new Set<string>();

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
      output.push(...messageDisplayItems(item, toolRowsById, toolCallParts, showToolDetails, options.hideThinking === true, item.id === streamingMessageId, cwd));
      continue;
    }
    if (item.kind === "tool") {
      const agentBatch = agentBatchesByCallId.get(item.id);
      if (agentBatch && isAgentSpawnToolName(item.toolName)) {
        output.push({ kind: "agent_batch", id: `agent-batch:${agentBatch.id}`, batch: agentBatch, time: agentBatch.createdAt });
        renderedAgentBatchIds.add(agentBatch.id);
        continue;
      }
      output.push({
        kind: "tool_activity",
        id: `tool:${item.id}`,
        activity: toolActivityFromRow(item, showToolDetails, cwd),
        time: item.updatedAt,
      });
      continue;
    }
    output.push({ kind: "approval", id: `approval:${item.id}`, approval: item, time: item.resolvedAt ?? item.createdAt });
  }

  for (const batch of options.agentBatches ?? []) {
    if (renderedAgentBatchIds.has(batch.id)) continue;
    const sourceCallStillVisible = batch.callId ? toolCallParts.has(batch.callId) : false;
    const lifecycleActive = batch.counts.active > 0 || batch.status === "pending" || batch.status === "running";
    if (batch.kind !== "team" && !sourceCallStillVisible && !lifecycleActive) continue;
    output.push({ kind: "agent_batch", id: `agent-batch:${batch.id}`, batch, time: batch.createdAt });
  }

  output.sort((left, right) => displayItemTime(left) - displayItemTime(right));

  return options.groupExplorationTools === false ? output : groupExplorationTools(output);
}

function isAgentSpawnToolName(toolName: string): boolean {
  const name = toolName.toLowerCase().replace(/^tool\./, "");
  return name === "task"
    || name === "agent"
    || name === "task_batch"
    || name === "agent_batch"
    || name === "spawn_tasks"
    || name === "spawn_agents";
}

function displayItemTime(item: ChatDisplayItem): number {
  return typeof item.time === "number" && Number.isFinite(item.time) ? item.time : Number.MAX_SAFE_INTEGER;
}

function messageDisplayItems(
  message: ChatMessageRow,
  toolRowsById: ReadonlySet<string>,
  toolCallParts: ReadonlyMap<string, ToolCallPartInfo>,
  showToolDetails: boolean,
  hideThinking: boolean,
  streaming: boolean,
  cwd: string,
): ChatDisplayItem[] {
  if (message.role === "user") {
    const text = message.parts
      .filter((part): part is Extract<ChatMessagePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trimEnd();
    const imageLabels = message.parts.flatMap((part) => {
      if (part.type !== "image") return [];
      return [part.displayText ?? part.sourcePath ?? part.filename ?? part.mimeType];
    });
    if (!text && imageLabels.length === 0) return [];
    return [{ kind: "user_message", id: message.id, text, imageLabels, time: message.createdAt }];
  }

  const output: ChatDisplayItem[] = [];
  const hideAssistantThinking = hideThinking && message.role === "assistant";
  let hiddenTraceShown = false;
  const showHiddenTrace = (active: boolean) => {
    if (hiddenTraceShown) return;
    output.push({ kind: "reasoning", id: `${message.id}:hidden-thinking`, text: "", collapsed: true, time: message.createdAt, ...(active ? { active } : {}) });
    hiddenTraceShown = true;
  };

  for (const [index, part] of message.parts.entries()) {
    const id = `${message.id}:${part.id}:${index}`;
    if (part.type === "text") {
      if (hideAssistantThinking && part.phase === "commentary") {
        if (part.text.trim()) showHiddenTrace(streaming);
        continue;
      }
      if (message.role === "assistant") {
        output.push({
          kind: "assistant_text",
          id,
          text: part.text,
          time: message.createdAt,
          ...(part.phase === undefined ? {} : { phase: part.phase }),
          ...(streaming ? { streaming: true } : {}),
        });
      }
      else output.push({ kind: "summary", id, text: `${message.role}: ${part.text}`, time: message.createdAt });
      continue;
    }
    if (part.type === "image") {
      const label = part.displayText ?? part.sourcePath ?? part.filename ?? part.mimeType;
      output.push({ kind: "summary", id, text: `image: ${label}`, time: message.createdAt });
      continue;
    }
    if (part.type === "reasoning") {
      if (!part.text.trim()) continue;
      if (hideAssistantThinking) {
        if (part.text.trim()) showHiddenTrace(streaming);
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
          activity: fallbackToolResultActivity(part, toolCallParts.get(part.callId), showToolDetails, cwd),
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

function toolActivityFromRow(row: ChatToolCallRow, showToolDetails: boolean, cwd: string): ToolActivityDisplay {
  return toolActivity({
    id: row.id,
    callId: row.id,
    toolName: row.toolName,
    status: row.status,
    displayStatus: row.displayStatus,
    source: "row",
    inputSummary: row.inputSummary,
    cwd,
    showToolDetails,
    ...(row.input === undefined ? {} : { input: row.input }),
    ...(row.output === undefined ? {} : { output: row.output }),
    ...(row.error === undefined ? {} : { error: row.error }),
    ...(row.executionContext === undefined ? {} : { executionContext: row.executionContext }),
    ...(row.liveOutput === undefined ? {} : { liveOutput: row.liveOutput }),
  });
}

function fallbackToolResultActivity(
  part: Extract<ChatMessagePart, { type: "tool_result" }>,
  call: ToolCallPartInfo | undefined,
  showToolDetails: boolean,
  cwd: string,
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
    cwd,
    output: part.output,
    showToolDetails,
    ...(call?.input === undefined ? {} : { input: call.input }),
    ...(part.error === undefined ? {} : { error: part.error }),
    ...(part.executionContext === undefined ? {} : { executionContext: part.executionContext }),
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
  cwd?: string;
  inputSummary?: ChatToolInputSummary;
  input?: unknown;
  output?: string;
  error?: string;
  executionContext?: ChatToolExecutionContext;
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
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.input === undefined ? {} : { input: input.input }),
    ...(input.output === undefined ? {} : { output: input.output }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
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
    ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
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
  const statusParts = [
    countStatus(activities, "failed", "failed"),
    countStatus(activities, "rejected", "rejected"),
    countStatus(activities, "cancelled", "cancelled"),
  ].filter((part): part is string => part !== undefined);
  const suffix = statusParts.length > 0 ? ` · ${statusParts.join(", ")}` : "";
  return parts.length > 0 ? `${verb} ${parts.join(", ")}${suffix}` : `${verb} ${activities.length} tools${suffix}`;
}

function explorationGroupMetadata(activities: readonly ToolActivityDisplay[]): ToolGroupMetadata {
  const active = activities.filter((activity) => activity.tone === "pending");
  const errors = activities.filter((activity) => activity.tone === "error");
  const failed = activities.filter((activity) => activity.displayStatus === "failed");
  const readCount = activities.filter((activity) => explorationToolKind(activity.toolName) === "read").length;
  const searchCount = activities.filter((activity) => explorationToolKind(activity.toolName) === "search").length;
  const listCount = activities.filter((activity) => explorationToolKind(activity.toolName) === "list").length;
  const compactFailureLines = failed.flatMap((activity) => activity.compactErrorLines ?? []).slice(0, 1);
  if (compactFailureLines[0]) {
    if (failed.length === 1) compactFailureLines[0] = `${compactFailureLines[0]} (Ctrl+O for details)`;
    else compactFailureLines.push(`+${failed.length - 1} more failures (Ctrl+O for details)`);
  }
  return {
    ...(active.length > 0 ? { activeHint: active.length === 1 ? active[0]?.label ?? "Tool running" : `${active.length} tools running` } : {}),
    hasErrors: errors.length > 0,
    collapsedCount: activities.length,
    readCount,
    searchCount,
    listCount,
    activeCount: active.length,
    errorCount: errors.length,
    failedCount: failed.length,
    ...(compactFailureLines.length === 0 ? {} : { compactFailureLines }),
  };
}

function countStatus(activities: readonly ToolActivityDisplay[], status: ChatToolDisplayStatus, label: string): string | undefined {
  const count = activities.filter((activity) => activity.displayStatus === status).length;
  return count > 0 ? `${count} ${label}` : undefined;
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
    if (item.parts.some((part) => part.type === "text")) return item.id;
  }
  return undefined;
}
