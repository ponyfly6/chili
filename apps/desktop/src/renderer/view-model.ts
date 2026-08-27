import type { ChiliEvent } from "@chili/protocol";
import {
  applyRuntimeEvent,
  chatSessionView,
  jsonEventArrayUtf8Bytes,
  reduceRuntimeEvents,
  retainReplayableRuntimeEvents,
  runtimeEventDependencyKey,
  runtimeEventJsonUtf8Bytes,
  runtimeEventProvides,
  runtimeEventRequires,
  type ChatSessionView,
  type ChiliRuntimeView,
  type RuntimeApprovalView,
  type RuntimePendingApprovalRequest,
} from "@chili/sdk";
import type {
  RuntimeMessagePartOmission,
  RuntimeSnapshot,
  UserInputRequest,
} from "../shared/contracts.js";
import { serializedJsonUtf8Bytes } from "./json-bytes.js";

export interface RuntimeEventLimits {
  maxEvents: number;
  maxBytes: number;
}

const DEFAULT_RUNTIME_EVENT_LIMITS: RuntimeEventLimits = {
  // Renderer snapshots may arrive with up to 20k events, but retaining that
  // many during a high-frequency live stream would copy/sort a 20k array for
  // every delta. Compact once, then keep the interactive window much smaller.
  maxEvents: 2_000,
  maxBytes: 4_000_000,
};
const LIVE_WINDOW_LOW_WATER_RATIO = 0.75;
const MAX_PENDING_APPROVALS = 2_000;
const MAX_PENDING_APPROVAL_BYTES = 1_000_000;

interface LiveEventWindowState {
  events: ChiliEvent[];
  bytes: number;
  limitsKey: string;
  providers: ReadonlySet<string>;
  runtime: ChiliRuntimeView;
  omittedMessageParts: RuntimeMessagePartOmission[];
  fullRetentionPasses: number;
  fullProjectionReplays: number;
  incrementalProjectionUpdates: number;
  initializationTruncated: boolean;
  initializationDependencyTruncated: boolean;
}

const liveEventWindowCache = new WeakMap<RuntimeSnapshot, LiveEventWindowState>();
const directRuntimeCache = new WeakMap<RuntimeSnapshot, ChiliRuntimeView>();
const MESSAGE_OMISSION_MARKER = "[Earlier message content omitted]\n";
const TOOL_RESULT_OMISSION_MARKER = "[Earlier tool result content omitted]\n";

export interface SessionPresentation {
  runtime: ChiliRuntimeView;
  chat: ChatSessionView;
  pendingApprovals: RuntimeApprovalView[];
  pendingInputs: UserInputRequest[];
  latestTurnId?: string;
}

export function presentSession(snapshot: RuntimeSnapshot): SessionPresentation {
  const runtime = runtimeProjection(snapshot);
  const chat = chatSessionView(runtime, {
    sessionId: snapshot.sessionId as never,
    limit: 5_000,
    requireSession: true,
  });
  const pendingApprovals = snapshot.pendingApprovals
    .map(authoritativeApprovalView)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const terminalInputIds = new Set(snapshot.events.flatMap((event) => {
    if (event.type === "user_input.resolved" || event.type === "user_input.cancelled") {
      return [String(event.payload.inputId)];
    }
    return [];
  }));
  const pendingInputs = snapshot.pendingInputs
    .filter((input) => !terminalInputIds.has(input.id))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const latestTurnId = latestTurn(snapshot.events, snapshot.sessionId);
  return {
    runtime,
    chat,
    pendingApprovals,
    pendingInputs,
    ...(latestTurnId ? { latestTurnId } : {}),
  };
}

