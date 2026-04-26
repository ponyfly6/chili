import type {
  ChiliEvent,
  Message,
  ApprovalId,
  RuntimeApprovalResolveResult,
  RuntimeInterruptResult,
  RuntimePromptAccepted,
  RuntimePromptResult,
  RuntimeSessionRef,
  SessionId,
  ThreadId,
} from "@chili/protocol";
import type { RuntimeAgentsSnapshot } from "./projection.js";

export interface RuntimeClient {
  createSession(input?: CreateSessionRequest): Promise<RuntimeSessionRef>;
  submitPrompt(input: SubmitPromptRequest): Promise<RuntimePromptResult>;
  submitPromptAsync(input: SubmitPromptRequest): Promise<RuntimePromptAccepted>;
  interruptSession(input: InterruptSessionRequest): Promise<RuntimeInterruptResult>;
  resolveApproval(input: ResolveApprovalRequest): Promise<RuntimeApprovalResolveResult>;
  archiveSession(sessionId: SessionId): Promise<void>;
  listSessions(): Promise<RuntimeSessionSummary[]>;
  listAgents(input?: ListAgentsRequest): Promise<RuntimeAgentsSnapshot>;
  messages(sessionId: SessionId): Promise<Message[]>;
  streamEvents(input?: StreamEventsRequest): AsyncIterable<ChiliEvent>;
}

export interface CreateSessionRequest {
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd?: string;
}

export interface SubmitPromptRequest {
  sessionId: SessionId;
  threadId: ThreadId;
  text: string;
  cwd?: string;
  maxTurns?: number;
  system?: string[];
}

export interface InterruptSessionRequest {
  sessionId: SessionId;
  reason?: string;
}

export interface ResolveApprovalRequest {
  approvalId: ApprovalId;
  decision: "allow_once" | "allow_always" | "deny";
  feedback?: string;
}

export interface RuntimeSessionSummary {
  id: SessionId;
  cwd: string;
  title?: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
}

export interface ListAgentsRequest {
  sessionId?: SessionId;
}

export interface StreamEventsRequest {
  sessionId?: SessionId;
  threadId?: ThreadId;
  afterEventId?: string;
  signal?: AbortSignal;
}

export interface HttpRuntimeClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export class HttpRuntimeClient implements RuntimeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: URL;

  constructor(options: HttpRuntimeClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  }

  createSession(input: CreateSessionRequest = {}): Promise<RuntimeSessionRef> {
    return this.post("sessions", input);
  }

  submitPrompt(input: SubmitPromptRequest): Promise<RuntimePromptResult> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/prompt`, input);
  }

  submitPromptAsync(input: SubmitPromptRequest): Promise<RuntimePromptAccepted> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/prompt_async`, input);
  }

  interruptSession(input: InterruptSessionRequest): Promise<RuntimeInterruptResult> {
    return this.post(`sessions/${encodeURIComponent(input.sessionId)}/interrupt`, { reason: input.reason });
  }

  resolveApproval(input: ResolveApprovalRequest): Promise<RuntimeApprovalResolveResult> {
    return this.post(`approvals/${encodeURIComponent(input.approvalId)}/resolve`, {
      decision: input.decision,
      feedback: input.feedback,
    });
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.post(`sessions/${encodeURIComponent(sessionId)}/archive`, {});
  }

  listSessions(): Promise<RuntimeSessionSummary[]> {
    return this.get("sessions");
  }

  listAgents(input: ListAgentsRequest = {}): Promise<RuntimeAgentsSnapshot> {
    if (input.sessionId) return this.get(`sessions/${encodeURIComponent(input.sessionId)}/agents`);
    return this.get("agents");
  }

  messages(sessionId: SessionId): Promise<Message[]> {
    return this.get(`sessions/${encodeURIComponent(sessionId)}/messages`);
  }

  async *streamEvents(input: StreamEventsRequest = {}): AsyncIterable<ChiliEvent> {
    const url = this.url("events");
    if (input.sessionId) url.searchParams.set("sessionId", input.sessionId);
    if (input.threadId) url.searchParams.set("threadId", input.threadId);
    if (input.afterEventId) url.searchParams.set("afterEventId", input.afterEventId);

    const init: RequestInit = {
      headers: { accept: "text/event-stream" },
    };
    if (input.signal) init.signal = input.signal;
    const response = await this.fetchImpl(url, init);
    if (!response.ok || !response.body) {
      throw await responseError(response);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseFrame(frame);
          if (event) yield event;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.request(path, { method: "GET" });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(this.url(path), init);
    if (!response.ok) throw await responseError(response);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private url(path: string): URL {
    return new URL(path.replace(/^\/+/, ""), this.baseUrl);
  }
}

function parseSseFrame(frame: string): ChiliEvent | undefined {
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (data.length === 0) return undefined;
  return JSON.parse(data.join("\n")) as ChiliEvent;
}

async function responseError(response: Response): Promise<Error> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { message?: string }; message?: string };
    message = body.error?.message ?? body.message ?? message;
  } catch {
    // Keep the HTTP status fallback.
  }
  return new Error(message);
}
