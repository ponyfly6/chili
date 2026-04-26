import type { ChiliEvent, EventEnvelope, Message, SessionId } from "@chili/protocol";
import type { ApprovalRow, EventQuery, EventStore, SessionRow } from "./types.js";

export interface EventPublisher {
  subscribe(listener: (event: ChiliEvent) => void): () => void;
}

export class ObservableEventStore implements EventStore, EventPublisher {
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

  subscribe(listener: (event: ChiliEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ChiliEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