export function appendRuntimeEvent(
  snapshot: RuntimeSnapshot,
  event: ChiliEvent,
  limits: RuntimeEventLimits = DEFAULT_RUNTIME_EVENT_LIMITS,
): RuntimeSnapshot {
  requireRuntimeEventLimits(limits);
  const state = liveWindowState(snapshot, limits);
  const existing = state.events.findIndex((candidate) => candidate.id === event.id);
  let events: ChiliEvent[];
  let bytes: number;
  let providers = state.providers;
  let fullRetentionPasses = state.fullRetentionPasses;
  let fullProjectionReplays = state.fullProjectionReplays;
  let incrementalProjectionUpdates = state.incrementalProjectionUpdates;
  let truncated = state.initializationTruncated;
  let dependencyTruncated = state.initializationDependencyTruncated;
  let compactedOrReplaced = false;

  const missing = runtimeEventRequires(event)
    .map(runtimeEventDependencyKey)
    .filter((key) => !state.providers.has(key));
  if (existing < 0 && missing.length > 0) {
    events = state.events;
    bytes = state.bytes;
    dependencyTruncated = true;
    truncated = true;
  } else if (existing >= 0) {
    const replaced = state.events.map((candidate, index) => index === existing ? event : candidate);
    const retained = retainReplayableRuntimeEvents(replaced, limits);
    events = retained.events;
    bytes = retained.bytes;
    providers = providedDependencyKeys(events);
    fullRetentionPasses += 1;
    compactedOrReplaced = true;
    truncated ||= retained.truncated;
    dependencyTruncated ||= retained.dependencyTruncated;
  } else {
    const appendedBytes = state.bytes + runtimeEventJsonUtf8Bytes(event) + (state.events.length > 0 ? 1 : 0);
    if (state.events.length + 1 <= limits.maxEvents && appendedBytes <= limits.maxBytes) {
      events = [...state.events, event];
      bytes = appendedBytes;
      const provided = runtimeEventProvides(event);
      if (provided.length > 0) {
        providers = new Set(state.providers);
        for (const reference of provided) (providers as Set<string>).add(runtimeEventDependencyKey(reference));
      }
    } else {
      const compacted = compactLiveEvents(state.events, event, limits);
      events = compacted.events;
      bytes = compacted.bytes;
      providers = providedDependencyKeys(events);
      fullRetentionPasses += compacted.passes;
      compactedOrReplaced = true;
      truncated = true;
      dependencyTruncated ||= compacted.dependencyTruncated || !events.some((candidate) => candidate.id === event.id);
    }
  }

  const omissionCandidates = existing >= 0
    ? state.events.map((candidate, index) => index === existing ? event : candidate)
    : existing < 0 && missing.length === 0
      ? [...state.events, event]
      : state.events;
  const omittedMessageParts = mergeMessagePartOmissions(
    state.omittedMessageParts,
    omissionCandidates,
    events,
  );

  const projectedApprovals = projectPendingApprovals(snapshot.pendingApprovals, event);
  const next: RuntimeSnapshot = {
    ...snapshot,
    events,
    pendingApprovals: projectedApprovals.approvals,
    pendingInputs: projectPendingInputs(snapshot.pendingInputs, event),
    ...(omittedMessageParts.length > 0 ? { omittedMessageParts } : {}),
  };
  if (truncated || projectedApprovals.truncated) {
    next.truncated = true;
    next.warning = appendWarning(
      snapshot.warning,
      truncated
        ? `Live timeline events exceeded the ${limits.maxEvents}-event or ${limits.maxBytes}-byte renderer budget.`
        : "Live pending approvals exceeded the 2000-row or 1000000-byte renderer budget.",
    );
    if (projectedApprovals.truncated && truncated) {
      next.warning = appendWarning(
        next.warning,
        "Live pending approvals exceeded the 2000-row or 1000000-byte renderer budget.",
      );
    }
  }
  if (dependencyTruncated) {
    next.truncated = true;
    next.warning = appendWarning(
      next.warning,
      `A live event was omitted because its causal anchor was unavailable within the renderer budget${missing.length > 0 ? ` (${missing.join(", ")})` : ""}.`,
    );
  }
  let runtime: ChiliRuntimeView;
  const incrementallyProjected = !compactedOrReplaced
    && existing < 0
    && missing.length === 0
    && events.at(-1)?.id === event.id
    ? applyIncrementalProjection(state.runtime, event)
    : undefined;
  if (incrementallyProjected) {
    runtime = incrementallyProjected;
    incrementalProjectionUpdates += 1;
  } else if (events === state.events && omittedMessagePartsEqual(state.omittedMessageParts, omittedMessageParts)) {
    runtime = state.runtime;
  } else {
    runtime = projectRuntimeEvents(events, omittedMessageParts);
    fullProjectionReplays += 1;
  }
  liveEventWindowCache.set(next, {
    events,
    bytes,
    limitsKey: runtimeEventLimitsKey(limits),
    providers,
    runtime,
    omittedMessageParts,
    fullRetentionPasses,
    fullProjectionReplays,
    incrementalProjectionUpdates,
    initializationTruncated: false,
    initializationDependencyTruncated: false,
  });
  return next;
}

