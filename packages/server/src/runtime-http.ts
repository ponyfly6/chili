import type {
  ChiliEvent,
  AgentPath,
  AgentTaskStatus,
  RuntimeInterruptResult,
  RuntimeApprovalResolveResult,
  RuntimePromptAccepted,
  RuntimePromptResult,
  RuntimeSessionRef,
  RuntimeTurnResult,
  SessionId,
  ThreadId,
  TaskId,
} from "@chili/protocol";
import type {
  AgentTreeSnapshot,
  AgentTreeSnapshotQuery,
  ConsumeAgentMailboxInput,
  AgentTaskCloseInput,
  AgentTaskFinalStatus,
  AgentTaskFollowupInput,
  AgentTaskFollowupResult,
  AgentTaskWaitInput,
  RuntimeBackgroundErrorHandler,
  SubmitPromptInput,
  SubmitPromptResult,
} from "@chili/core";
import type { EventPublisher, EventStore } from "@chili/store";
import type { AgentMailboxQuery, AgentMailboxRow, AgentRunQuery, AgentRunRow, AgentTaskQuery, AgentTaskRow } from "@chili/store";
import { projectRuntimeAgents } from "./agent-projection.js";

export interface RuntimeHttpService {
  createSession(input?: { sessionId?: SessionId; threadId?: ThreadId; cwd?: string }): Promise<RuntimeSessionRef>;
  submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult>;
  submitPromptAsync(input: SubmitPromptInput, onError?: RuntimeBackgroundErrorHandler): void;
  interrupt(sessionId: SessionId, reason?: string): Promise<boolean>;
  archiveSession(sessionId: SessionId): Promise<void>;
}

export interface RuntimeTaskControlService {
  listTasks(query?: AgentTaskQuery): Promise<AgentTaskRow[]>;
  getTask(taskId: TaskId): Promise<AgentTaskRow>;
  followupTask(input: AgentTaskFollowupInput): Promise<AgentTaskFollowupResult>;
  waitForTask(input: AgentTaskWaitInput): Promise<AgentTaskRow>;
  closeTask(input: AgentTaskCloseInput): Promise<AgentTaskRow>;
}

export interface RuntimeAgentTreeService {
  snapshot(query?: AgentTreeSnapshotQuery): Promise<AgentTreeSnapshot>;
  agentRuns(query?: AgentRunQuery): Promise<AgentRunRow[]>;
  mailbox(query?: AgentMailboxQuery): Promise<AgentMailboxRow[]>;
  consumeMailbox(input: ConsumeAgentMailboxInput): Promise<AgentMailboxRow>;
}

export interface RuntimeHttpHandlerOptions {
  service: RuntimeHttpService;
  store: EventStore & EventPublisher;
  tasks?: RuntimeTaskControlService;
  agents?: RuntimeAgentTreeService;
  approvals?: ApprovalResolver;
  maxBacklogEvents?: number;
  onBackgroundError?: (error: unknown) => void;
}

export interface ApprovalResolver {
  resolve(input: {
    approvalId: import("@chili/protocol").ApprovalId;
    decision: "allow_once" | "allow_always" | "deny";
    feedback?: string;
  }): boolean | Promise<boolean>;
}

export interface StartRuntimeHttpServerOptions extends RuntimeHttpHandlerOptions {
  hostname?: string;
  port?: number;
}

export interface RuntimeHttpServer {
  url: string;
  close(): void;
}

