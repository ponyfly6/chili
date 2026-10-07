import { isTransientEvent, type ChiliEvent } from "@chili/protocol";

export interface RuntimeEventWindowLimits {
  maxEvents: number;
  /** Exact UTF-8 bytes of JSON.stringify(events), including brackets and commas. */
  maxBytes: number;
  /** Binds per-source ordering cursors retained by the incremental accumulator. */
  maxSources?: number;
  /** Live UI windows may retain previews; durable history excludes them by default. */
  preserveTransientEvents?: boolean;
}

export interface RuntimeEventWindowInput extends RuntimeEventWindowLimits {
  /** Lifecycle roots that must win over ordinary tail events while they fit. */
  pinnedEventIds?: Iterable<string>;
}

export interface RuntimeEventWindowResult {
  events: ChiliEvent[];
  /** Exact UTF-8 bytes of JSON.stringify(events). */
  bytes: number;
  truncated: boolean;
  /** Pins that remain represented by the returned replayable window. */
  pinnedEventIds: string[];
  /** Dependency keys that could not be resolved from the supplied events. */
  missingDependencies: string[];
  /** At least one prior add dropped a group because its anchor was unavailable. */
  dependencyTruncated: boolean;
}

export interface RuntimeEventSourceInput {
  sourceOrder: number;
  /** Pins supplied by an authoritative source snapshot. */
  pinnedEventIds?: Iterable<string>;
}

export interface RuntimeEventDependencyReference {
  kind: RuntimeEventDependencyKind;
  key: string;
}

export type RuntimeEventDependencyKind =
  | "session"
  | "turn"
  | "message"
  | "part"
  | "tool"
  | "approval"
  | "user_input"
  | "snapshot";

interface OrderedRuntimeEvent {
  event: ChiliEvent;
  sourceOrder: number;
  durableOrdinal: number;
  orderTime: number;
}

interface WindowNode {
  row: OrderedRuntimeEvent;
  bytes: number;
  dependencies: number[];
  missingDependencies: string[];
  chainKey?: string;
}

/**
 * Incrementally combines bounded sources without retaining the full history.
 * Retained state always satisfies maxEvents/maxBytes. Callers should feed one
 * already transport-bounded source response at a time.
 */
export class ReplayableRuntimeEventWindowAccumulator {
  private rows: OrderedRuntimeEvent[] = [];
  private readonly authoritativePins = new Set<string>();
  private retainedPins: string[] = [];
  private truncated = false;
  private dependencyTruncated = false;
  private lastMissingDependencies: string[] = [];
  private readonly sourceCursors = new Map<number, { nextOrdinal: number; orderTime: number }>();

  constructor(private readonly limits: RuntimeEventWindowLimits) {
    requireRuntimeEventWindowLimits(limits);
  }

  addSource(events: Iterable<ChiliEvent>, input: RuntimeEventSourceInput): RuntimeEventWindowResult {
    requireSourceOrder(input.sourceOrder);
    const maxSources = this.limits.maxSources ?? 1_024;
    if (!this.sourceCursors.has(input.sourceOrder) && this.sourceCursors.size >= maxSources) {
      throw new RangeError(`Runtime event source count exceeds the ${maxSources}-source accumulator limit`);
    }
    const cursor = this.sourceCursors.get(input.sourceOrder) ?? {
      nextOrdinal: 0,
      orderTime: Number.NEGATIVE_INFINITY,
    };
    let sourceRows: OrderedRuntimeEvent[] = [];
    let sourceBytes = 2;
    let sourceTruncated = false;
    const sourceMissing = new Set<string>();
    const requestedSourcePins = new Set(input.pinnedEventIds ?? []);
    for (const event of events) {
      // Only explicitly live windows may retain previews or advance their order.
      if (!this.limits.preserveTransientEvents && isTransientEvent(event)) continue;
      cursor.orderTime = Math.max(cursor.orderTime, finiteEventTime(event.time));
      sourceRows.push({
        event,
        sourceOrder: input.sourceOrder,
        durableOrdinal: cursor.nextOrdinal,
        orderTime: cursor.orderTime,
      });
      cursor.nextOrdinal += 1;
      sourceBytes += runtimeEventJsonUtf8Bytes(event) + (sourceRows.length > 1 ? 1 : 0);
      if (sourceRows.length > this.limits.maxEvents * 2 || sourceBytes > this.limits.maxBytes * 2) {
        const compacted = retainOrderedRuntimeEvents(sourceRows, {
          ...this.limits,
          pinnedEventIds: requestedSourcePins,
        });
        sourceRows = compacted.rows;
        sourceBytes = jsonOrderedEventArrayUtf8Bytes(sourceRows);
        sourceTruncated ||= compacted.truncated;
        for (const key of compacted.missingDependencies) sourceMissing.add(key);
      }
    }
    this.sourceCursors.set(input.sourceOrder, cursor);
    for (const eventId of input.pinnedEventIds ?? []) this.authoritativePins.add(eventId);

    const boundedSource = retainOrderedRuntimeEvents(sourceRows, {
      ...this.limits,
      pinnedEventIds: requestedSourcePins,
    });
    sourceRows = boundedSource.rows;
    sourceTruncated ||= boundedSource.truncated;
    for (const key of boundedSource.missingDependencies) sourceMissing.add(key);

    const merged = mergeOrderedRuntimeEvents(this.rows, sourceRows);
    const retained = retainOrderedRuntimeEvents(merged, {
      ...this.limits,
      pinnedEventIds: this.authoritativePins,
    });
    this.rows = retained.rows;
    this.truncated ||= sourceTruncated || retained.truncated;
    this.lastMissingDependencies = [...new Set([
      ...sourceMissing,
      ...retained.missingDependencies,
    ])];
    this.dependencyTruncated ||= this.lastMissingDependencies.length > 0;
    this.retainedPins = retained.pinnedEventIds;
    this.retainRepresentedAuthoritativePins();
    return this.result();
  }