export function runtimeEventSerializedBytes(event: ChiliEvent): number {
  return runtimeEventJsonUtf8Bytes(event);
}

export function runtimeEventRetentionDiagnostics(snapshot: RuntimeSnapshot): {
  retainedEvents: number;
  bytes: number;
  fullRetentionPasses: number;
  fullProjectionReplays: number;
  incrementalProjectionUpdates: number;
} {
  const state = liveEventWindowCache.get(snapshot);
  return {
    retainedEvents: snapshot.events.length,
    bytes: state?.bytes ?? jsonEventArrayUtf8Bytes(snapshot.events),
    fullRetentionPasses: state?.fullRetentionPasses ?? 0,
    fullProjectionReplays: state?.fullProjectionReplays ?? 0,
    incrementalProjectionUpdates: state?.incrementalProjectionUpdates ?? 0,
  };
}

export function boundedToolLiveOutput(
  deltas: readonly { delta: string; stream?: "stdout" | "stderr"; truncated?: boolean }[] | undefined,
  maxBytes = 16_384,
): string | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Tool output byte limit must be a positive safe integer");
  }
  if (!deltas || deltas.length === 0) return undefined;
  let previousStream: "stdout" | "stderr" | undefined;
  let text = "";
  for (const delta of deltas) {
    if (delta.stream && delta.stream !== previousStream) {
      if (text && !text.endsWith("\n")) text += "\n";
      text += `[${delta.stream}]\n`;
      previousStream = delta.stream;
    }
    text += delta.delta;
  }
  if (!text) return undefined;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const encoded = encoder.encode(text);
  const upstreamTruncated = deltas.some((delta) => delta.truncated === true);
  if (encoded.byteLength <= maxBytes && !upstreamTruncated) return text;
  const marker = "[Earlier tool output omitted]\n";
  const markerBytes = encoder.encode(marker);
  if (markerBytes.byteLength >= maxBytes) {
    return decoder.decode(markerBytes.slice(0, maxBytes));
  }
  const tailBytes = maxBytes - markerBytes.byteLength;
  let tailStart = Math.max(0, encoded.byteLength - tailBytes);
  while (tailStart < encoded.byteLength && (encoded[tailStart]! & 0xc0) === 0x80) tailStart += 1;
  return marker + decoder.decode(encoded.slice(tailStart));
}

export function visibleToolLiveOutput(
  finalOutput: string | undefined,
  deltas: readonly { delta: string; stream?: "stdout" | "stderr"; truncated?: boolean }[] | undefined,
  maxBytes = 16_384,
): string | undefined {
  return finalOutput === undefined ? boundedToolLiveOutput(deltas, maxBytes) : undefined;
}

export function runtimeEventRelated(snapshot: RuntimeSnapshot, event: ChiliEvent): boolean {
  if (!event.sessionId) return false;
  if (event.sessionId === snapshot.sessionId) return true;
  for (const agent of snapshot.agentTree.agents) {
    if (agent.sessionId === event.sessionId || agent.childSessionId === event.sessionId) return true;
  }
  for (const task of [...snapshot.agentTree.tasks, ...snapshot.tasks]) {
    if (task.childSessionId === event.sessionId) return true;
  }
  return false;
}

function projectPendingInputs(
  pendingInputs: readonly UserInputRequest[],
  event: ChiliEvent,
): UserInputRequest[] {
  if (event.type === "user_input.resolved" || event.type === "user_input.cancelled") {
    const inputId = String(event.payload.inputId);
    return pendingInputs.filter((input) => input.id !== inputId);
  }
  // DeferredUserInputQueue is the source of truth. A requested event can be
  // replayed after a hard crash even though its in-memory queue no longer
  // exists; App schedules a bounded listUserInputs refresh for live requests.
  return [...pendingInputs];
}