export function createRuntimeHttpHandler(options: RuntimeHttpHandlerOptions): (request: Request) => Promise<Response> {
  const maxBacklogEvents = options.maxBacklogEvents ?? 5000;

  return async function runtimeHttpHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = routeRequest(request.method, url.pathname);

    try {
      if (route.name === "health") {
        return json({ ok: true });
      }

      if (route.name === "listSessions") {
        return json(await options.store.sessions());
      }

      if (route.name === "listTasks") {
        const tasks = requireTaskControl(options);
        return json(await tasks.listTasks(taskQueryFromUrl(url)));
      }

      if (route.name === "task") {
        const tasks = requireTaskControl(options);
        return json(await tasks.getTask(route.taskId));
      }

      if (route.name === "taskFollowup") {
        const tasks = requireTaskControl(options);
        const body = await readJson<TaskFollowupBody>(request);
        if (!body.text) throw badRequest("text is required");
        const input: AgentTaskFollowupInput = {
          taskId: route.taskId,
          text: body.text,
        };
        if (body.maxTurns !== undefined) input.maxTurns = body.maxTurns;
        if (body.system) input.system = body.system;
        return json(serializeTaskFollowupResult(await tasks.followupTask(input)));
      }

      if (route.name === "taskWait") {
        const tasks = requireTaskControl(options);
        const body = await readJson<TaskWaitBody>(request);
        const input: AgentTaskWaitInput = { taskId: route.taskId };
        if (body.timeoutMs !== undefined) input.timeoutMs = body.timeoutMs;
        return json(await tasks.waitForTask(input));
      }

      if (route.name === "taskClose") {
        const tasks = requireTaskControl(options);
        const body = await readJson<TaskCloseBody>(request);
        const input: AgentTaskCloseInput = {
          taskId: route.taskId,
          status: closeStatus(body.status),
        };
        if (body.summary) input.summary = body.summary;
        if (body.error) input.error = body.error;
        if (body.interrupt !== undefined) input.interrupt = body.interrupt;
        return json(await tasks.closeTask(input));
      }

      if (route.name === "agentTree") {
        const agents = requireAgentTree(options);
        return json(await agents.snapshot(agentTreeQueryFromUrl(url)));
      }

      if (route.name === "agentRuns") {
        const agents = requireAgentTree(options);
        return json(await agents.agentRuns(agentRunQueryFromUrl(url)));
      }

      if (route.name === "mailbox") {
        const agents = requireAgentTree(options);
        return json(await agents.mailbox(mailboxQueryFromUrl(url)));
      }

      if (route.name === "consumeMailbox") {
        const agents = requireAgentTree(options);
        return json(await agents.consumeMailbox({ messageId: route.messageId }));
      }

      if (route.name === "agents") {
        const query = {
          limit: maxBacklogEvents,
        } as {
          sessionId?: SessionId;
          limit: number;
        };
        if (route.sessionId) query.sessionId = route.sessionId;
        const events = await options.store.events(query);
        return json(projectRuntimeAgents(events, route.sessionId));
      }

      if (route.name === "createSession") {
        const body = await readJson<CreateSessionBody>(request);
        const input: { sessionId?: SessionId; threadId?: ThreadId; cwd?: string } = {};
        if (body.sessionId) input.sessionId = body.sessionId;
        if (body.threadId) input.threadId = body.threadId;
        if (body.cwd) input.cwd = body.cwd;
        return json(await options.service.createSession(input), 201);
      }

      if (route.name === "messages") {
        return json(await options.store.messages(route.sessionId));
      }

      if (route.name === "prompt" || route.name === "promptAsync") {
        const body = await readJson<PromptBody>(request);
        if (!body.threadId) throw badRequest("threadId is required");
        if (!body.text) throw badRequest("text is required");
        await requireSession(options.store, route.sessionId);

        const input = buildSubmitPromptInput(route.sessionId, body);

        if (route.name === "prompt") {
          return json(serializeSubmitPromptResult(await options.service.submitPrompt(input)));
        }

        options.service.submitPromptAsync(input, options.onBackgroundError);
        const accepted: RuntimePromptAccepted = {
          status: "accepted",
          sessionId: route.sessionId,
          threadId: body.threadId,
        };
        return json(accepted, 202);
      }

      if (route.name === "interrupt") {
        const body = await readJson<InterruptBody>(request);
        const result: RuntimeInterruptResult = {
          interrupted: await options.service.interrupt(route.sessionId, body.reason),
        };
        return json(result);
      }

      if (route.name === "archive") {
        await options.service.archiveSession(route.sessionId);
        return new Response(null, { status: 204 });
      }

      if (route.name === "resolveApproval") {
        if (!options.approvals) return jsonError(501, "No approval resolver is configured");
        const body = await readJson<ResolveApprovalBody>(request);
        if (!body.decision) throw badRequest("decision is required");
        const resolveInput: {
          approvalId: import("@chili/protocol").ApprovalId;
          decision: "allow_once" | "allow_always" | "deny";
          feedback?: string;
        } = {
          approvalId: route.approvalId,
          decision: body.decision,
        };
        if (body.feedback) resolveInput.feedback = body.feedback;
        const result: RuntimeApprovalResolveResult = {
          resolved: await options.approvals.resolve(resolveInput),
        };
        return json(result);
      }

      if (route.name === "events") {
        const streamOptions: EventStreamOptions = {
          store: options.store,
          request,
          maxBacklogEvents,
        };
        const sessionId = asSessionId(url.searchParams.get("sessionId"));
        const threadId = asThreadId(url.searchParams.get("threadId"));
        const afterEventId = url.searchParams.get("afterEventId");
        if (sessionId) streamOptions.sessionId = sessionId;
        if (threadId) streamOptions.threadId = threadId;
        if (afterEventId) streamOptions.afterEventId = afterEventId;
        return eventStream(streamOptions);
      }

      return jsonError(404, "Not found");
    } catch (error) {
      const err = toHttpError(error);
      return jsonError(err.status, err.message);
    }
  };
}

