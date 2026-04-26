import { expect, test } from "bun:test";
import type {
  ApprovalRow,
  AgentTaskRow,
  EventPublisher,
  EventQuery,
  EventStore,
  SessionRow,
} from "@chili/store";
import { ObservableEventStore } from "@chili/store";
import type {
  AgentPath,
  AgentRunId,
  ChiliEvent,
  EventEnvelope,
  Message,
  RuntimeSessionRef,
  SessionId,
  TaskId,
  TeamId,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import type { RuntimeAgentsSnapshot } from "./agent-projection.js";
import type { RuntimeHttpService, RuntimeTaskControlService } from "./runtime-http.js";
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

test("serves subagent runs and tasks through an event replay projection", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });
  const session = await service.createSession({ cwd: "/repo" });
  const rootRunId = "agentrun_http_root" as AgentRunId;
  const childRunId = "agentrun_http_child" as AgentRunId;
  const rootPath = "/root" as AgentPath;
  const childPath = "/root/reviewer" as AgentPath;
  const teamId = "team_http" as TeamId;
  const taskId = "task_http" as TaskId;

  await store.appendMany([
    {
      id: "event_agent_root",
      type: "agent.spawned",
      time: 2 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: { runId: rootRunId, path: rootPath, taskName: "lead" },
    },
    {
      id: "event_agent_child",
      type: "agent.spawned",
      time: 3 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: { runId: childRunId, path: childPath, parentPath: rootPath, taskName: "review" },
    },
    {
      id: "event_task_created",
      type: "team.task_created",
      time: 4 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: { teamId, taskId, ownerPath: childPath },
    },
    {
      id: "event_mailbox",
      type: "agent.message_queued",
      time: 5 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: { path: childPath, from: rootPath, triggerTurn: true },
    },
    {
      id: "event_task_done",
      type: "team.task_updated",
      time: 6 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: { teamId, taskId, status: "completed" },
    },
  ]);

  const response = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/agents`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as RuntimeAgentsSnapshot;

  expect(body.agents.map((agent) => agent.id)).toEqual([rootRunId, childRunId]);
  expect(body.agents[0]?.childRunIds).toEqual([childRunId]);
  expect(body.agents[1]?.mailboxMessageIds).toEqual(["event_mailbox"]);
  expect(body.tasks[0]?.status).toBe("completed");
  expect(body.mailbox[0]?.triggerTurn).toBe(true);
});

test("serves task control routes", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const tasks = new FakeTaskControlService();
  const handler = createRuntimeHttpHandler({ service, store, tasks });

  const listResponse = await handler(new Request("http://chili.test/tasks?status=running"));
  expect(listResponse.status).toBe(200);
  expect(await listResponse.json()).toMatchObject([{ id: "task_http", status: "running" }]);
  expect(tasks.lastListStatus).toBe("running");

  const taskResponse = await handler(new Request("http://chili.test/tasks/task_http"));
  expect(taskResponse.status).toBe(200);
  expect(await taskResponse.json()).toMatchObject({ id: "task_http", status: "running" });

  const followupResponse = await handler(
    new Request("http://chili.test/tasks/task_http/followup", {
      method: "POST",
      body: JSON.stringify({ text: "continue", maxTurns: 2 }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(followupResponse.status).toBe(200);
  expect(await followupResponse.json()).toMatchObject({
    task: { id: "task_http", status: "completed", summary: "done" },
    result: { status: "completed", finishReason: "stop" },
  });
  expect(tasks.lastFollowupText).toBe("continue");

  const waitResponse = await handler(
    new Request("http://chili.test/tasks/task_http/wait", {
      method: "POST",
      body: JSON.stringify({ timeoutMs: 10 }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(waitResponse.status).toBe(200);
  expect(await waitResponse.json()).toMatchObject({ id: "task_http" });

  const closeResponse = await handler(
    new Request("http://chili.test/tasks/task_http/close", {
      method: "POST",
      body: JSON.stringify({ status: "cancelled", summary: "stopped" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(closeResponse.status).toBe(200);
  expect(await closeResponse.json()).toMatchObject({ id: "task_http", status: "cancelled", summary: "stopped" });
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

class FakeTaskControlService implements RuntimeTaskControlService {
  lastListStatus: string | undefined;
  lastFollowupText: string | undefined;

  async listTasks(query: { status?: string } = {}): Promise<AgentTaskRow[]> {
    this.lastListStatus = query.status;
    return [taskRow({ status: "running" })];
  }

  async getTask(): Promise<AgentTaskRow> {
    return taskRow({ status: "running" });
  }

  async followupTask(input: { text: string }): Promise<Awaited<ReturnType<RuntimeTaskControlService["followupTask"]>>> {
    this.lastFollowupText = input.text;
    return {
      task: taskRow({ status: "completed", summary: "done" }),
      result: {
        status: "completed",
        turns: [],
        finishReason: "stop",
      },
    };
  }

  async waitForTask(): Promise<AgentTaskRow> {
    return taskRow({ status: "completed", summary: "done" });
  }

  async closeTask(input: { status?: "completed" | "failed" | "cancelled"; summary?: string }): Promise<AgentTaskRow> {
    const rowInput: { status: AgentTaskRow["status"]; summary?: string } = { status: input.status ?? "cancelled" };
    if (input.summary) rowInput.summary = input.summary;
    return taskRow(rowInput);
  }
}

function taskRow(input: { status: AgentTaskRow["status"]; summary?: string }): AgentTaskRow {
  const row: AgentTaskRow = {
    id: "task_http" as TaskId,
    path: "/root/task_http" as AgentPath,
    taskName: "review",
    status: input.status,
    childSessionId: "session_child" as SessionId,
    childThreadId: "thread_child" as ThreadId,
    createdAt: 1,
    updatedAt: 2,
  };
  if (input.summary) row.summary = input.summary;
  return row;
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