function projectPendingApprovals(
  pendingApprovals: readonly RuntimePendingApprovalRequest[],
  event: ChiliEvent,
): { approvals: RuntimePendingApprovalRequest[]; truncated: boolean } {
  if (event.type === "approval.resolved") {
    const approvalId = String(event.payload.approvalId);
    return {
      approvals: pendingApprovals.filter((approval) => approval.id !== approvalId),
      truncated: false,
    };
  }
  if (event.type !== "approval.requested") {
    return { approvals: [...pendingApprovals], truncated: false };
  }

  const row: RuntimePendingApprovalRequest = {
    id: String(event.payload.approvalId),
    permission: event.payload.permission,
    patterns: [...event.payload.patterns],
    createdAt: event.time,
  };
  if (event.sessionId) row.sessionId = event.sessionId;
  if (event.payload.callId) row.callId = event.payload.callId;
  if (event.payload.maxApprovalScope) row.maxApprovalScope = event.payload.maxApprovalScope;
  if (event.payload.metadata) row.metadata = event.payload.metadata;
  const approvals = [
    ...pendingApprovals.filter((approval) => approval.id !== row.id),
    row,
  ];
  if (
    approvals.length <= MAX_PENDING_APPROVALS
    && serializedJsonUtf8Bytes(approvals) <= MAX_PENDING_APPROVAL_BYTES
  ) {
    return { approvals, truncated: false };
  }
  return { approvals: [...pendingApprovals], truncated: true };
}

function authoritativeApprovalView(approval: RuntimePendingApprovalRequest): RuntimeApprovalView {
  return {
    id: approval.id as never,
    permission: approval.permission,
    patterns: [...approval.patterns],
    status: "pending",
    createdAt: approval.createdAt,
    ...(approval.sessionId ? { sessionId: approval.sessionId } : {}),
    ...(approval.callId ? { callId: approval.callId as never } : {}),
    ...(approval.maxApprovalScope ? { maxApprovalScope: approval.maxApprovalScope } : {}),
    ...(approval.metadata ? { metadata: approval.metadata } : {}),
  };
}

function latestTurn(events: readonly ChiliEvent[], sessionId: string): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.sessionId !== sessionId
      || (event.type !== "turn.started" && event.type !== "turn.completed")) continue;
    return event.payload.turnId;
  }
  return undefined;
}

function runtimeProjection(snapshot: RuntimeSnapshot): ChiliRuntimeView {
  const live = liveEventWindowCache.get(snapshot);
  if (live) return live.runtime;
  const cached = directRuntimeCache.get(snapshot);
  if (cached) return cached;
  const runtime = projectRuntimeEvents(snapshot.events, snapshot.omittedMessageParts ?? []);
  directRuntimeCache.set(snapshot, runtime);
  return runtime;
}

function projectRuntimeEvents(
  events: readonly ChiliEvent[],
  omissions: readonly RuntimeMessagePartOmission[],
): ChiliRuntimeView {
  // The SDK projection intentionally mutates its view. Clone message parts at
  // this boundary so part deltas and tool status updates never mutate the
  // durable event payloads retained by the renderer.
  const runtime = reduceRuntimeEvents(events.map(projectionSafeEvent));
  if (omissions.length === 0) return runtime;
  const anchors = new Map<string, ChiliEvent>();
  for (const event of events) {
    if (event.type !== "message.part_added") continue;
    anchors.set(messagePartKey(String(event.payload.messageId), String(event.payload.part.id)), event);
  }
  for (const omission of omissions) {
    const message = runtime.messages[omission.messageId];
    const part = message?.parts.find((candidate) => String(candidate.id) === omission.partId);
    const anchor = anchors.get(messagePartKey(omission.messageId, omission.partId));
    if (!part || !anchor || anchor.type !== "message.part_added") continue;
    const anchorPart = anchor.payload.part;
    if (omission.field === "text" && (part.type === "text" || part.type === "reasoning")) {
      const seed = anchorPart.type === part.type ? anchorPart.text : "";
      part.text = insertOmissionMarker(part.text, seed, MESSAGE_OMISSION_MARKER);
    } else if (omission.field === "output" && part.type === "tool_result") {
      const seed = anchorPart.type === "tool_result" ? anchorPart.output : "";
      part.output = insertOmissionMarker(part.output, seed, TOOL_RESULT_OMISSION_MARKER);
    }
  }
  return runtime;
}