export function startRuntimeHttpServer(options: StartRuntimeHttpServerOptions): RuntimeHttpServer {
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    fetch: createRuntimeHttpHandler(options),
  });

  return {
    url: server.url.href,
    close: () => server.stop(true),
  };
}

type Route =
  | { name: "health" }
  | { name: "events" }
  | { name: "agents"; sessionId?: SessionId }
  | { name: "listSessions" }
  | { name: "listTasks" }
  | { name: "agentTree" }
  | { name: "agentRuns" }
  | { name: "mailbox" }
  | { name: "consumeMailbox"; messageId: string }
  | { name: "task"; taskId: TaskId }
  | { name: "taskFollowup"; taskId: TaskId }
  | { name: "taskWait"; taskId: TaskId }
  | { name: "taskClose"; taskId: TaskId }
  | { name: "createSession" }
  | { name: "messages"; sessionId: SessionId }
  | { name: "prompt"; sessionId: SessionId }
  | { name: "promptAsync"; sessionId: SessionId }
  | { name: "interrupt"; sessionId: SessionId }
  | { name: "archive"; sessionId: SessionId }
  | { name: "resolveApproval"; approvalId: import("@chili/protocol").ApprovalId }
  | { name: "notFound" };

interface CreateSessionBody {
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd?: string;
}

interface PromptBody {
  threadId?: ThreadId;
  text?: string;
  cwd?: string;
  maxTurns?: number;
  system?: string[];
}

interface TaskFollowupBody {
  text?: string;
  maxTurns?: number;
  system?: string[];
}

interface TaskWaitBody {
  timeoutMs?: number;
}

interface TaskCloseBody {
  status?: unknown;
  summary?: string;
  error?: string;
  interrupt?: boolean;
}

interface InterruptBody {
  reason?: string;
}

interface ResolveApprovalBody {
  decision?: "allow_once" | "allow_always" | "deny";
  feedback?: string;
}

interface EventStreamOptions {
  store: EventStore & EventPublisher;
  request: Request;
  sessionId?: SessionId;
  threadId?: ThreadId;
  afterEventId?: string;
  maxBacklogEvents: number;
}

interface HttpError {
  status: number;
  message: string;
}