  result(): RuntimeEventWindowResult {
    return {
      events: this.rows.map((row) => row.event),
      bytes: jsonEventArrayUtf8Bytes(this.rows.map((row) => row.event)),
      truncated: this.truncated,
      pinnedEventIds: [...this.retainedPins],
      missingDependencies: [...this.lastMissingDependencies],
      dependencyTruncated: this.dependencyTruncated,
    };
  }

  private retainRepresentedAuthoritativePins(): void {
    const retained = new Set(this.rows.map((row) => row.event.id));
    for (const eventId of this.authoritativePins) {
      if (!retained.has(eventId)) this.authoritativePins.delete(eventId);
    }
  }
}

export function retainReplayableRuntimeEvents(
  events: Iterable<ChiliEvent>,
  input: RuntimeEventWindowInput,
): RuntimeEventWindowResult {
  const accumulator = new ReplayableRuntimeEventWindowAccumulator(input);
  return accumulator.addSource(events, {
    sourceOrder: 0,
    ...(input.pinnedEventIds ? { pinnedEventIds: input.pinnedEventIds } : {}),
  });
}

export function runtimeEventJsonUtf8Bytes(event: ChiliEvent): number {
  return utf8Bytes(JSON.stringify(event));
}

export function jsonEventArrayUtf8Bytes(events: Iterable<ChiliEvent>): number {
  let count = 0;
  let bytes = 2;
  for (const event of events) {
    if (count > 0) bytes += 1;
    bytes += runtimeEventJsonUtf8Bytes(event);
    count += 1;
  }
  return bytes;
}

export function runtimeEventProvides(event: ChiliEvent): RuntimeEventDependencyReference[] {
  switch (event.type) {
    case "session.created":
      return [reference("session", event.payload.sessionId)];
    case "turn.started":
      return [reference("turn", event.payload.turnId)];
    case "message.created":
      return [reference("message", event.payload.messageId)];
    case "message.part_added":
    case "message.part_committed":
    case "message.part_stream_snapshot":
      return [reference("part", event.payload.part.id)];
    case "tool.call_started":
      return [toolReference(event, event.payload.callId)];
    case "tool.call_updated":
      return isToolInputPreview(event) ? [toolReference(event, event.payload.callId)] : [];
    case "approval.requested":
      return [reference("approval", event.payload.approvalId)];
    case "user_input.requested":
      return [reference("user_input", event.payload.inputId)];
    case "snapshot.created":
      return [reference("snapshot", event.payload.snapshotId)];
    default:
      return [];
  }
}

