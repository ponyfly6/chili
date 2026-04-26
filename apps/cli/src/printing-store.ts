import type { ChiliEvent, EventEnvelope, Message, MessagePart, MessageRole, SessionId, TaskId } from "@chili/protocol";
import type {
  AgentMailboxQuery,
  AgentMailboxRow,
  AgentRunQuery,
  AgentRunRow,
  AgentTaskQuery,
  AgentTaskRow,
  ApprovalRow,
  EventQuery,
  EventStore,
  SessionRow,
  SubagentProjectionStore,
} from "@chili/store";

export class PrintingEventStore implements EventStore, SubagentProjectionStore {
  constructor(private readonly inner: EventStore, private readonly printer: CliPrinter) {}

  async append(event: ChiliEvent): Promise<void> {
    await this.inner.append(event);
    this.printer.event(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    await this.inner.appendMany(events);
    for (const event of events) this.printer.event(event);
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

  pendingApprovals(sessionId?: SessionId): Promise<ApprovalRow[]> {
    return this.inner.pendingApprovals(sessionId);
  }

  agentTasks(query?: AgentTaskQuery): Promise<AgentTaskRow[]> {
    return this.subagentStore()?.agentTasks(query) ?? Promise.resolve([]);
  }

  agentTask(taskId: TaskId): Promise<AgentTaskRow | undefined> {
    return this.subagentStore()?.agentTask(taskId) ?? Promise.resolve(undefined);
  }

  agentRuns(query?: AgentRunQuery): Promise<AgentRunRow[]> {
    return this.subagentStore()?.agentRuns(query) ?? Promise.resolve([]);
  }

  agentMailbox(query?: AgentMailboxQuery): Promise<AgentMailboxRow[]> {
    return this.subagentStore()?.agentMailbox(query) ?? Promise.resolve([]);
  }

  private subagentStore(): SubagentProjectionStore | undefined {
    const inner = this.inner as EventStore & Partial<SubagentProjectionStore>;
    if (inner.agentTasks && inner.agentTask && inner.agentRuns && inner.agentMailbox) {
      return inner as SubagentProjectionStore;
    }
    return undefined;
  }
}

export class CliPrinter {
  private needsNewline = false;
  private readonly roles = new Map<string, MessageRole>();
  private readonly partRoles = new Map<string, MessageRole | undefined>();
  private readonly partTypes = new Map<string, MessagePart["type"]>();

  event(event: ChiliEvent): void {
    if (event.type === "message.created") {
      this.roles.set(event.payload.messageId, event.payload.role);
      return;
    }

    if (event.type === "message.part_added") {
      const role = this.roles.get(event.payload.messageId);
      this.partRoles.set(event.payload.part.id, role);
      this.partTypes.set(event.payload.part.id, event.payload.part.type);
      this.part(event.payload.part, role);
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

    if (event.type === "turn.guard_triggered") {
      this.line(`\n[guard] ${event.payload.reason} (${event.payload.count})`);
      return;
    }

    if (event.type === "agent.task_created") {
      this.line(`\n[task] ${event.payload.taskId} -> ${event.payload.path} (${event.payload.taskName})`);
      return;
    }

    if (event.type === "agent.spawned") {
      const parent = event.payload.parentPath ? ` parent=${event.payload.parentPath}` : "";
      this.line(`\n[agent] spawned ${event.payload.path} (${event.payload.taskName})${parent}`);
      return;
    }

    if (event.type === "agent.message_queued") {
      const trigger = event.payload.triggerTurn ? " trigger=turn" : "";
      this.line(`\n[agent] message queued ${event.payload.from} -> ${event.payload.path}${trigger}`);
      return;
    }

    if (event.type === "agent.completed") {
      this.line(`\n[agent] completed ${event.payload.path}: ${event.payload.status}`);
      return;
    }

    if (event.type === "agent.task_completed") {
      this.line(`\n[task] ${event.payload.taskId}: ${event.payload.status}`);
      return;
    }

    if (event.type === "team.task_created") {
      const owner = event.payload.ownerPath ? ` owner=${event.payload.ownerPath}` : "";
      this.line(`\n[task] created ${event.payload.taskId} team=${event.payload.teamId}${owner}`);
      return;
    }

    if (event.type === "team.task_updated") {
      this.line(`\n[task] ${event.payload.taskId}: ${event.payload.status}`);
      return;
    }

    if (event.type === "snapshot.created") {
      this.line(`\n[snapshot] ${event.payload.snapshotId} ${event.payload.paths.join(", ")}`);
    }
  }

  private part(part: MessagePart, role: MessageRole | undefined): void {
    if (role !== "assistant") return;

    if (part.type === "text") {
      process.stdout.write(part.text);
      this.needsNewline = true;
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

  private partDelta(partId: string, field: string, delta: string): void {
    if (field !== "text") return;
    if (this.partRoles.get(partId) !== "assistant") return;
    if (this.partTypes.get(partId) !== "text") return;
    process.stdout.write(delta);
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