function routeRequest(method: string, pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (method === "GET" && path === "/health") return { name: "health" };
  if (method === "GET" && path === "/events") return { name: "events" };
  if (method === "GET" && path === "/agents") return { name: "agents" };
  if (method === "GET" && path === "/agents/tree") return { name: "agentTree" };
  if (method === "GET" && path === "/agent_runs") return { name: "agentRuns" };
  if (method === "GET" && path === "/mailbox") return { name: "mailbox" };
  if (method === "GET" && path === "/sessions") return { name: "listSessions" };
  if (method === "GET" && path === "/tasks") return { name: "listTasks" };
  if (method === "POST" && path === "/sessions") return { name: "createSession" };

  const mailboxRoute = /^\/mailbox\/([^/]+)\/consume$/.exec(path);
  if (method === "POST" && mailboxRoute) {
    return { name: "consumeMailbox", messageId: decodeURIComponent(mailboxRoute[1] ?? "") };
  }

  const approvalRoute = /^\/approvals\/([^/]+)\/resolve$/.exec(path);
  if (method === "POST" && approvalRoute) {
    return {
      name: "resolveApproval",
      approvalId: decodeURIComponent(approvalRoute[1] ?? "") as import("@chili/protocol").ApprovalId,
    };
  }

  const taskRoute = /^\/tasks\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (taskRoute) {
    const taskId = decodeURIComponent(taskRoute[1] ?? "") as TaskId;
    const action = taskRoute[2];
    if (method === "GET" && !action) return { name: "task", taskId };
    if (method === "POST" && action === "followup") return { name: "taskFollowup", taskId };
    if (method === "POST" && action === "wait") return { name: "taskWait", taskId };
    if (method === "POST" && action === "close") return { name: "taskClose", taskId };
    return { name: "notFound" };
  }

  const sessionRoute = /^\/sessions\/([^/]+)\/([^/]+)$/.exec(path);
  if (!sessionRoute) return { name: "notFound" };

  const sessionId = decodeURIComponent(sessionRoute[1] ?? "") as SessionId;
  const action = sessionRoute[2];
  if (method === "GET" && action === "agents") return { name: "agents", sessionId };
  if (method === "GET" && action === "messages") return { name: "messages", sessionId };
  if (method === "POST" && action === "prompt") return { name: "prompt", sessionId };
  if (method === "POST" && action === "prompt_async") return { name: "promptAsync", sessionId };
  if (method === "POST" && action === "interrupt") return { name: "interrupt", sessionId };
  if (method === "POST" && action === "archive") return { name: "archive", sessionId };
  return { name: "notFound" };
}

function buildSubmitPromptInput(sessionId: SessionId, body: PromptBody): SubmitPromptInput {
  const input: SubmitPromptInput = {
    sessionId,
    threadId: body.threadId as ThreadId,
    text: body.text ?? "",
  };
  if (body.cwd) input.cwd = body.cwd;
  if (body.maxTurns !== undefined) input.maxTurns = body.maxTurns;
  if (body.system) input.system = body.system;
  return input;
}

async function eventStream(options: EventStreamOptions): Promise<Response> {
  const encoder = new TextEncoder();
  const sentIds = new Set<string>();
  const pending: ChiliEvent[] = [];
  let backlogDone = false;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closeController: (() => void) | undefined;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    closeController?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChiliEvent): void => {
        if (closed || sentIds.has(event.id) || !matchesEvent(event, options)) return;
        sentIds.add(event.id);
        controller.enqueue(encoder.encode(formatSse(event)));
      };

      unsubscribe = options.store.subscribe((event) => {
        if (backlogDone) {
          send(event);
        } else {
          pending.push(event);
        }
      });

      closeController = (): void => {
        try {
          controller.close();
        } catch {
          // The client may have closed first.
        }
      };

      options.request.signal.addEventListener("abort", cleanup, { once: true });
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);

      const query = {
        limit: options.maxBacklogEvents,
      } as {
        sessionId?: SessionId;
        threadId?: ThreadId;
        afterEventId?: string;
        limit: number;
      };
      if (options.sessionId) query.sessionId = options.sessionId;
      if (options.threadId) query.threadId = options.threadId;
      if (options.afterEventId) query.afterEventId = options.afterEventId;
      const backlog = await options.store.events(query);
      for (const event of backlog) send(event as ChiliEvent);
      backlogDone = true;
      for (const event of pending.splice(0)) send(event);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function matchesEvent(event: ChiliEvent, options: EventStreamOptions): boolean {
  if (options.sessionId && event.sessionId !== options.sessionId) return false;
  if (options.threadId && event.threadId !== options.threadId) return false;
  return true;
}