export function runtimeEventRequires(event: ChiliEvent): RuntimeEventDependencyReference[] {
  switch (event.type) {
    case "turn.completed":
    case "turn.model_metadata":
    case "turn.retry_scheduled":
    case "turn.compaction_requested":
    case "turn.compaction_started":
    case "turn.compaction_completed":
    case "turn.compaction_failed":
    case "turn.guard_triggered":
      return [reference("turn", event.payload.turnId)];
    case "message.part_added":
    case "message.part_committed":
    case "message.part_stream_snapshot":
    case "message.part_stream_delta":
      return [reference("message", event.payload.messageId)];
    case "message.part_delta":
      return [
        reference("message", event.payload.messageId),
        reference("part", event.payload.partId),
      ];
    case "tool.call_started":
      return event.payload.parentCallId ? [toolReference(event, event.payload.parentCallId)] : [];
    case "tool.call_updated":
      // Provider input previews precede execution and already contain the
      // information needed to project a tool. Status-only updates do not.
      return isToolInputPreview(event) ? [] : [toolReference(event, event.payload.callId)];
    case "tool.output_delta":
    case "tool.call_finished":
      return [toolReference(event, event.payload.callId)];
    case "approval.requested":
      return event.payload.callId ? [toolReference(event, event.payload.callId)] : [];
    case "approval.resolved":
      return [reference("approval", event.payload.approvalId)];
    case "user_input.requested":
      return [toolReference(event, event.payload.callId)];
    case "user_input.resolved":
    case "user_input.cancelled":
      return [reference("user_input", event.payload.inputId)];
    case "snapshot.reverted":
      return [reference("snapshot", event.payload.snapshotId)];
    default:
      return [];
  }
}

export function runtimeEventDependencyKey(referenceValue: RuntimeEventDependencyReference): string {
  return `${referenceValue.kind}:${referenceValue.key}`;
}

function retainOrderedRuntimeEvents(
  inputRows: readonly OrderedRuntimeEvent[],
  input: RuntimeEventWindowInput,
): {
  rows: OrderedRuntimeEvent[];
  truncated: boolean;
  pinnedEventIds: string[];
  missingDependencies: string[];
} {
  requireRuntimeEventWindowLimits(input);
  const rows = deduplicateOrderedRows(inputRows);
  const providerByKey = new Map<string, number>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    for (const provided of runtimeEventProvides(row.event)) {
      const key = runtimeEventDependencyKey(provided);
      const previous = providerByKey.get(key);
      if (previous === undefined || isToolInputPreview(rows[previous]!.event)) {
        // A real execution start restores turn identity and wins over its
        // previews. Before execution, each complete preview replaces earlier
        // partial inputs, so the newest is enough to anchor cancellation.
        providerByKey.set(key, index);
      }
    }
  }

  const nodes: WindowNode[] = rows.map((row) => {
    const dependencies: number[] = [];
    const missingDependencies: string[] = [];
    for (const required of runtimeEventRequires(row.event)) {
      const key = runtimeEventDependencyKey(required);
      const dependency = providerByKey.get(key);
      if (dependency === undefined) missingDependencies.push(key);
      else if (!dependencies.includes(dependency)) dependencies.push(dependency);
    }
    // Retain a known session's identity with its state, including child Agent
    // metadata. Old partial histories without a creation event remain valid.
    if (row.event.sessionId && row.event.type !== "session.created") {
      const session = providerByKey.get(runtimeEventDependencyKey(reference("session", row.event.sessionId)));
      if (session !== undefined && !dependencies.includes(session)) dependencies.push(session);
    }
    const chainKey = lifecycleChainKey(row.event);
    return {
      row,
      bytes: runtimeEventJsonUtf8Bytes(row.event),
      dependencies,
      missingDependencies,
      ...(chainKey ? { chainKey } : {}),
    };
  });

  const latestByChain = new Map<string, number>();
  for (let index = 0; index < nodes.length; index += 1) {
    const chainKey = nodes[index]?.chainKey;
    if (chainKey) latestByChain.set(chainKey, index);
  }

  // A retained child must not resurrect its completed parent as a running call.
  // Keep the parent's latest state together with the start that anchors the link.
  for (const node of nodes) {
    const event = node.row.event;
    if (event.type !== "tool.call_started" || !event.payload.parentCallId) continue;
    const parentKey = runtimeEventDependencyKey(toolReference(event, event.payload.parentCallId));
    const latestParent = latestByChain.get(parentKey);
    if (latestParent !== undefined && !node.dependencies.includes(latestParent)) node.dependencies.push(latestParent);
  }

  const requestedPins = new Set(input.pinnedEventIds ?? []);
  for (const index of inferredActivePins(nodes, latestByChain)) {
    const eventId = nodes[index]?.row.event.id;
    if (eventId) requestedPins.add(eventId);
  }

  const selected = new Set<number>();
  const enabledChains = new Set<string>();
  const disabledChains = new Set<string>();
  const missingDependencies = new Set<string>();
  let selectedBytes = 2;
  let truncated = false;

  const trySelect = (index: number): "selected" | "missing" | "budget" => {
    const closure = dependencyClosure(nodes, index, selected);
    if (closure.missing.length > 0) {
      for (const key of closure.missing) missingDependencies.add(key);
      return "missing";
    }
    const additions = closure.indices.filter((candidate) => !selected.has(candidate));
    const extraBytes = additions.reduce((total, candidate) => total + (nodes[candidate]?.bytes ?? 0), 0)
      + jsonArrayCommaDelta(selected.size, additions.length);
    if (selected.size + additions.length > input.maxEvents || selectedBytes + extraBytes > input.maxBytes) {
      return "budget";
    }
    for (const candidate of additions) selected.add(candidate);
    selectedBytes += extraBytes;
    return "selected";
  };

  const indexByEventId = new Map(nodes.map((node, index) => [node.row.event.id, index]));
  const pinnedIndices = [...requestedPins]
    .flatMap((eventId) => {
      const index = indexByEventId.get(eventId) ?? -1;
      return index < 0 ? [] : [index];
    })
    .sort((left, right) => right - left);
  for (const index of pinnedIndices) {
    const outcome = trySelect(index);
    const chainKey = nodes[index]?.chainKey;
    if (outcome === "selected") {
      if (chainKey) enabledChains.add(chainKey);
    } else {
      truncated = true;
      if (chainKey) disabledChains.add(chainKey);
    }
  }

  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (selected.has(index)) continue;
    const node = nodes[index];
    if (!node) continue;
    const chainKey = node.chainKey;
    if (chainKey) {
      const latest = latestByChain.get(chainKey);
      if (disabledChains.has(chainKey)) continue;
      if (latest !== index && !enabledChains.has(chainKey)) continue;
    }

    const outcome = trySelect(index);
    if (outcome === "missing") {
      truncated = true;
      if (chainKey) disabledChains.add(chainKey);
      continue;
    }
    if (outcome === "budget") {
      truncated = true;
      break;
    }
    if (chainKey) enabledChains.add(chainKey);
  }

  if (selected.size < nodes.length) truncated = true;
  const retainedRows = [...selected].sort((left, right) => left - right).map((index) => nodes[index]!.row);
  const retainedIds = new Set(retainedRows.map((row) => row.event.id));
  const pinnedEventIds = [...requestedPins].filter((eventId) => retainedIds.has(eventId));
  return {
    rows: retainedRows,
    truncated,
    pinnedEventIds,
    missingDependencies: [...missingDependencies],
  };
}