function projectionSafeEvent(event: ChiliEvent): ChiliEvent {
  if (event.type !== "message.part_added") return event;
  return {
    ...event,
    payload: {
      ...event.payload,
      part: { ...event.payload.part },
    },
  } as ChiliEvent;
}

function insertOmissionMarker(value: string, seed: string, marker: string): string {
  if (value.includes(marker.trimEnd())) return value;
  const separator = seed.length > 0 && !seed.endsWith("\n") ? "\n" : "";
  if (value.startsWith(seed)) return `${seed}${separator}${marker}${value.slice(seed.length)}`;
  return `${marker}${value}`;
}

function applyIncrementalProjection(view: ChiliRuntimeView, event: ChiliEvent): ChiliRuntimeView | undefined {
  if (event.type === "message.part_delta") {
    const entry = view.partIndex[String(event.payload.partId)];
    const message = entry ? view.messages[entry.messageId] : undefined;
    const part = message?.parts[entry?.index ?? -1];
    if (!entry || !message || !part) return undefined;
    const next: ChiliRuntimeView = {
      ...view,
      messages: cloneIndex(view.messages),
      sessions: cloneIndex(view.sessions),
    };
    const parts = [...message.parts];
    parts[entry.index] = { ...part };
    next.messages[message.id] = { ...message, parts };
    cloneProjectionSession(next, view, String(message.sessionId));
    if (event.sessionId) cloneProjectionSession(next, view, String(event.sessionId));
    return applyRuntimeEvent(next, event);
  }
  if (event.type === "tool.output_delta") {
    const toolCall = view.toolCalls[String(event.payload.callId)];
    if (!toolCall) return undefined;
    const next: ChiliRuntimeView = {
      ...view,
      toolCalls: cloneIndex(view.toolCalls),
      sessions: cloneIndex(view.sessions),
    };
    next.toolCalls[toolCall.id] = {
      ...toolCall,
      ...(toolCall.liveOutput ? { liveOutput: [...toolCall.liveOutput] } : {}),
    };
    if (toolCall.sessionId) cloneProjectionSession(next, view, String(toolCall.sessionId));
    if (event.sessionId) cloneProjectionSession(next, view, String(event.sessionId));
    return applyRuntimeEvent(next, event);
  }
  return undefined;
}

function cloneProjectionSession(next: ChiliRuntimeView, source: ChiliRuntimeView, sessionId: string): void {
  const session = source.sessions[sessionId];
  if (!session || next.sessions[sessionId] !== session) return;
  next.sessions[sessionId] = {
    ...session,
    messageIds: [...session.messageIds],
    toolCallIds: [...session.toolCallIds],
    approvalIds: [...session.approvalIds],
    agentRunIds: [...session.agentRunIds],
    taskIds: [...session.taskIds],
  };
}

function cloneIndex<T>(value: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, value);
}

function mergeMessagePartOmissions(
  previous: readonly RuntimeMessagePartOmission[] | undefined,
  candidates: readonly ChiliEvent[],
  retained: readonly ChiliEvent[],
): RuntimeMessagePartOmission[] {
  const retainedIds = new Set(retained.map((event) => event.id));
  const anchoredParts = new Set(retained.flatMap((event) => event.type === "message.part_added"
    ? [messagePartKey(String(event.payload.messageId), String(event.payload.part.id))]
    : []));
  const omissions = new Map<string, RuntimeMessagePartOmission>();
  for (const omission of previous ?? []) {
    const partKey = messagePartKey(omission.messageId, omission.partId);
    if (anchoredParts.has(partKey)) omissions.set(messagePartOmissionKey(omission), omission);
  }
  for (const event of candidates) {
    if (event.type !== "message.part_delta" || retainedIds.has(event.id)) continue;
    if (event.payload.field !== "text" && event.payload.field !== "output") continue;
    const omission: RuntimeMessagePartOmission = {
      messageId: String(event.payload.messageId),
      partId: String(event.payload.partId),
      field: event.payload.field,
    };
    if (anchoredParts.has(messagePartKey(omission.messageId, omission.partId))) {
      omissions.set(messagePartOmissionKey(omission), omission);
    }
  }
  return [...omissions.values()].sort((left, right) => messagePartOmissionKey(left).localeCompare(messagePartOmissionKey(right)));
}