function formatSse(event: ChiliEvent): string {
  return [`id: ${event.id}`, "event: chili.event", `data: ${JSON.stringify(event)}`, "", ""].join("\n");
}

function serializeSubmitPromptResult(result: SubmitPromptResult): RuntimePromptResult {
  const turns = result.turns.map(serializeTurnResult);
  if (result.status === "completed") {
    const completed: Extract<RuntimePromptResult, { status: "completed" }> = { status: "completed", turns };
    if (result.finishReason) completed.finishReason = result.finishReason;
    return completed;
  }

  const failed: Extract<RuntimePromptResult, { status: "failed" | "cancelled" | "max_turns" }> = {
    status: result.status,
    turns,
  };
  if (result.error) failed.error = serializeError(result.error);
  if (result.finishReason) failed.finishReason = result.finishReason;
  return failed;
}

function serializeTaskFollowupResult(result: AgentTaskFollowupResult): { task: AgentTaskRow; result: RuntimePromptResult } {
  return {
    task: result.task,
    result: serializeSubmitPromptResult(result.result),
  };
}

function serializeTurnResult(result: SubmitPromptResult["turns"][number]): RuntimeTurnResult {
  if (result.status === "completed") {
    const completed: Extract<RuntimeTurnResult, { status: "completed" }> = {
      status: "completed",
      turnId: result.turnId,
      assistantMessageId: result.assistantMessageId,
    };
    if (result.finishReason) completed.finishReason = result.finishReason;
    return completed;
  }

  const failed: Extract<RuntimeTurnResult, { status: "failed" | "cancelled" }> = {
    status: result.status,
    turnId: result.turnId,
    error: serializeError(result.error),
  };
  if (result.assistantMessageId) failed.assistantMessageId = result.assistantMessageId;
  return failed;
}

function serializeError(error: Error): { name: string; message: string } {
  return {
    name: error.name || "Error",
    message: error.message,
  };
}

async function requireSession(store: EventStore, sessionId: SessionId): Promise<void> {
  const sessions = await store.sessions();
  if (!sessions.some((session) => session.id === sessionId)) {
    throw notFound(`Session not found: ${sessionId}`);
  }
}

async function readJson<T>(request: Request): Promise<T> {
  if (request.headers.get("content-length") === "0") return {} as T;
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function jsonError(status: number, message: string): Response {
  return json({ error: { message } }, status);
}

function badRequest(message: string): HttpError {
  return { status: 400, message };
}

function notFound(message: string): HttpError {
  return { status: 404, message };
}

function toHttpError(error: unknown): HttpError {
  if (isHttpError(error)) return error;
  const err = error instanceof Error ? error : new Error(String(error));
  if (err.name === "AgentTaskNotFoundError") {
    return { status: 404, message: err.message };
  }
  if (err.name === "AgentTaskNotRunnableError") {
    return { status: 409, message: err.message };
  }
  if (err.name === "AgentTaskWaitTimeoutError") {
    return { status: 408, message: err.message };
  }
  if (err.name === "AgentMailboxNotFoundError") {
    return { status: 404, message: err.message };
  }
  if (err.name === "RuntimeBusyError") {
    return { status: 409, message: err.message };
  }
  return { status: 500, message: err.message };
}

function isHttpError(error: unknown): error is HttpError {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  );
}