function dependencyClosure(
  nodes: readonly WindowNode[],
  root: number,
  selected: ReadonlySet<number>,
): { indices: number[]; missing: string[] } {
  const visiting = [root];
  const visited = new Set<number>();
  const missing = new Set<string>();
  while (visiting.length > 0) {
    const index = visiting.pop();
    if (index === undefined || selected.has(index) || visited.has(index)) continue;
    visited.add(index);
    const node = nodes[index];
    if (!node) continue;
    for (const key of node.missingDependencies) missing.add(key);
    for (const dependency of node.dependencies) visiting.push(dependency);
  }
  return { indices: [...visited].sort((left, right) => left - right), missing: [...missing] };
}

function inferredActivePins(nodes: readonly WindowNode[], latestByChain: ReadonlyMap<string, number>): number[] {
  const pins = new Set<number>();
  const activeTurnIds = new Set<string>();
  for (const [chainKey, index] of latestByChain) {
    const event = nodes[index]?.row.event;
    if (!event) continue;
    if (chainKey.startsWith("tool:") && event.type !== "tool.call_finished") pins.add(index);
    if (chainKey.startsWith("approval:") && event.type === "approval.requested") pins.add(index);
    if (chainKey.startsWith("user_input:") && event.type === "user_input.requested") pins.add(index);
    if (chainKey.startsWith("turn:") && event.type !== "turn.completed") {
      activeTurnIds.add(chainKey.slice("turn:".length));
    }
  }

  const messageTurnById = new Map<string, string>();
  const latestMessageEventById = new Map<string, number>();
  for (let index = 0; index < nodes.length; index += 1) {
    const event = nodes[index]?.row.event;
    if (!event) continue;
    if (event.type === "message.created") {
      if (event.payload.turnId) messageTurnById.set(event.payload.messageId, event.payload.turnId);
      latestMessageEventById.set(event.payload.messageId, index);
    } else if (
      event.type === "message.part_added"
      || event.type === "message.part_committed"
      || event.type === "message.part_delta"
      || event.type === "message.part_stream_snapshot"
      || event.type === "message.part_stream_delta"
    ) {
      latestMessageEventById.set(event.payload.messageId, index);
    }
  }
  for (const [messageId, turnId] of messageTurnById) {
    if (!activeTurnIds.has(turnId)) continue;
    const latest = latestMessageEventById.get(messageId);
    if (latest !== undefined) pins.add(latest);
  }
  return [...pins];
}

