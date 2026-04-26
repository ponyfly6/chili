import type { ChiliEvent, EventEnvelope, Message, SessionId, TaskId } from "@chili/protocol";
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
} from "./types.js";

export interface EventPublisher {
  subscribe(listener: (event: ChiliEvent) => void): () => void;
}

export class ObservableEventStore implements EventStore, EventPublisher, SubagentProjectionStore {
  private readonly listeners = new Set<(event: ChiliEvent) => void>();

  constructor(private readonly inner: EventStore) {}

  async append(event: ChiliEvent): Promise<void> {
    await this.inner.append(event);
    this.emit(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    await this.inner.appendMany(events);
    for (const event of events) this.emit(event);
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

  subscribe(listener: (event: ChiliEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ChiliEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private subagentStore(): SubagentProjectionStore | undefined {
    const inner = this.inner as EventStore & Partial<SubagentProjectionStore>;
    if (inner.agentTasks && inner.agentTask && inner.agentRuns && inner.agentMailbox) {
      return inner as SubagentProjectionStore;
    }
    return undefined;
  }
}