function asSessionId(value: string | null): SessionId | undefined {
  return value ? (value as SessionId) : undefined;
}

function asThreadId(value: string | null): ThreadId | undefined {
  return value ? (value as ThreadId) : undefined;
}

function requireTaskControl(options: RuntimeHttpHandlerOptions): RuntimeTaskControlService {
  if (!options.tasks) throw { status: 501, message: "No task control service is configured" } satisfies HttpError;
  return options.tasks;
}

function requireAgentTree(options: RuntimeHttpHandlerOptions): RuntimeAgentTreeService {
  if (!options.agents) throw { status: 501, message: "No agent tree service is configured" } satisfies HttpError;
  return options.agents;
}

function agentTreeQueryFromUrl(url: URL): AgentTreeSnapshotQuery {
  const query: AgentTreeSnapshotQuery = {};
  const rootPath = url.searchParams.get("rootPath");
  const sessionId = asSessionId(url.searchParams.get("sessionId"));
  const includeConsumedMailbox = booleanParam(url.searchParams.get("includeConsumedMailbox"));
  const limit = numberParam(url.searchParams.get("limit"));
  if (rootPath) query.rootPath = rootPath as AgentPath;
  if (sessionId) query.sessionId = sessionId;
  if (includeConsumedMailbox !== undefined) query.includeConsumedMailbox = includeConsumedMailbox;
  if (limit !== undefined) query.limit = limit;
  return query;
}

function agentRunQueryFromUrl(url: URL): AgentRunQuery {
  const query: AgentRunQuery = {};
  const sessionId = asSessionId(url.searchParams.get("sessionId"));
  const childSessionId = asSessionId(url.searchParams.get("childSessionId"));
  const path = url.searchParams.get("path");
  const status = url.searchParams.get("status");
  const limit = numberParam(url.searchParams.get("limit"));
  if (sessionId) query.sessionId = sessionId;
  if (childSessionId) query.childSessionId = childSessionId;
  if (path) query.path = path as AgentPath;
  if (status === "running" || status === "completed" || status === "failed" || status === "cancelled") {
    query.status = status;
  }
  if (limit !== undefined) query.limit = limit;
  return query;
}

function mailboxQueryFromUrl(url: URL): AgentMailboxQuery {
  const query: AgentMailboxQuery = {};
  const messageId = url.searchParams.get("messageId");
  const status = url.searchParams.get("status");
  const path = url.searchParams.get("path");
  const childSessionId = asSessionId(url.searchParams.get("childSessionId"));
  const limit = numberParam(url.searchParams.get("limit"));
  if (messageId) query.messageId = messageId;
  if (status === "queued" || status === "consumed") query.status = status;
  if (path) query.path = path as AgentPath;
  if (childSessionId) query.childSessionId = childSessionId;
  if (limit !== undefined) query.limit = limit;
  return query;
}

function taskQueryFromUrl(url: URL): AgentTaskQuery {
  const query: AgentTaskQuery = {};
  const status = taskStatus(url.searchParams.get("status"));
  const parentSessionId = asSessionId(url.searchParams.get("parentSessionId"));
  const childSessionId = asSessionId(url.searchParams.get("childSessionId"));
  const limit = numberParam(url.searchParams.get("limit"));
  if (status) query.status = status;
  if (parentSessionId) query.parentSessionId = parentSessionId;
  if (childSessionId) query.childSessionId = childSessionId;
  if (limit !== undefined) query.limit = limit;
  return query;
}

function taskStatus(value: string | null): AgentTaskStatus | undefined {
  if (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return undefined;
}

function closeStatus(value: unknown): AgentTaskFinalStatus {
  if (value === undefined) return "cancelled";
  if (value === "completed" || value === "failed" || value === "cancelled") return value;
  throw badRequest("status must be completed, failed, or cancelled");
}

function numberParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function booleanParam(value: string | null): boolean | undefined {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}