function lifecycleChainKey(event: ChiliEvent): string | undefined {
  switch (event.type) {
    case "turn.started":
    case "turn.completed":
    case "turn.model_metadata":
    case "turn.retry_scheduled":
    case "turn.compaction_requested":
    case "turn.compaction_started":
    case "turn.compaction_completed":
    case "turn.compaction_failed":
    case "turn.guard_triggered":
      return `turn:${event.payload.turnId}`;
    case "tool.call_started":
    case "tool.call_updated":
    case "tool.output_delta":
    case "tool.call_finished":
      return runtimeEventDependencyKey(toolReference(event, event.payload.callId));
    case "approval.requested":
    case "approval.resolved":
      return `approval:${event.payload.approvalId}`;
    case "user_input.requested":
    case "user_input.resolved":
    case "user_input.cancelled":
      return `user_input:${event.payload.inputId}`;
    case "snapshot.created":
    case "snapshot.reverted":
      return `snapshot:${event.payload.snapshotId}`;
    default:
      return undefined;
  }
}

function mergeOrderedRuntimeEvents(
  left: readonly OrderedRuntimeEvent[],
  right: readonly OrderedRuntimeEvent[],
): OrderedRuntimeEvent[] {
  const merged: OrderedRuntimeEvent[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftRow = left[leftIndex];
    const rightRow = right[rightIndex];
    if (!rightRow || (leftRow && compareOrderedRuntimeEvents(leftRow, rightRow) <= 0)) {
      merged.push(leftRow!);
      leftIndex += 1;
    } else {
      merged.push(rightRow);
      rightIndex += 1;
    }
  }
  return merged;
}

function compareOrderedRuntimeEvents(left: OrderedRuntimeEvent, right: OrderedRuntimeEvent): number {
  return left.orderTime - right.orderTime
    || left.sourceOrder - right.sourceOrder
    || left.durableOrdinal - right.durableOrdinal
    || left.event.id.localeCompare(right.event.id);
}

function deduplicateOrderedRows(rows: readonly OrderedRuntimeEvent[]): OrderedRuntimeEvent[] {
  const lastById = new Map<string, OrderedRuntimeEvent>();
  for (const row of rows) lastById.set(row.event.id, row);
  return rows.filter((row) => lastById.get(row.event.id) === row);
}

function jsonArrayCommaDelta(existingCount: number, addedCount: number): number {
  if (addedCount === 0) return 0;
  return existingCount === 0 ? addedCount - 1 : addedCount;
}

function jsonOrderedEventArrayUtf8Bytes(rows: readonly OrderedRuntimeEvent[]): number {
  let bytes = 2;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    bytes += runtimeEventJsonUtf8Bytes(row.event) + (index > 0 ? 1 : 0);
  }
  return bytes;
}

function reference(kind: RuntimeEventDependencyKind, key: string): RuntimeEventDependencyReference {
  return { kind, key: String(key) };
}

function isToolInputPreview(event: ChiliEvent): boolean {
  return event.type === "tool.call_updated"
    && event.payload.status === "running"
    && typeof event.payload.toolName === "string"
    && event.payload.toolName.trim().length > 0
    && Object.hasOwn(event.payload, "input")
    && event.payload.input !== undefined;
}

function toolReference(event: ChiliEvent, callId: string): RuntimeEventDependencyReference {
  // Provider call IDs can repeat in distinct sessions in a combined snapshot.
  return reference("tool", JSON.stringify([event.sessionId ?? null, String(callId)]));
}

function requireRuntimeEventWindowLimits(limits: RuntimeEventWindowLimits): void {
  if (!Number.isSafeInteger(limits.maxEvents) || limits.maxEvents < 1) {
    throw new RangeError("Runtime event maxEvents must be a positive safe integer");
  }
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 2) {
    throw new RangeError("Runtime event maxBytes must be a safe integer of at least 2 bytes");
  }
  if (
    limits.maxSources !== undefined
    && (!Number.isSafeInteger(limits.maxSources) || limits.maxSources < 1)
  ) {
    throw new RangeError("Runtime event maxSources must be a positive safe integer when provided");
  }
}

function requireSourceOrder(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Runtime event sourceOrder must be a non-negative safe integer");
  }
}

function finiteEventTime(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