function omittedMessagePartsEqual(
  left: readonly RuntimeMessagePartOmission[] | undefined,
  right: readonly RuntimeMessagePartOmission[],
): boolean {
  const source = left ?? [];
  return source.length === right.length && source.every((omission, index) => {
    const candidate = right[index];
    return candidate?.messageId === omission.messageId
      && candidate.partId === omission.partId
      && candidate.field === omission.field;
  });
}

function messagePartKey(messageId: string, partId: string): string {
  return `${messageId}\u0000${partId}`;
}

function messagePartOmissionKey(omission: RuntimeMessagePartOmission): string {
  return `${messagePartKey(omission.messageId, omission.partId)}\u0000${omission.field}`;
}

function liveWindowState(snapshot: RuntimeSnapshot, limits: RuntimeEventLimits): LiveEventWindowState {
  const key = runtimeEventLimitsKey(limits);
  const cached = liveEventWindowCache.get(snapshot);
  if (cached?.limitsKey === key) return cached;
  const sourceBytes = jsonEventArrayUtf8Bytes(snapshot.events);
  const overBudget = snapshot.events.length > limits.maxEvents || sourceBytes > limits.maxBytes;
  const retained = retainReplayableRuntimeEvents(
    snapshot.events,
    overBudget ? lowWaterRuntimeEventLimits(limits) : limits,
  );
  const omittedMessageParts = mergeMessagePartOmissions(
    snapshot.omittedMessageParts,
    snapshot.events,
    retained.events,
  );
  const state: LiveEventWindowState = {
    events: retained.events,
    bytes: retained.bytes,
    limitsKey: key,
    providers: providedDependencyKeys(retained.events),
    runtime: projectRuntimeEvents(retained.events, omittedMessageParts),
    omittedMessageParts,
    fullRetentionPasses: 1,
    fullProjectionReplays: 1,
    incrementalProjectionUpdates: 0,
    initializationTruncated: retained.truncated,
    initializationDependencyTruncated: retained.dependencyTruncated,
  };
  liveEventWindowCache.set(snapshot, state);
  return state;
}

function compactLiveEvents(
  events: readonly ChiliEvent[],
  appended: ChiliEvent,
  limits: RuntimeEventLimits,
): {
  events: ChiliEvent[];
  bytes: number;
  passes: number;
  dependencyTruncated: boolean;
} {
  function *candidates(): Iterable<ChiliEvent> {
    yield* events;
    yield appended;
  }

  const lowWater = retainReplayableRuntimeEvents(candidates(), lowWaterRuntimeEventLimits(limits));
  if (lowWater.events.some((event) => event.id === appended.id)) {
    return {
      events: lowWater.events,
      bytes: lowWater.bytes,
      passes: 1,
      dependencyTruncated: lowWater.dependencyTruncated,
    };
  }
  const fullBudget = retainReplayableRuntimeEvents(candidates(), limits);
  return {
    events: fullBudget.events,
    bytes: fullBudget.bytes,
    passes: 2,
    dependencyTruncated: fullBudget.dependencyTruncated,
  };
}

function providedDependencyKeys(events: readonly ChiliEvent[]): ReadonlySet<string> {
  const providers = new Set<string>();
  for (const event of events) {
    for (const reference of runtimeEventProvides(event)) {
      providers.add(runtimeEventDependencyKey(reference));
    }
  }
  return providers;
}

function lowWaterRuntimeEventLimits(limits: RuntimeEventLimits): RuntimeEventLimits {
  return {
    maxEvents: Math.max(1, Math.floor(limits.maxEvents * LIVE_WINDOW_LOW_WATER_RATIO)),
    maxBytes: Math.max(2, Math.floor(limits.maxBytes * LIVE_WINDOW_LOW_WATER_RATIO)),
  };
}

function runtimeEventLimitsKey(limits: RuntimeEventLimits): string {
  return `${limits.maxEvents}:${limits.maxBytes}`;
}

function appendWarning(current: string | undefined, warning: string): string {
  if (!current) return warning;
  return current.includes(warning) ? current : `${current}; ${warning}`;
}

function requireRuntimeEventLimits(limits: RuntimeEventLimits): void {
  if (!Number.isSafeInteger(limits.maxEvents) || limits.maxEvents < 1
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 2) {
    throw new RangeError("Runtime event limits require a positive event count and at least two JSON bytes");
  }
}
