import { expect, test } from "bun:test";
import type {
  ApprovalRow,
  EventPublisher,
  EventQuery,
  EventStore,
  SessionRow,
} from "@chili/store";
import { ObservableEventStore } from "@chili/store";
import type {
  ChiliEvent,
  EventEnvelope,
  Message,
  RuntimeSessionRef,
  SessionId,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import type { RuntimeHttpService } from "./runtime-http.js";
import { createRuntimeHttpHandler } from "./runtime-http.js";

test("serves sessions and event backlog over the runtime HTTP handler", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });

  const createResponse = await handler(
    new Request("http://chili.test/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd: "/repo" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(createResponse.status).toBe(201);
  const session = (await createResponse.json()) as RuntimeSessionRef;

  const sessionsResponse = await handler(new Request("http://chili.test/sessions"));
  expect(sessionsResponse.status).toBe(200);
  const sessions = (await sessionsResponse.json()) as SessionRow[];
  expect(sessions[0]?.id).toBe(session.sessionId);

  const controller = new AbortController();
  const eventsResponse = await handler(
    new Request(`http://chili.test/events?sessionId=${session.sessionId}`, {
      signal: controller.signal,
    }),
  );
  expect(eventsResponse.status).toBe(200);
  const reader = eventsResponse.body?.getReader();
  if (!reader) throw new Error("expected event stream body");
  const chunk = await reader.read();
  controller.abort();
  reader.releaseLock();

  expect(new TextDecoder().decode(chunk.value)).toContain("session.created");
});

test("resolves approvals through the runtime HTTP handler", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const approvals = {
    resolved: false,
    resolve(input: { decision: "allow_once" | "allow_always" | "deny" }) {
      this.resolved = input.decision === "allow_once";
      return this.resolved;
    },
  };
  const handler = createRuntimeHttpHandler({ service, store, approvals });

  const response = await handler(
    new Request("http://chili.test/approvals/approval_http/resolve", {
      method: "POST",
      body: JSON.stringify({ decision: "allow_once" }),
      headers: { "content-type": "application/json" },
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ resolved: true });
  expect(approvals.resolved).toBe(true);
});

test("does not accept async prompts for missing or busy sessions", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new BusyRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });

  const missingResponse = await handler(
    new Request("http://chili.test/sessions/session_missing/prompt_async", {
      method: "POST",
      body: JSON.stringify({ threadId: "thread_missing", text: "hello" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(missingResponse.status).toBe(404);
  expect(service.accepted).toBe(false);

  const created = await service.createSession();
  const busyResponse = await handler(
    new Request(`http://chili.test/sessions/${created.sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({ threadId: created.threadId, text: "hello" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(busyResponse.status).toBe(409);
  expect(service.accepted).toBe(false);
});

test("cleans up SSE subscriptions when the stream reader is cancelled", async () => {
  const store = new CountingEventStore();
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });

  const response = await handler(new Request("http://chili.test/events"));
  const reader = response.body?.getReader();
  if (!reader) throw new Error("expected event stream body");

  expect(store.listenerCount).toBe(1);
  await reader.cancel();
  expect(store.listenerCount).toBe(0);
});

class FakeRuntimeService implements RuntimeHttpService {
  constructor(private readonly store: EventStore & EventPublisher) {}

  async createSession(input: { sessionId?: SessionId; threadId?: ThreadId; cwd?: string } = {}): Promise<RuntimeSessionRef> {
    const sessionId = input.sessionId ?? ("session_http" as SessionId);
    const threadId = input.threadId ?? ("thread_http" as ThreadId);
    await this.store.append({
      id: "event_session_created",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, cwd: input.cwd ?? "/repo" },
    });
    return { sessionId, threadId };
  }

  async submitPrompt(): Promise<never> {
    throw new Error("not needed in this test");
  }

  submitPromptAsync(): void {
    throw new Error("not needed in this test");
  }

  async interrupt(): Promise<boolean> {
    return true;
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.store.append({
      id: "event_session_archived",
      type: "session.archived",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId },
    });
  }
}

class BusyRuntimeService extends FakeRuntimeService {
  accepted = false;

  override submitPromptAsync(): void {
    const error = new Error("Session is already running: session_http");
    error.name = "RuntimeBusyError";
    throw error;
  }
}

class MemoryEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];
  readonly sessionRows = new Map<string, SessionRow>();

  async append(event: ChiliEvent): Promise<void> {
    this.items.push(event);
    if (event.type === "session.created") {
      this.sessionRows.set(event.payload.sessionId, {
        id: event.payload.sessionId,
        cwd: event.payload.cwd,
        title: "repo",
        status: "active",
        createdAt: event.time,
        updatedAt: event.time,
      });
    }
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    return this.items.filter((event) => {
      if (query.sessionId && event.sessionId !== query.sessionId) return false;
      if (query.threadId && event.threadId !== query.threadId) return false;
      if (query.type && event.type !== query.type) return false;
      return true;
    });
  }

  async sessions(): Promise<SessionRow[]> {
    return [...this.sessionRows.values()];
  }

  async messages(): Promise<Message[]> {
    return [];
  }

  async pendingApprovals(): Promise<ApprovalRow[]> {
    return [];
  }
}

class CountingEventStore extends MemoryEventStore implements EventPublisher {
  listenerCount = 0;

  subscribe(): () => void {
    this.listenerCount++;
    return () => {
      this.listenerCount--;
    };
  }
}
