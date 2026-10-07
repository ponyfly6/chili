import type { ChiliEvent, RuntimeEvent, EventEnvelope, Message, MessagePart, MessageRole, SessionId } from "@chili/protocol";
import type {
  ApprovalRow,
  EventAppendOptions,
  EventCommitAwareStore,
  EventQuery,
  EventStore,
  SessionRow,
  StaleTurnRecoveryInput,
  StaleTurnRecoveryStore,
} from "@chili/store";

export class PrintingEventStore implements EventStore, EventCommitAwareStore, StaleTurnRecoveryStore {
  readonly eventReplayBoundary?: NonNullable<EventStore["eventReplayBoundary"]>;
  readonly runtimeSnapshot?: NonNullable<EventStore["runtimeSnapshot"]>;
  readonly activeMessageParts?: NonNullable<EventStore["activeMessageParts"]>;

  constructor(private readonly inner: EventStore, private readonly printer: CliPrinter) {
    if (inner.eventReplayBoundary) this.eventReplayBoundary = (query) => inner.eventReplayBoundary!(query);
    if (inner.runtimeSnapshot) this.runtimeSnapshot = (query) => inner.runtimeSnapshot!(query);
    if (inner.activeMessageParts) this.activeMessageParts = (query) => inner.activeMessageParts!(query);
  }

  async append(event: RuntimeEvent, options?: EventAppendOptions): Promise<void> {
    await this.appendCommitted(event, options);
  }

  async appendCommitted(event: RuntimeEvent, options?: EventAppendOptions): Promise<boolean> {
    const aware = this.inner as EventStore & Partial<EventCommitAwareStore>;
    const committed = aware.appendCommitted
      ? await aware.appendCommitted(event, options)
      : (await this.inner.append(event, options), true);
    if (committed) this.printer.event(event);
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
    for (const event of committed) this.printer.event(event);
    return committed;
  }

  async reconcileStaleTurns(input: StaleTurnRecoveryInput): Promise<RuntimeEvent[]> {
    const recovery = this.inner as EventStore & Partial<StaleTurnRecoveryStore>;
    if (!recovery.reconcileStaleTurns) return [];
    const events = await recovery.reconcileStaleTurns(input);
    for (const event of events) this.printer.event(event);
    return events;
  }

  events(query?: EventQuery): Promise<EventEnvelope[]> {
    return this.inner.events(query);
  }

  sessions(): Promise<SessionRow[]> {
    return this.inner.sessions();
  }

  messages(sessionId: SessionId): Promise<Message[]> {
    return this.inner.messages(sessionId);
  }

  pendingApprovals(sessionId?: SessionId, limit?: number): Promise<ApprovalRow[]> {
    return this.inner.pendingApprovals(sessionId, limit);
  }
}

export class CliPrinter {
  private needsNewline = false;
  private readonly roles = new Map<string, MessageRole>();
  private readonly partRoles = new Map<string, MessageRole | undefined>();
  private readonly partTypes = new Map<string, MessagePart["type"]>();
  private readonly printedTextLengths = new Map<string, number>();
  private readonly committedParts = new Set<string>();

  event(event: ChiliEvent): void {
    if (event.type === "session.created" && event.payload.agent) {
      this.line(`\n[agent] ${event.sessionId} ${event.payload.agent.path} (${event.payload.agent.name})`);
      return;
    }
    if (event.type === "message.created") {
      this.roles.set(event.payload.messageId, event.payload.role);
      return;
    }

    if (event.type === "message.part_added" || event.type === "message.part_stream_snapshot" || event.type === "message.part_committed") {
      const role = this.roles.get(event.payload.messageId);
      this.partRoles.set(event.payload.part.id, role);
      this.partTypes.set(event.payload.part.id, event.payload.part.type);
      this.part(event.payload.part, role);
      if (event.type === "message.part_committed") this.committedParts.add(event.payload.part.id);
      return;
    }

    if (event.type === "message.part_stream_delta") {
      const { messageId, partId, partType, delta, offset } = event.payload;
      this.partRoles.set(partId, this.roles.get(messageId));
      this.partTypes.set(partId, partType);
      this.partDelta(partId, "text", delta, offset);
      return;
    }

    if (event.type === "message.part_delta") {
      this.partDelta(event.payload.partId, event.payload.field, event.payload.delta);
      return;
    }

    if (event.type === "tool.call_updated" && event.payload.status === "waiting_for_approval") {
      this.line(`\n[tool] waiting for approval (${event.payload.callId})`);
      return;
    }

    if (event.type === "turn.retry_scheduled") {
      this.line(`\n[retry] attempt ${event.payload.attempt} in ${event.payload.delayMs}ms: ${event.payload.reason}`);
      return;
    }

    if (event.type === "turn.compaction_requested") {
      this.line(`\n[context] compaction boundary requested (${event.payload.estimatedChars}/${event.payload.budgetChars} chars)`);
      return;
    }

    if (event.type === "turn.compaction_started") {
      this.line(`\n[context] compacting ${event.payload.reason}`);
      return;
    }

    if (event.type === "turn.compaction_completed") {
      this.line(
        `\n[context] compacted ${event.payload.sourceMessageCount} messages (${event.payload.estimatedCharsBefore} -> ${event.payload.estimatedCharsAfter} chars)`,
      );
      return;
    }

    if (event.type === "turn.compaction_failed") {
      this.line(`\n[context] compaction failed: ${event.payload.error}`);
      return;
    }

    if (event.type === "turn.guard_triggered") {
      this.line(`\n[guard] ${event.payload.reason} (${event.payload.count})`);
      return;
    }

    if (event.type === "snapshot.created") {
      this.line(`\n[snapshot] ${event.payload.snapshotId} ${event.payload.paths.join(", ")}`);
    }
  }

  private part(part: MessagePart, role: MessageRole | undefined): void {
    if (role !== "assistant") return;

    if (part.type === "text") {
      this.partDelta(part.id, "text", part.text, 0);
      return;
    }

    if (part.type === "tool_call") {
      this.line(`\n[tool] ${part.toolName} ${formatJson(part.input)}`);
      return;
    }

    if (part.type === "tool_result") {
      if (part.error) {
        this.line(`[tool:error] ${part.error}`);
      } else {
        this.line(`[tool:result] ${truncate(part.output, 1600)}`);
      }
    }
  }

  private partDelta(partId: string, field: string, delta: string, offset?: number): void {
    if (field !== "text") return;
    if (this.partRoles.get(partId) !== "assistant") return;
    if (this.partTypes.get(partId) !== "text") return;
    if (this.committedParts.has(partId)) return;
    const printedLength = this.printedTextLengths.get(partId) ?? 0;
    const start = offset ?? printedLength;
    // A missing interval is repaired by the next complete snapshot or commit.
    // Replayed and overlapping intervals must never print the same text twice.
    if (start > printedLength) return;
    const suffix = delta.slice(printedLength - start);
    if (!suffix) return;
    process.stdout.write(suffix);
    this.printedTextLengths.set(partId, printedLength + suffix.length);
    this.needsNewline = true;
  }

  line(text = ""): void {
    if (this.needsNewline) {
      process.stdout.write("\n");
      this.needsNewline = false;
    }
    console.log(text);
  }
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[cli output truncated]`;
}
