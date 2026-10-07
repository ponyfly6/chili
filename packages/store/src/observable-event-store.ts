import {
  RUNTIME_STATE_SNAPSHOT_MAX_BYTES,
  type ChiliEvent, type RuntimeEvent, type EventEnvelope, type Message, type SessionId,
  type MessagePart, type TextPart, type ReasoningPart, type PartId,
} from "@chili/protocol";
import { RuntimeSnapshotLimitError } from "./runtime-snapshot.js";
import type { SessionInputMutation, SessionInputMutationOptions, SessionInputStore } from "./session-inputs.js";
import type {
  ApprovalRow,
  EventQuery,
  EventAppendOptions,
  EventCommitAwareStore,
  EventStore,
  SessionRow,
  AgentSessionStore,
  CreateChildSessionInput,
  CreateChildSessionResult,
  StaleTurnRecoveryInput,
  StaleTurnRecoveryStore,
} from "./types.js";

export interface EventPublisher {
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}

export interface ObservableEventStoreOptions {
  onListenerError?: (error: unknown, event: RuntimeEvent) => void;
}

export class ObservableEventStore
  implements
    EventStore,
    EventCommitAwareStore,
    EventPublisher,
    StaleTurnRecoveryStore
{
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly activeParts = new Map<string, Extract<ChiliEvent, { type: "message.part_stream_snapshot" }>>();
  readonly eventReplayBoundary?: NonNullable<EventStore["eventReplayBoundary"]>;
  readonly runtimeSnapshot?: NonNullable<EventStore["runtimeSnapshot"]>;
  readonly sessionInputForMessage?: NonNullable<EventStore["sessionInputForMessage"]>;

  constructor(
    private readonly inner: EventStore,
    private readonly options: ObservableEventStoreOptions = {},
  ) {
    // Preserve capability absence across wrapper chains so callers can fail
    // explicitly instead of fabricating an incomplete recovery snapshot.
    if (inner.eventReplayBoundary) this.eventReplayBoundary = (query) => inner.eventReplayBoundary!(query);
    if (inner.runtimeSnapshot) this.runtimeSnapshot = async (query) => {
      const maxBytes = Math.min(query?.maxBytes ?? RUNTIME_STATE_SNAPSHOT_MAX_BYTES, RUNTIME_STATE_SNAPSHOT_MAX_BYTES);
      // Capture before the asynchronous read: a commit during the await must
      // not erase text whose durable commit is beyond the returned watermark.
      const live = this.activeMessageParts({ ...query, maxBytes });
      const snapshot = await inner.runtimeSnapshot!(query);
      const completed = new Set<string>();
      const messages = new Set<string>();
      const represented = new Set<string>();
      for (const event of snapshot.events) {
        if (event.type === "message.created") messages.add(event.payload.messageId);
        if (event.type === "message.part_stream_snapshot") represented.add(event.payload.part.id);
        if ((event.type === "message.part_committed" || event.type === "message.part_added")
          && isCompletedPart(event.payload.part)) completed.add(event.payload.part.id);
      }
      if (live.some((event) => event.type === "message.part_stream_snapshot" && !messages.has(event.payload.messageId))) {
        throw new RuntimeSnapshotLimitError();
      }
      const events = [...snapshot.events, ...live.filter((event) => event.type === "message.part_stream_snapshot"
        && !represented.has(event.payload.part.id) && !completed.has(event.payload.part.id))];
      const result = { ...snapshot, events };
      // Active text is never clipped: its full string length is the offset
      // baseline for subsequent live deltas. Fail instead of creating a gap.
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes) throw new RuntimeSnapshotLimitError();
      return result;
    };
    if (inner.sessionInputForMessage) this.sessionInputForMessage = (sessionId, messageId) => inner.sessionInputForMessage!(sessionId, messageId);
  }

  async append(event: RuntimeEvent, options?: EventAppendOptions): Promise<void> {
    await this.appendCommitted(event, options);
  }

  supportsSessionInputs(): boolean {
    const store = this.inner as EventStore & Partial<SessionInputStore>;
    return !!store.mutateSessionInputs && store.supportsSessionInputs?.() !== false;
  }

  private inputStore(): SessionInputStore {
    if (!this.supportsSessionInputs()) throw new Error("Store does not support durable session inputs");
    return this.inner as EventStore & SessionInputStore;
  }

  sessionInputQueue(sessionId: SessionId) { return this.inputStore().sessionInputQueue(sessionId); }

  sessionInput(sessionId: SessionId, submissionId: string) { return this.inputStore().sessionInput(sessionId, submissionId); }

  sessionInputById(sessionId: SessionId, inputId: string) { return this.inputStore().sessionInputById(sessionId, inputId); }

  mutateSessionInputs(input: SessionInputMutation, options?: SessionInputMutationOptions) {
    const result = this.inputStore().mutateSessionInputs(input, options);
    for (const event of result.events) this.emit(event);
    return result;
  }

  async session(sessionId: SessionId): Promise<SessionRow | undefined> {
    const store = this.inner as EventStore & Partial<AgentSessionStore>;
    return store.session ? store.session(sessionId) : (await store.sessions()).find((session) => session.id === sessionId);
  }

  async childSessions(parentSessionId: SessionId): Promise<SessionRow[]> {
    const store = this.inner as EventStore & Partial<AgentSessionStore>;
    return store.childSessions ? store.childSessions(parentSessionId) : (await store.sessions()).filter((session) => session.agent?.parentSessionId === parentSessionId);
  }

  async createChildSession(input: CreateChildSessionInput): Promise<CreateChildSessionResult> {
    const store = this.inner as EventStore & Partial<AgentSessionStore>;
    if (!store.createChildSession) throw new Error("Store does not support atomic Agent creation");
    const result = await store.createChildSession(input);
    for (const event of result.events) this.emit(event);
    return result;
  }

  async appendCommitted(event: RuntimeEvent, options?: EventAppendOptions): Promise<boolean> {
    const aware = this.inner as EventStore & Partial<EventCommitAwareStore>;
    const committed = aware.appendCommitted
      ? await aware.appendCommitted(event, options)
      : (await this.inner.append(event, options), true);
    if (committed) this.emit(event);
    return committed;
  }

  async appendMany(
    events: readonly RuntimeEvent[],
    options?: EventAppendOptions,
  ): Promise<void> {
    await this.appendManyCommitted(events, options);
  }

  async appendManyCommitted(
    events: readonly RuntimeEvent[],
    options?: EventAppendOptions,
  ): Promise<readonly RuntimeEvent[]> {
    const aware = this.inner as EventStore & Partial<EventCommitAwareStore>;
    const committed = aware.appendManyCommitted
      ? await aware.appendManyCommitted(events, options)
      : (await this.inner.appendMany(events, options), events);
    for (const event of committed) this.emit(event);
    return committed;
  }

  async reconcileStaleTurns(input: StaleTurnRecoveryInput): Promise<RuntimeEvent[]> {
    const recovery = this.inner as EventStore & Partial<StaleTurnRecoveryStore>;
    if (!recovery.reconcileStaleTurns) return [];
    const events = await recovery.reconcileStaleTurns(input);
    // The inner store has already committed these events atomically. Emit them
    // directly so live SSE subscribers observe recovery without re-appending.
    for (const event of events) this.emit(event);
    return events;
  }

  events(query?: EventQuery): Promise<EventEnvelope[]> {
    return this.inner.events(query);
  }

  sessions(): Promise<SessionRow[]> {
    return this.inner.sessions();
  }

  sessionRunClaim(sessionId: SessionId): { claimId: string; leaseExpiresAt: number } | undefined {
    const store = this.inner as EventStore & {
      sessionRunClaim?: (sessionId: SessionId) => { claimId: string; leaseExpiresAt: number } | undefined;
    };
    return store.sessionRunClaim?.(sessionId);
  }

  async messages(sessionId: SessionId): Promise<Message[]> {
    const live = this.activeMessageParts({ sessionId });
    const messages = await this.inner.messages(sessionId);
    return messages.map((message) => {
      const additions = live.filter((event) => event.type === "message.part_stream_snapshot"
        && event.payload.messageId === message.id);
      if (!additions.length) return message;
      const parts = [...message.parts];
      for (const event of additions) {
        if (event.type !== "message.part_stream_snapshot") continue;
        const index = parts.findIndex((part) => part.id === event.payload.part.id);
        if (index < 0) parts.push(event.payload.part);
        else if (!isCompletedPart(parts[index]!)) parts[index] = event.payload.part;
      }
      const originalOrder = new Map(parts.map((part, index) => [part.id, index]));
      parts.sort((a, b) => (a.ordinal ?? originalOrder.get(a.id)!) - (b.ordinal ?? originalOrder.get(b.id)!));
      return { ...message, parts };
    });
  }

  activeMessageParts(query: { sessionId?: SessionId; maxBytes?: number } = {}): ChiliEvent[] {
    if (query.maxBytes !== undefined && (!Number.isSafeInteger(query.maxBytes) || query.maxBytes < 1)) {
      throw new RangeError("active message maxBytes must be positive");
    }
    const events: ChiliEvent[] = [];
    let bytes = 2;
    for (const event of this.activeParts.values()) {
      if (query.sessionId && event.sessionId !== query.sessionId) continue;
      if (query.maxBytes !== undefined) {
        bytes += Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
        if (bytes > query.maxBytes) throw new RuntimeSnapshotLimitError();
      }
      events.push({ ...event, payload: { ...event.payload, part: { ...event.payload.part } } });
    }
    return events;
  }

  pendingApprovals(sessionId?: SessionId, limit?: number): Promise<ApprovalRow[]> {
    return this.inner.pendingApprovals(sessionId, limit);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    this.updateActiveParts(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.listeners.delete(listener);
        try {
          this.options.onListenerError?.(error, event);
        } catch {
          // Diagnostics must not change the outcome of an already committed event.
        }
      }
    }
  }

  private updateActiveParts(event: RuntimeEvent): void {
    if (event.type === "message.part_committed") {
      this.activeParts.delete(event.payload.part.id);
      return;
    }
    if (event.type !== "message.part_stream_delta" || !event.sessionId) return;
    const { messageId, partId, partType, delta, offset, phase, redacted, ordinal } = event.payload;
    const previous = this.activeParts.get(partId)?.payload.part;
    const text = previous?.text ?? "";
    if (offset > text.length) throw new Error(`Live message part ${partId} has a gap before offset ${offset}`);
    // Retransmitted/overlapping transient notifications do not duplicate text.
    const suffix = delta.slice(Math.max(0, text.length - offset));
    const base = { id: partId as PartId, messageId, sessionId: event.sessionId, text: text + suffix,
      ...(ordinal !== undefined ? { ordinal } : previous?.ordinal !== undefined ? { ordinal: previous.ordinal } : {}) };
    const part: TextPart | ReasoningPart = partType === "text"
      ? { ...base, type: "text", ...(phase ? { phase } : previous?.type === "text" && previous.phase ? { phase: previous.phase } : {}) }
      : { ...base, type: "reasoning", ...(redacted !== undefined ? { redacted } : previous?.type === "reasoning" && previous.redacted !== undefined ? { redacted: previous.redacted } : {}) };
    this.activeParts.set(partId, {
      id: `live:${event.id}`, type: "message.part_stream_snapshot", time: event.time,
      sessionId: event.sessionId, payload: { messageId, part },
    });
  }
}

function isCompletedPart(part: MessagePart): boolean {
  return (part.type === "text" || part.type === "reasoning") && part.completion !== undefined;
}
