import { access, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { normalizePersistedError, PERSISTED_ERROR_LIMITS } from "@chili/protocol";
import {
  AgentTaskControlService,
  LocalSubagentConcurrencyLimiter,
  RuntimeSessionAlreadyExistsError,
  RuntimeSessionCreationConflictError,
  RuntimeSessionInactiveError,
  RuntimeSessionNotFoundError,
  RuntimeSubagentSessionAccessError,
  TeamControlService,
  type AgentTreeSnapshot,
  type AgentTaskPromptRuntime,
  type RuntimeSessionOperation,
  type SubmitPromptInput,
} from "@chili/core";
import type {
  ApprovalRow,
  AgentMailboxQuery,
  AgentRunQuery,
  AgentTaskRow,
  AgentMailboxRow,
  AgentRunRow,
  EventPublisher,
  EventQuery,
  EventStore,
  SessionRow,
  TeamTaskRow,
} from "@chili/store";
import { ObservableEventStore, SqliteEventStore, UnknownEventCursorError } from "@chili/store";
import { HttpRuntimeClient, type RuntimeSessionEventWindow } from "@chili/sdk";
import type {
  AgentPath,
  AgentRunId,
  ApprovalDecisionAction,
  ChiliEvent,
  DelegationPolicy,
  DelegationPolicySource,
  EventEnvelope,
  Message,
  ModelSelection,
  PendingUserInputRequest,
  ReasoningLevel,
  RuntimeModelConfig,
  RuntimeDelegationConfig,
  RuntimeModelDescriptor,
  RuntimePermissionConfig,
  RuntimePermissionProfileId,
  RuntimeCommandCatalog,
  RuntimeCommandInvocation,
  RuntimeSessionRef,
  ServiceTier,
  SessionId,
  TaskId,
  TeamId,
  SessionGoal,
  SessionGoalStatus,
  TimestampMs,
  ToolCallId,
  TurnId,
  UserInputAnswers,
  UserInputId,
} from "@chili/protocol";
import { projectRuntimeAgents, type RuntimeAgentsSnapshot } from "./agent-projection.js";
import type {
  RuntimeAgentTreeService,
  RuntimeHttpService,
  RuntimeMcpControlService,
  RuntimeMcpScopeInput,
  RuntimeTaskControlService,
  RuntimeTeamService,
  RuntimeTeamDispatcherService,
  RuntimeTeamExecutionRunnerService,
  RuntimeTeamMergeService,
} from "./runtime-http.js";
import type { PromptCommandControl, PromptCommandRunResult } from "./commands.js";
import { PromptCommandNotFoundError, PromptCommandUsageError } from "./commands.js";
import {
  assertRuntimeHttpServerAuthentication,
  createRuntimeHttpHandler,
  isLoopbackBindHostname,
  startRuntimeHttpServer,
} from "./runtime-http.js";

test("classifies only explicit loopback bind hosts as local", () => {
  for (const hostname of ["127.0.0.1", "127.255.12.9", "localhost", "api.localhost", "::1", "[::1]"]) {
    expect(isLoopbackBindHostname(hostname)).toBe(true);
  }
  for (const hostname of ["", "0.0.0.0", "::", "[::]", "192.168.1.20", "example.test", "127.0.0.1.example.test", "2130706433"]) {
    expect(isLoopbackBindHostname(hostname)).toBe(false);
  }
});

test("requires at least 32 UTF-8 token bytes before any non-loopback bind", () => {
  const tls = { cert: "test certificate", key: "test private key" } satisfies Bun.TLSOptions;
  for (const hostname of ["0.0.0.0", "::", "192.168.1.20", "example.test", ""]) {
    expect(() => assertRuntimeHttpServerAuthentication(hostname, "x".repeat(31))).toThrow(
      "without an authToken of at least 32 UTF-8 bytes",
    );
    expect(() => assertRuntimeHttpServerAuthentication(hostname, "é".repeat(15))).toThrow(
      "without an authToken of at least 32 UTF-8 bytes",
    );
    expect(() => assertRuntimeHttpServerAuthentication(hostname, "x".repeat(32), tls)).not.toThrow();
    expect(() => assertRuntimeHttpServerAuthentication(hostname, "é".repeat(16), tls)).not.toThrow();
  }
  expect(() => assertRuntimeHttpServerAuthentication(undefined, undefined)).not.toThrow();
});

test("requires explicit nonempty TLS cert and key for authenticated non-loopback binds", () => {
  const token = "x".repeat(32);
  const invalidTlsOptions: unknown[] = [
    undefined,
    {},
    { cert: "certificate" },
    { key: "private key" },
    { cert: "", key: "private key" },
    { cert: "certificate", key: " \t\n" },
    { cert: [], key: "private key" },
    { cert: "certificate", key: [] },
    { cert: [["certificate"]], key: "private key" },
    { cert: new Uint8Array(), key: new Uint8Array([1]) },
    [],
    [
      { cert: "certificate", key: "private key" },
      { cert: "", key: "private key" },
    ],
  ];

  for (const tls of invalidTlsOptions) {
    expect(() => assertRuntimeHttpServerAuthentication(
      "0.0.0.0",
      token,
      tls as Bun.TLSOptions | Bun.TLSOptions[] | undefined,
    )).toThrow('non-loopback host "0.0.0.0" without explicit TLS cert and key');
  }

  const validTlsOptions: Array<Bun.TLSOptions | Bun.TLSOptions[]> = [
    { cert: "certificate", key: "private key" },
    { cert: ["certificate", new Uint8Array([1])], key: [new Uint8Array([1])] },
    [
      { cert: "first certificate", key: "first private key" },
      { cert: new Uint8Array([1]), key: new Uint8Array([2]) },
    ],
  ];
  for (const tls of validTlsOptions) {
    expect(() => assertRuntimeHttpServerAuthentication("0.0.0.0", token, tls)).not.toThrow();
  }

  for (const hostname of ["127.0.0.1", "localhost", "::1"]) {
    expect(() => assertRuntimeHttpServerAuthentication(hostname, undefined, undefined)).not.toThrow();
  }
});

test("keeps safe bind hosts in diagnostics but never reflects hostile host input", () => {
  for (const hostname of ["0.0.0.0", "192.168.1.20", "example.test", "::", "[::]"]) {
    expect(() => assertRuntimeHttpServerAuthentication(hostname, undefined)).toThrow(
      `non-loopback host ${JSON.stringify(hostname)}`,
    );
  }

  const hostileHostnames = [
    "operator:hostname-secret@example.test",
    "https://operator:hostname-secret@example.test",
    "0.0.0.0\nhostname-secret",
    "example.test/path?token=hostname-secret",
    `example.test-${"hostname-secret".repeat(30)}`,
  ];
  for (const hostname of hostileHostnames) {
    let message = "";
    try {
      assertRuntimeHttpServerAuthentication(hostname, undefined);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('non-loopback host "<unsafe-hostname>"');
    expect(message).not.toContain("hostname-secret");
    expect(message).not.toContain("\n");
  }
});

test("passes validated TLS configuration through to Bun.serve", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const tls: Bun.TLSOptions[] = [
    { cert: "first certificate", key: "first private key" },
    { cert: "second certificate", key: "second private key" },
  ];
  const mutableBun = Bun as unknown as { serve: typeof Bun.serve };
  const originalServe = mutableBun.serve;
  let capturedOptions: unknown;
  let stopped = false;
  mutableBun.serve = ((options: unknown) => {
    capturedOptions = options;
    return {
      url: new URL("https://0.0.0.0:4443/"),
      stop(closeActiveConnections?: boolean) {
        expect(closeActiveConnections).toBe(true);
        stopped = true;
      },
    } as unknown as ReturnType<typeof Bun.serve>;
  }) as typeof Bun.serve;

  try {
    const server = startRuntimeHttpServer({
      service: new FakeRuntimeService(store),
      store,
      hostname: "0.0.0.0",
      authToken: "x".repeat(32),
      tls,
    });
    expect((capturedOptions as { tls?: unknown }).tls).toBe(tls);
    expect(server.url).toBe("https://0.0.0.0:4443/");
    const transportFetch = (capturedOptions as {
      fetch: (request: Request, listener: { port: number }) => Response | Promise<Response>;
    }).fetch;
    const publicHostResponse = await transportFetch(new Request("https://control.private.example:4443/health", {
      headers: {
        authorization: `Bearer ${"x".repeat(32)}`,
        host: "control.private.example:4443",
      },
    }), { port: 4443 });
    expect(publicHostResponse.status).toBe(200);
    expect(await publicHostResponse.json()).toEqual({ ok: true });
    await server.close();
    expect(stopped).toBe(true);
  } finally {
    mutableBun.serve = originalServe;
  }
});

test("loopback server accepts explicit loopback Host authorities on its listener port", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const server = startRuntimeHttpServer({
    service: new FakeRuntimeService(store),
    store,
    hostname: "127.0.0.1",
  });

  try {
    const port = new URL(server.url).port;
    expect(port).not.toBe("");
    const trustedHosts = [
      `127.0.0.1:${port}`,
      `127.255.12.9:${port}`,
      `localhost:${port}`,
      `LOCALHOST:${port}`,
      `api.localhost:${port}`,
      `[::1]:${port}`,
      `[0:0:0:0:0:0:0:1]:${port}`,
    ];

    const observed: Array<{ host: string; status: number }> = [];
    for (const host of trustedHosts) {
      const response = await fetch(new URL("health", server.url), { headers: { host } });
      observed.push({ host, status: response.status });
      expect(await response.json()).toEqual({ ok: true });
    }
    expect(observed).toEqual(trustedHosts.map((host) => ({ host, status: 200 })));
  } finally {
    await server.close();
  }
});

test("loopback server rejects DNS rebinding and deceptive numeric Host authorities", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const server = startRuntimeHttpServer({
    service: new FakeRuntimeService(store),
    store,
    hostname: "127.0.0.1",
  });

  try {
    const port = new URL(server.url).port;
    const hostileHosts = [
      `HOST_REBIND_CANARY.example:${port}`,
      `127.0.0.1.HOST_REBIND_CANARY.example:${port}`,
      `192.168.1.20:${port}`,
      `0.0.0.0:${port}`,
      `[::]:${port}`,
      `2130706433:${port}`,
      `0x7f000001:${port}`,
      `0177.0.0.1:${port}`,
      `127.1:${port}`,
      `127.000.000.001:${port}`,
      `127.0.0.01:${port}`,
      `127.0.0.1.:${port}`,
      `[::ffff:127.0.0.1]:${port}`,
    ];

    const observed: Array<{ body: unknown; host: string; status: number; text: string }> = [];
    for (const host of hostileHosts) {
      const response = await fetch(new URL("health", server.url), { headers: { host } });
      const text = await response.text();
      observed.push({
        body: JSON.parse(text) as unknown,
        host,
        status: response.status,
        text,
      });
    }

    expect(observed.map(({ body, host, status }) => ({ body, host, status }))).toEqual(
      hostileHosts.map((host) => ({
        body: { error: { message: "Misdirected request" } },
        host,
        status: 421,
      })),
    );
    for (const result of observed) expect(result.text).not.toContain("HOST_REBIND_CANARY");
  } finally {
    await server.close();
  }
});

test("loopback server rejects an untrusted Host before reading session state", async () => {
  const innerStore = new MemoryEventStore();
  const originalSessions = innerStore.sessions.bind(innerStore);
  let sessionsCalls = 0;
  innerStore.sessions = async () => {
    sessionsCalls += 1;
    return originalSessions();
  };
  const store = new ObservableEventStore(innerStore);
  const server = startRuntimeHttpServer({
    service: new FakeRuntimeService(store),
    store,
    hostname: "127.0.0.1",
  });

  try {
    const port = new URL(server.url).port;
    const response = await fetch(new URL("sessions", server.url), {
      headers: { host: `HOST_STATE_CANARY.example:${port}` },
    });
    const text = await response.text();

    expect(response.status).toBe(421);
    expect(JSON.parse(text)).toEqual({ error: { message: "Misdirected request" } });
    expect(text).not.toContain("HOST_STATE_CANARY");
    expect(sessionsCalls).toBe(0);
  } finally {
    await server.close();
  }
});

test("loopback server rejects an untrusted Host before an unsafe mutation", async () => {
  const innerStore = new MemoryEventStore();
  const store = new ObservableEventStore(innerStore);
  const service = new FakeRuntimeService(store);
  const session = await service.createSession({ sessionId: "session_host_mutation" as SessionId, cwd: "/repo" });
  const originalArchiveSession = service.archiveSession.bind(service);
  let archiveCalls = 0;
  service.archiveSession = async (sessionId) => {
    archiveCalls += 1;
    await originalArchiveSession(sessionId);
  };
  const server = startRuntimeHttpServer({ service, store, hostname: "127.0.0.1" });

  try {
    const port = new URL(server.url).port;
    const response = await fetch(new URL(`sessions/${session.sessionId}/archive`, server.url), {
      method: "POST",
      headers: { host: `HOST_MUTATION_CANARY.example:${port}` },
    });
    const text = await response.text();
    const persisted = (await store.sessions()).find((candidate) => candidate.id === session.sessionId);

    expect({
      archiveCalls,
      body: text.length > 0 ? JSON.parse(text) as unknown : undefined,
      sessionStatus: persisted?.status,
      status: response.status,
    }).toEqual({
      archiveCalls: 0,
      body: { error: { message: "Misdirected request" } },
      sessionStatus: "active",
      status: 421,
    });
    expect(text).not.toContain("HOST_MUTATION_CANARY");
  } finally {
    await server.close();
  }
});

test("loopback server rejects omitted, mismatched, and malformed Host ports", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const server = startRuntimeHttpServer({
    service: new FakeRuntimeService(store),
    store,
    hostname: "127.0.0.1",
  });

  try {
    const port = Number(new URL(server.url).port);
    expect(port).toBeGreaterThan(0);
    const mismatchedHosts = [
      "127.0.0.1",
      `127.0.0.1:${port + 1}`,
      "[::1]",
      `[::1]:${port + 1}`,
      `localhost:${port}:80`,
      `::1:${port}`,
      "localhost:http",
      `localhost:+${port}`,
      `user:HOST_PORT_CANARY@localhost:${port}`,
      `localhost:${port}/HOST_PORT_CANARY`,
      `localhost:${port}?host=HOST_PORT_CANARY`,
      `localhost:${port}#HOST_PORT_CANARY`,
      `localhost:${port}, HOST_PORT_CANARY.example:${port}`,
    ];

    const observed: Array<{ body: unknown; host: string; status: number }> = [];
    for (const host of mismatchedHosts) {
      const response = await fetch(new URL("health", server.url), { headers: { host } });
      observed.push({
        body: await response.json() as unknown,
        host,
        status: response.status,
      });
    }

    expect(observed).toEqual(mismatchedHosts.map((host) => ({
      body: { error: { message: "Misdirected request" } },
      host,
      status: 421,
    })));
  } finally {
    await server.close();
  }
});

test("start rejects an unauthenticated wildcard before opening a Bun server", () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  expect(() => startRuntimeHttpServer({
    service: new FakeRuntimeService(store),
    store,
    hostname: "0.0.0.0",
  })).toThrow('Refusing to bind runtime HTTP server to non-loopback host "0.0.0.0"');
});

test("rejects every browser-originated mutation, including routes without bodies", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });
  const session = await service.createSession({ cwd: "/repo" });

  const response = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/archive`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
  }));

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { message: "Browser-originated runtime mutations are disabled" } });
  expect((await store.sessions()).find((candidate) => candidate.id === session.sessionId)?.status).toBe("active");
});

test("keeps runtime HTTP routes unauthenticated when no auth token is configured", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });

  const healthResponse = await handler(new Request("http://chili.test/health"));
  const sessionsResponse = await handler(new Request("http://chili.test/sessions"));

  expect(healthResponse.status).toBe(200);
  expect(await healthResponse.json()).toEqual({ ok: true });
  expect(sessionsResponse.status).toBe(200);
});

test("accepts the configured bearer token for the health route", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const handler = createRuntimeHttpHandler({
    service: new FakeRuntimeService(store),
    store,
    authToken: "runtime-secret-token",
  });

  const response = await handler(new Request("http://chili.test/health", {
    headers: { authorization: "Bearer runtime-secret-token" },
  }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test("rejects missing, incorrect, and malformed bearer credentials without leaking the token", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const handler = createRuntimeHttpHandler({
    service: new FakeRuntimeService(store),
    store,
    authToken: "runtime-secret-token",
  });

  for (const authorization of [undefined, "Bearer wrong", "Basic runtime-secret-token", "Bearer"]) {
    const response = await handler(new Request("http://chili.test/health", {
      ...(authorization ? { headers: { authorization } } : {}),
    }));
    const responseText = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(responseText).not.toContain("runtime-secret-token");
    expect(JSON.parse(responseText)).toEqual({ error: { message: "Unauthorized" } });
  }
});

test("protects non-health runtime HTTP routes with the configured bearer token", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const handler = createRuntimeHttpHandler({
    service: new FakeRuntimeService(store),
    store,
    authToken: "runtime-secret-token",
  });

  const unauthorizedResponse = await handler(new Request("http://chili.test/sessions"));
  const authorizedResponse = await handler(new Request("http://chili.test/sessions", {
    headers: { authorization: "Bearer runtime-secret-token" },
  }));

  expect(unauthorizedResponse.status).toBe(401);
  expect(authorizedResponse.status).toBe(200);
});

test("rejects an empty runtime HTTP auth token configuration", () => {
  const store = new ObservableEventStore(new MemoryEventStore());

  for (const authToken of ["", "   ", "token\u0000with-control", "token\u007fwith-delete"]) {
    expect(() => createRuntimeHttpHandler({
      service: new FakeRuntimeService(store),
      store,
      authToken,
    })).toThrow("authToken must be a non-empty string when provided");
  }
});

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

test("SSE serializes a normalized 5 MiB escape-heavy error within a deterministic byte ceiling", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });
  const bearerToken = "sse-secret-token._~+/==";
  const loopbackUrl = "http://localhost:47833/private/sse?token=sse-url-secret";
  const boundarySecrets = [
    "SSE_TAB_LABEL_SECRET",
    "SSE_LF_LABEL_SECRET",
    "SSE_ANSI_LABEL_SECRET",
    "秘密SSE令牌",
    "alpha beta SSE_TAIL_SECRET",
  ];
  const taxonomySecrets = [
    "secret=SSE_BARE_SECRET",
    "private_key=SSE_PRIVATE_KEY",
    "signing_key=SSE_SIGNING_KEY",
    "webhook_secret=SSE_WEBHOOK_SECRET",
    "AWS_SECRET_ACCESS_KEY=SSE_AWS_SECRET",
    "session=SSE_SESSION_SECRET",
    "id_token=SSE_ID_SECRET",
  ];
  const hugeMessage = [
    `SSE failed with Bearer ${bearerToken} at ${loopbackUrl}`,
    ...taxonomySecrets,
    `pass\tword=${boundarySecrets[0]}`,
    `pass\nword=${boundarySecrets[1]}`,
    `pass\u001b[31mword=${boundarySecrets[2]}\u001b[0m`,
    `bEaReR ${boundarySecrets[3]}`,
    `password=${boundarySecrets[4]}`,
    "Bearer x",
  ].join("\n") + "\n"
    + "\u0000".repeat(5 * 1024 * 1024);
  const source = Object.assign(new Error(hugeMessage), {
    name: "EscapedRemoteError",
    code: "E_ESCAPED_REMOTE",
    cause: { secret: "SSE_CAUSE_SECRET_MUST_NOT_LEAK" },
  });
  const normalized = normalizePersistedError(source);
  const event: ChiliEvent = {
    id: "event_sse_bounded_error",
    type: "tool.call_finished",
    time: 1 as TimestampMs,
    sessionId: "session_sse_bounded_error" as SessionId,
    payload: {
      callId: "toolcall_sse_bounded_error" as ToolCallId,
      status: "failed",
      error: normalized.message,
      errorDetails: normalized.persistedErrorDetails,
      synthetic: true,
    },
  };
  await baseStore.append(event);

  const response = await handler(new Request(
    "http://chili.test/events?sessionId=session_sse_bounded_error",
  ));
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("expected event stream body");
  try {
    const chunk = (await reader.read()).value;
    if (!chunk) throw new Error("expected bounded SSE event");
    const frame = new TextDecoder().decode(chunk);
    expect(Buffer.byteLength(normalized.message, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(110_000);
    expect(frame).toContain("event_sse_bounded_error");
    expect(frame).toContain("error message truncated from");
    expect(frame).not.toContain("SSE_CAUSE_SECRET_MUST_NOT_LEAK");
    expect(frame).not.toContain("cause");
    expect(frame).toContain("Bearer [REDACTED]");
    expect(frame).toContain("bEaReR [REDACTED]");
    expect(frame).toContain("[loopback URL redacted]");
    expect(frame).not.toContain("[31m");
    expect(frame).not.toContain("[0m");
    expect(frame).not.toContain(bearerToken);
    expect(frame).not.toContain(loopbackUrl);
    for (const secret of taxonomySecrets) expect(frame).not.toContain(secret.split("=")[1]!);
    for (const secret of boundarySecrets) expect(frame).not.toContain(secret);
  } finally {
    await reader.cancel();
  }
});

test("emits a bounded resync cursor for a legacy event above the 4 MB transport cap", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const sessionId = "session_sse_oversized" as SessionId;
  baseStore.items.push({
    id: "event_sse_oversized",
    type: "session.status_changed",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, status: "failed", reason: "x".repeat(4_100_000) },
  } as ChiliEvent);
  baseStore.items.push({
    id: "event_sse_after_oversized",
    type: "session.renamed",
    time: 2 as TimestampMs,
    sessionId,
    payload: { sessionId, title: "after poison" },
  } as ChiliEvent);
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });
  const response = await handler(new Request(`http://chili.test/events?sessionId=${sessionId}`));
  const reader = response.body?.getReader();
  if (!reader) throw new Error("expected event stream body");
  const chunk = await reader.read();
  const controlFrame = new TextDecoder().decode(chunk.value);
  expect(chunk.done).toBe(false);
  expect(Buffer.byteLength(controlFrame, "utf8")).toBeLessThanOrEqual(4_096);
  expect(controlFrame).toContain("event: chili.resync");
  expect(controlFrame).toContain('"afterEventId":"event_sse_oversized"');
  expect(controlFrame).not.toContain('"reason":"x');
  const resumed = await collectEventStreamText(
    handler,
    `http://chili.test/events?sessionId=${sessionId}&afterEventId=event_sse_oversized`,
  );
  expect(resumed).toContain("event_sse_after_oversized");
  expect(resumed).not.toContain("event_sse_oversized");
});

test("streams and resumes a worst legal tool result that remains replayable beside a near-limit approval window", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const sessionId = "session_sse_legal_tool_result" as SessionId;
  const messageId = "message_sse_legal_tool_result";
  const sessionCreated: ChiliEvent = {
    id: "event_sse_legal_session_created",
    type: "session.created",
    time: 0 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd: "/repo" },
  };
  const created: ChiliEvent = {
    id: "event_sse_legal_message_created",
    type: "message.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { messageId: messageId as never, role: "assistant" },
  };
  const escapedArtifactId = "\\\"".repeat(256);
  const partAdded: ChiliEvent = {
    id: "event_sse_legal_tool_result",
    type: "message.part_added",
    time: 2 as TimestampMs,
    sessionId,
    payload: {
      messageId: messageId as never,
      part: {
        id: "part_sse_legal_tool_result" as never,
        messageId: messageId as never,
        sessionId,
        type: "tool_result",
        callId: "toolcall_sse_legal_tool_result" as ToolCallId,
        output: "\\".repeat(256_000),
        content: [{ type: "text", text: "\u0000".repeat(200_000) }],
        artifactIds: Array.from({ length: 60 }, () => escapedArtifactId as never),
        executionContext: {
          sandbox: "macos-seatbelt",
          executionMode: "sandboxed",
          exitCode: 0,
          timedOut: false,
          aborted: false,
          signal: null,
        },
      },
    },
  };
  const partEventBytes = Buffer.byteLength(JSON.stringify(partAdded), "utf8");
  expect(partEventBytes).toBeGreaterThan(1_700_000);
  expect(partEventBytes).toBeLessThan(2_000_000);
  await store.appendMany([sessionCreated, created, partAdded]);

  const approvalRow = (index: number, metadataChars: number): ApprovalRow => ({
    id: `approval_sse_legal_${String(index).padStart(4, "0")}`,
    sessionId,
    callId: `toolcall_approval_${index}` as ToolCallId,
    permission: "P".repeat(512),
    patterns: ["X".repeat(2_000)],
    maxApprovalScope: "persistent",
    metadata: { note: "M".repeat(metadataChars) },
    status: "pending",
    createdAt: index + 1,
  });
  let approvalBytes = 2;
  for (let index = 0; index < 2_000; index += 1) {
    const row = approvalRow(index, 15_000);
    const extraBytes = Buffer.byteLength(JSON.stringify(row), "utf8")
      + (baseStore.approvalRows.length > 0 ? 1 : 0);
    if (approvalBytes + extraBytes > 998_000) break;
    baseStore.approvalRows.push(row);
    approvalBytes += extraBytes;
  }
  expect(approvalBytes).toBeGreaterThan(980_000);

  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });
  const initialController = new AbortController();
  const initial = await handler(new Request(`http://chili.test/events?sessionId=${sessionId}`, {
    signal: initialController.signal,
  }));
  const initialReader = initial.body?.getReader();
  if (!initialReader) throw new Error("expected event stream body");
  let partFrame = "";
  for (let read = 0; read < 4 && !partFrame.includes(partAdded.id); read += 1) {
    const chunk = await initialReader.read();
    if (chunk.done) break;
    partFrame += new TextDecoder().decode(chunk.value);
  }
  expect(partFrame).toContain(`id: ${partAdded.id}`);
  expect(Buffer.byteLength(partFrame, "utf8")).toBeLessThanOrEqual(4_000_000);
  initialController.abort();
  await initialReader.cancel();

  const replay = await handler(new Request(
    `http://chili.test/sessions/${sessionId}/events?window=replayable`,
  ));
  const replayText = await replay.text();
  const replayWindow = JSON.parse(replayText) as RuntimeSessionEventWindow;
  expect(Buffer.byteLength(replayText, "utf8")).toBeLessThanOrEqual(4_000_000);
  expect(replayWindow.events.map((event) => event.id)).toEqual(expect.arrayContaining([
    created.id,
    partAdded.id,
  ]));
  expect(Buffer.byteLength(JSON.stringify(replayWindow.pendingApprovals), "utf8")).toBeGreaterThan(970_000);

  const resumeController = new AbortController();
  const resumed = await handler(new Request(
    `http://chili.test/events?sessionId=${sessionId}&afterEventId=${partAdded.id}`,
    { signal: resumeController.signal },
  ));
  const resumedReader = resumed.body?.getReader();
  if (!resumedReader) throw new Error("expected resumed event stream body");
  await store.append({
    id: "event_sse_legal_after_cursor",
    type: "session.renamed",
    time: 3 as TimestampMs,
    sessionId,
    payload: { sessionId, title: "cursor advanced" },
  });
  const resumedChunk = await resumedReader.read();
  expect(new TextDecoder().decode(resumedChunk.value)).toContain("event_sse_legal_after_cursor");
  resumeController.abort();
  await resumedReader.cancel();
});

test("bounds and redacts hostile HTTP errors and successful finish diagnostics", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const session = await service.createSession({ sessionId: "session_http_hostile" as SessionId, cwd: "/repo" });
  const rawSecret = "HTTP_SECRET_MUST_NOT_LEAK";
  const hostile = `password=${rawSecret} http://localhost:43123/private?token=${rawSecret}\n${"\u0000".repeat(5 * 1024 * 1024)}`;
  service.submitPrompt = async () => {
    const error = new Error(hostile);
    error.name = "RuntimeBusyError";
    throw error;
  };
  const handler = createRuntimeHttpHandler({ service, store });
  const failed = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "fail safely" }),
  }));
  const failedBody = await failed.text();
  expect(failed.status).toBe(409);
  expect(Buffer.byteLength(failedBody, "utf8")).toBeLessThan(20_000);
  expect(failedBody).toContain("error message truncated from");
  expect(failedBody).toContain("[REDACTED]");
  expect(failedBody).not.toContain(rawSecret);
  expect(failedBody).not.toContain("localhost:43123");

  service.submitPrompt = async () => ({
    status: "completed",
    turns: [],
    finishReason: hostile,
  });
  const completed = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "finish safely" }),
  }));
  const completedBody = await completed.text();
  expect(completed.status).toBe(200);
  expect(Buffer.byteLength(completedBody, "utf8")).toBeLessThan(20_000);
  expect(completedBody).toContain("error message truncated from");
  expect(completedBody).not.toContain(rawSecret);
  expect(completedBody).not.toContain("localhost:43123");
});

test("applies the central credential taxonomy idempotently to Error and HttpError responses", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const session = await service.createSession({ sessionId: "session_http_taxonomy" as SessionId, cwd: "/repo" });
  const handler = createRuntimeHttpHandler({ service, store });
  const labels = [
    "secret",
    "private_key",
    "signing_key",
    "webhook_secret",
    "AWS_SECRET_ACCESS_KEY",
    "session",
    "id_token",
  ];
  for (const [index, label] of labels.entries()) {
    const rawSecret = `短密钥_${index}_MUST_NOT_LEAK`;
    service.submitPrompt = async () => {
      const error = new Error(`${label}=${rawSecret}`);
      error.name = "RuntimeBusyError";
      throw error;
    };
    const first = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "normalize taxonomy" }),
    }));
    const firstBody = await first.json() as { error: { message: string } };
    expect(first.status).toBe(409);
    expect(firstBody.error.message).toContain("[REDACTED]");
    expect(firstBody.error.message).not.toContain(rawSecret);
    const normalizedAgain = normalizePersistedError(new Error(firstBody.error.message)).message;
    expect(normalizedAgain).toBe(firstBody.error.message);
  }

  service.submitPrompt = async () => {
    throw { status: 429, message: "webhook_secret=HTTP_ERROR_BYPASS_SECRET" };
  };
  const explicit = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "normalize explicit error" }),
  }));
  const explicitBody = await explicit.text();
  expect(explicit.status).toBe(429);
  expect(explicitBody).toContain("[REDACTED]");
  expect(explicitBody).not.toContain("HTTP_ERROR_BYPASS_SECRET");

  service.submitPrompt = async () => {
    const error = new Error("会话暂不可用");
    error.name = "RuntimeBusyError";
    throw error;
  };
  const unicode = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "preserve unicode" }),
  }));
  expect(await unicode.json()).toEqual({ error: { message: "会话暂不可用" } });
});

test("normalizes hostile service, goal, task, and recovery errors at the HTTP boundary", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const sessionId = "session_http_error_boundaries" as SessionId;
  await service.createSession({ sessionId, cwd: "/repo" });
  const secret = "BOUNDARY_SECRET_MUST_NOT_LEAK";
  const hostileError = (name: string): Error => {
    const error = new Error(`authorization: Bearer ${secret}\n${"\u0000".repeat(5 * 1024 * 1024)}`);
    error.name = name;
    return error;
  };
  service.getGoal = async () => { throw hostileError("GoalNotFoundError"); };
  const tasks = {
    getTask: async () => { throw hostileError("AgentTaskNotFoundError"); },
    reconcileStaleTasks: async () => { throw hostileError("AgentTaskControlServiceClosedError"); },
  } as unknown as RuntimeTaskControlService;
  const handler = createRuntimeHttpHandler({ service, store, tasks });
  const requests = [
    handler(new Request(`http://chili.test/sessions/${sessionId}/goal`)),
    handler(new Request("http://chili.test/tasks/task_hostile")),
    handler(new Request("http://chili.test/tasks/reconcile_stale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })),
  ];
  for (const response of await Promise.all(requests)) {
    const body = await response.text();
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(20_000);
    expect(body).toContain("[REDACTED]");
    expect(body).toContain("error message truncated from");
    expect(body).not.toContain(secret);
  }
});

test("returns 409 when an explicit session id is created more than once", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });
  const sessionId = "session_http_duplicate" as SessionId;

  const first = await handler(new Request("http://chili.test/sessions", {
    method: "POST",
    body: JSON.stringify({ sessionId, cwd: "/authoritative/repo" }),
    headers: { "content-type": "application/json" },
  }));
  const duplicate = await handler(new Request("http://chili.test/sessions", {
    method: "POST",
    body: JSON.stringify({ sessionId, cwd: "/attacker/repo" }),
    headers: { "content-type": "application/json" },
  }));

  expect(first.status).toBe(201);
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toEqual({
    error: { message: `Session already exists: ${sessionId}` },
  });
  expect((await store.sessions()).find((session) => session.id === sessionId)?.cwd).toBe(
    "/authoritative/repo",
  );
});

test("returns 503 when runtime admission closes during an HTTP mutation", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const service = new FakeRuntimeService(store);
  service.createSession = async () => {
    const error = new Error("Runtime service is closing or closed");
    error.name = "RuntimeServiceClosedError";
    throw error;
  };
  const handler = createRuntimeHttpHandler({ service, store });

  const response = await handler(new Request("http://chili.test/sessions", {
    method: "POST",
    body: JSON.stringify({ cwd: "/repo" }),
    headers: { "content-type": "application/json" },
  }));

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: { message: "Runtime service is closing or closed" },
  });
});

test("returns 409 when session creation ownership is lost before the entity exists", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  service.createSession = async (input = {}) => {
    throw new RuntimeSessionCreationConflictError(
      input.sessionId ?? ("session_http_creation_conflict" as SessionId),
    );
  };
  const handler = createRuntimeHttpHandler({ service, store });
  const sessionId = "session_http_creation_conflict" as SessionId;

  const response = await handler(new Request("http://chili.test/sessions", {
    method: "POST",
    body: JSON.stringify({ sessionId, cwd: "/repo" }),
    headers: { "content-type": "application/json" },
  }));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: { message: `Session creation ownership was lost before completion: ${sessionId}` },
  });
  expect(await store.sessions()).toEqual([]);
});

test("validates and normalizes explicit session ids before creating a session", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });

  for (const sessionId of ["", "   ", "session\nembedded", "x".repeat(513), null, 42, {}, []]) {
    const response = await handler(new Request("http://chili.test/sessions", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
      headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(400);
  }
  expect(await store.sessions()).toEqual([]);
  expect(await store.events({ limit: 20 })).toEqual([]);

  const response = await handler(new Request("http://chili.test/sessions", {
    method: "POST",
    body: JSON.stringify({ sessionId: "  session_http_trimmed  ", cwd: "/repo" }),
    headers: { "content-type": "application/json" },
  }));
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ sessionId: "session_http_trimmed" });
  expect((await store.sessions()).map((session) => String(session.id))).toEqual(["session_http_trimmed"]);
});

test("rejects unknown event and goal query parameters", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });
  const session = await service.createSession();

  const eventsResponse = await handler(new Request(
    `http://chili.test/events?sessionId=${session.sessionId}&legacyScope=obsolete`,
  ));
  expect(eventsResponse.status).toBe(400);
  expect(await eventsResponse.json()).toEqual({
    error: { message: "Query parameter \"legacyScope\" is not supported" },
  });

  const emptyScopeResponse = await handler(new Request("http://chili.test/events?sessionId="));
  expect(emptyScopeResponse.status).toBe(400);
  expect(await emptyScopeResponse.json()).toEqual({
    error: { message: "sessionId must not be empty" },
  });

  const goalResponse = await handler(new Request(
    `http://chili.test/sessions/${session.sessionId}/goal?legacyScope=obsolete`,
  ));
  expect(goalResponse.status).toBe(400);
  expect(await goalResponse.json()).toEqual({
    error: { message: "Query parameter \"legacyScope\" is not supported" },
  });
});

test("loads resumable session events and renames a saved session", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });
  const session = await service.createSession({ cwd: "/repo" });

  const eventsResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/events`));
  expect(eventsResponse.status).toBe(200);
  expect((await eventsResponse.json()) as ChiliEvent[]).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "session.created", sessionId: session.sessionId }),
  ]));

  const renameResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "  Saved  \n investigation  " }),
  }));
  expect(renameResponse.status).toBe(200);
  expect(await renameResponse.json()).toMatchObject({
    id: session.sessionId,
    title: "Saved investigation",
  });

  const maximumTitle = "x".repeat(120);
  const maximumResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: maximumTitle }),
  }));
  expect(maximumResponse.status).toBe(200);
  expect(await maximumResponse.json()).toMatchObject({ title: maximumTitle });

  const tooLong = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "x".repeat(121) }),
  }));
  expect(tooLong.status).toBe(400);
  expect(await tooLong.json()).toEqual({
    error: { message: "Session title must be 120 characters or fewer." },
  });

  const empty = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: " \n\t " }),
  }));
  expect(empty.status).toBe(400);
  expect(await empty.json()).toEqual({ error: { message: "Session title cannot be empty." } });
});

test("serves a full-envelope bounded replayable event window and clamps its event limit", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const sessionId = "session_replayable_budget" as SessionId;
  await baseStore.append({
    id: "event_replayable_session",
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd: "/repo" },
  });
  await baseStore.appendMany(Array.from({ length: 6_000 }, (_, index): ChiliEvent => ({
    id: `event_replayable_${index}`,
    type: "session.renamed",
    time: (2 + index) as TimestampMs,
    sessionId,
    payload: { sessionId, title: `title-${index}-${"界".repeat(8)}` },
  })));
  const maxBytes = 100_000;
  const handler = createRuntimeHttpHandler({
    service: new FakeRuntimeService(store),
    store,
    maxSessionEventWindowBytes: maxBytes,
  });

  const response = await handler(new Request(
    `http://chili.test/sessions/${sessionId}/events?window=replayable&limit=999999`,
  ));
  const body = await response.text();
  const window = JSON.parse(body) as RuntimeSessionEventWindow;
  expect(response.status).toBe(200);
  expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(maxBytes);
  expect(window.events.length).toBeLessThanOrEqual(5_000);
  expect(window.bytes).toBe(new TextEncoder().encode(JSON.stringify(window.events)).byteLength);
  expect(window.truncated).toBe(true);
});

test("replayable windows preserve durable rollback order and same-time causal anchors", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const sessionId = "session_replayable_order" as SessionId;
  await baseStore.appendMany([
    {
      id: "event_order_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_time_a",
      type: "session.renamed",
      time: 100 as TimestampMs,
      sessionId,
      payload: { sessionId, title: "A" },
    },
    {
      id: "event_time_b",
      type: "session.renamed",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, title: "B" },
    },
    {
      id: "z-created",
      type: "message.created",
      time: 200 as TimestampMs,
      sessionId,
      payload: { messageId: "message_same_time", role: "assistant" },
    },
    {
      id: "a-part",
      type: "message.part_added",
      time: 200 as TimestampMs,
      sessionId,
      payload: {
        messageId: "message_same_time",
        part: {
          id: "part_same_time",
          messageId: "message_same_time",
          sessionId,
          type: "text",
          text: "visible",
        },
      },
    },
  ] as ChiliEvent[]);
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });
  const response = await handler(new Request(
    `http://chili.test/sessions/${sessionId}/events?window=replayable`,
  ));
  const window = await response.json() as RuntimeSessionEventWindow;
  const ids = window.events.map((event) => event.id);
  expect(ids.indexOf("event_time_a")).toBeLessThan(ids.indexOf("event_time_b"));
  expect(ids.indexOf("z-created")).toBeLessThan(ids.indexOf("a-part"));
});

test("authoritative pending approvals survive when their event anchors predate scan limits", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const sessionId = "session_replayable_approval" as SessionId;
  await baseStore.appendMany([
    {
      id: "event_approval_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_approval_tool",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_approval", callId: "call_approval", toolName: "bash", input: {} },
    },
    {
      id: "event_approval_request",
      type: "approval.requested",
      time: 3 as TimestampMs,
      sessionId,
      payload: {
        approvalId: "approval_authoritative",
        callId: "call_approval",
        permission: "tool.bash",
        patterns: ["bun test"],
      },
    },
    ...Array.from({ length: 40 }, (_, index): ChiliEvent => ({
      id: `event_approval_flood_${index}`,
      type: "session.renamed",
      time: (4 + index) as TimestampMs,
      sessionId,
      payload: { sessionId, title: `flood-${index}` },
    })),
  ] as ChiliEvent[]);
  baseStore.approvalRows.push(
    {
      id: "__proto__",
      sessionId,
      callId: "call_invalid",
      permission: "tool.bash",
      patterns: ["unsafe"],
      status: "pending",
      createdAt: 2,
    },
    {
      id: "approval_authoritative",
      sessionId,
      callId: "call_approval",
      permission: "tool.bash",
      patterns: ["bun test"],
      maxApprovalScope: "session",
      status: "pending",
      createdAt: 3,
    },
  );
  const handler = createRuntimeHttpHandler({
    service: new FakeRuntimeService(store),
    store,
    maxSessionEventScanPages: 1,
    maxSessionEventScanEvents: 1,
  });
  const response = await handler(new Request(
    `http://chili.test/sessions/${sessionId}/events?window=replayable&limit=4`,
  ));
  const window = await response.json() as RuntimeSessionEventWindow;
  expect(window.pendingApprovals).toEqual([expect.objectContaining({
    id: "approval_authoritative",
    callId: "call_approval",
  })]);
  expect(window.events.some((event) => event.type === "approval.requested")).toBe(false);
  expect(window.truncated).toBe(true);
  expect(window.warning).toContain("anchors could not be recovered");
  expect(window.warning).toContain("pending approvals exceeded");
});

test("replayable windows pin an active tool with its recovered start across an unrelated flood", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const sessionId = "session_replayable_active_tool" as SessionId;
  await baseStore.appendMany([
    {
      id: "event_active_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_active_tool_start",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_active", callId: "call_active", toolName: "bash", input: {} },
    },
    ...Array.from({ length: 100 }, (_, index): ChiliEvent => ({
      id: `event_active_flood_${index}`,
      type: "session.renamed",
      time: (3 + index) as TimestampMs,
      sessionId,
      payload: { sessionId, title: `child-flood-${index}` },
    })),
    {
      id: "event_active_tool_tail",
      type: "tool.output_delta",
      time: 104 as TimestampMs,
      sessionId,
      payload: { callId: "call_active", stream: "stdout", delta: "still running", sequence: 1 },
    },
  ] as ChiliEvent[]);
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });
  const response = await handler(new Request(
    `http://chili.test/sessions/${sessionId}/events?window=replayable&limit=10`,
  ));
  const window = await response.json() as RuntimeSessionEventWindow;
  expect(window.events.map((event) => event.id)).toEqual(expect.arrayContaining([
    "event_active_tool_start",
    "event_active_tool_tail",
  ]));
  expect(window.pinnedEventIds).toContain("event_active_tool_tail");
});

test("coalesces 100 identical replay scans and bounds admission for 100 distinct windows", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const stats = { active: 0, peak: 0, calls: 0 };
  const originalEvents = baseStore.events.bind(baseStore);
  baseStore.events = async (query: EventQuery = {}): Promise<EventEnvelope[]> => {
    stats.active += 1;
    stats.peak = Math.max(stats.peak, stats.active);
    stats.calls += 1;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2));
    try {
      return await originalEvents(query);
    } finally {
      stats.active -= 1;
    }
  };
  for (let index = 0; index < 100; index += 1) {
    const sessionId = `session_admission_${index}` as SessionId;
    await baseStore.append({
      id: `event_admission_${index}`,
      type: "session.created",
      time: (index + 1) as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    });
  }
  const handler = createRuntimeHttpHandler({
    service: new FakeRuntimeService(store),
    store,
    maxSessionEventWindowConcurrency: 2,
  });

  const distinct = await Promise.all(Array.from({ length: 100 }, (_, index) => handler(new Request(
    `http://chili.test/sessions/session_admission_${index}/events?window=replayable`,
  ))));
  expect(distinct.some((response) => response.status === 503)).toBe(true);
  expect(distinct.some((response) => response.status === 200)).toBe(true);
  expect(stats.peak).toBeLessThanOrEqual(2);

  stats.calls = 0;
  stats.peak = 0;
  const coalesced = await Promise.all(Array.from({ length: 100 }, () => handler(new Request(
    "http://chili.test/sessions/session_admission_0/events?window=replayable",
  ))));
  expect(coalesced.every((response) => response.status === 200)).toBe(true);
  expect(stats.calls).toBeLessThanOrEqual(3);
  expect(stats.peak).toBe(1);
});

test("event backlog stays bounded and oversized resume cursors require a tail resync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-tail-backlog-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store, maxBacklogEvents: 5 });
  const sessionId = "session_tail_backlog" as SessionId;

  try {
    await store.appendMany([
      {
        id: "event_tail_session",
        type: "session.created",
        time: 1 as TimestampMs,
        sessionId,
        payload: { sessionId, cwd: "/repo" },
      },
      ...Array.from({ length: 5 }, (_, index): ChiliEvent => ({
        id: `event_tail_started_${index}`,
        type: "turn.started",
        time: (2 + index) as TimestampMs,
        sessionId,
        payload: { turnId: `turn_tail_${index}` as TurnId },
      })),
      {
        id: "event_tail_completed",
        type: "turn.completed",
        time: 10 as TimestampMs,
        sessionId,
        payload: { turnId: "turn_tail_final" as TurnId, status: "failed" },
      },
      {
        id: "event_tail_failed_status",
        type: "session.status_changed",
        time: 11 as TimestampMs,
        sessionId,
        payload: {
          sessionId,
          status: "failed",
          turnId: "turn_tail_final" as TurnId,
          reason: "unexpected EOF",
        },
      },
    ]);

    const controller = new AbortController();
    const eventsResponse = await handler(
      new Request(`http://chili.test/events?sessionId=${sessionId}`, {
        signal: controller.signal,
      }),
    );
    expect(eventsResponse.status).toBe(200);
    const reader = eventsResponse.body?.getReader();
    if (!reader) throw new Error("expected event stream body");

    const chunks: string[] = [];
    const decoder = new TextDecoder();
    for (let index = 0; index < 5; index++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(decoder.decode(chunk.value));
    }
    controller.abort();
    reader.releaseLock();

    const text = chunks.join("");
    expect(text).not.toContain("event_tail_session");
    expect(text).toContain("event_tail_failed_status");
    expect(text).toContain("unexpected EOF");

    const oversizedResume = await handler(new Request(
      `http://chili.test/events?sessionId=${sessionId}&afterEventId=event_tail_started_0`,
    ));
    expect(oversizedResume.status).toBe(409);
    expect(await oversizedResume.json()).toMatchObject({
      error: {
        message: "Event backlog exceeds the 5-event replay limit. Reconnect without afterEventId to resync from the latest events.",
      },
    });

    const resumed = await collectEventStreamText(
      handler,
      `http://chili.test/events?sessionId=${sessionId}&afterEventId=event_tail_started_1`,
    );
    expect(resumed).not.toContain("event_tail_session");
    expect(resumed).not.toContain('"id":"event_tail_started_1"');
    expect(resumed).toContain("event_tail_started_4");
    expect(resumed).toContain("event_tail_failed_status");
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSE de-duplicates a committed backlog event whose observable emit arrives late", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_commit_emit_race" as SessionId;
  const event: ChiliEvent = {
    id: "event_sse_commit_emit_race",
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd: "/repo" },
  };
  store.items.push(event);
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });
  const controller = new AbortController();
  const response = await handler(new Request(
    `http://chili.test/events?sessionId=${sessionId}`,
    { signal: controller.signal },
  ));
  const reader = response.body?.getReader();
  if (!reader) throw new Error("expected event stream body");

  const backlog = await reader.read();
  expect(new TextDecoder().decode(backlog.value).match(/event_sse_commit_emit_race/g)).toHaveLength(2);
  // One occurrence is the SSE id field and one is the JSON envelope. A second
  // chunk would prove the delayed observable broadcast duplicated the event.
  store.emit(event);
  const nextRead = reader.read();
  const next = await Promise.race([
    nextRead.then(() => "chunk" as const),
    new Promise<"none">((resolvePromise) => setTimeout(() => resolvePromise("none"), 20)),
  ]);
  expect(next).toBe("none");

  controller.abort();
  await nextRead;
  reader.releaseLock();
});

test("SSE keeps backlog identity after many live events and drops an extremely late emit", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_lifetime_dedupe" as SessionId;
  const committed: ChiliEvent = {
    id: "event_sse_lifetime_committed",
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd: "/repo" },
  };
  store.items.push(committed);
  const handler = createRuntimeHttpHandler({
    service: new FakeRuntimeService(store),
    store,
    maxBacklogEvents: 1,
  });
  const controller = new AbortController();
  const response = await handler(new Request(
    `http://chili.test/events?sessionId=${sessionId}`,
    { signal: controller.signal },
  ));
  const reader = response.body?.getReader();
  if (!reader) throw new Error("expected event stream body");
  await reader.read();

  for (let index = 0; index < 300; index += 1) {
    const event: ChiliEvent = {
      id: `event_sse_live_${index}`,
      type: "session.status_changed",
      time: (index + 2) as TimestampMs,
      sessionId,
      payload: { sessionId, status: "running" },
    };
    store.items.push(event);
    store.emit(event);
  }
  for (let index = 0; index < 300; index += 1) await reader.read();

  store.emit(committed);
  const nextRead = reader.read();
  const next = await Promise.race([
    nextRead.then(() => "chunk" as const),
    new Promise<"none">((resolvePromise) => setTimeout(() => resolvePromise("none"), 20)),
  ]);
  expect(next).toBe("none");

  controller.abort();
  await nextRead;
  reader.releaseLock();
});

test("SSE rotates at a durable cursor and resumes without loss or late-emit duplicates", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_rotation" as SessionId;
  const events = Array.from({ length: 4 }, (_, index): ChiliEvent => ({
    id: `event_sse_rotation_${index + 1}`,
    type: "session.status_changed",
    time: (index + 1) as TimestampMs,
    sessionId,
    payload: { sessionId, status: index % 2 === 0 ? "running" : "idle" },
  }));
  store.items.push(events[0]!);
  const handler = createRuntimeHttpHandler({
    service: new FakeRuntimeService(store),
    store,
    maxEventStreamDurableEvents: 2,
    maxEventStreamAgeMs: 60_000,
  });

  const firstResponse = await handler(new Request(`http://chili.test/events?sessionId=${sessionId}`));
  const firstReader = firstResponse.body?.getReader();
  if (!firstReader) throw new Error("expected first event stream body");
  const firstChunks = [new TextDecoder().decode((await firstReader.read()).value)];
  store.items.push(events[1]!);
  store.emit(events[1]!);
  firstChunks.push(new TextDecoder().decode((await firstReader.read()).value));
  expect((await firstReader.read()).done).toBe(true);
  firstReader.releaseLock();
  expect(sseIds(firstChunks.join(""))).toEqual([
    "event_sse_rotation_1",
    "event_sse_rotation_2",
  ]);

  const secondResponse = await handler(new Request(
    `http://chili.test/events?sessionId=${sessionId}&afterEventId=event_sse_rotation_2`,
  ));
  const secondReader = secondResponse.body?.getReader();
  if (!secondReader) throw new Error("expected resumed event stream body");
  // This arbitrarily late notification predates the durable cursor. It must
  // only trigger a store pump, never be sent directly on the new connection.
  store.emit(events[0]!);
  store.items.push(events[2]!);
  store.emit(events[2]!);
  const secondChunks = [new TextDecoder().decode((await secondReader.read()).value)];
  store.items.push(events[3]!);
  store.emit(events[3]!);
  secondChunks.push(new TextDecoder().decode((await secondReader.read()).value));
  expect((await secondReader.read()).done).toBe(true);
  secondReader.releaseLock();
  expect(sseIds(secondChunks.join(""))).toEqual([
    "event_sse_rotation_3",
    "event_sse_rotation_4",
  ]);
});

test("SSE age rotation closes a stream only after it has a durable cursor", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_age_rotation" as SessionId;
  store.items.push({
    id: "event_sse_age_rotation",
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd: "/repo" },
  });
  const handler = createRuntimeHttpHandler({
    service: new FakeRuntimeService(store),
    store,
    maxEventStreamDurableEvents: 100,
    maxEventStreamAgeMs: 10,
  });
  const response = await handler(new Request(`http://chili.test/events?sessionId=${sessionId}`));
  const reader = response.body?.getReader();
  if (!reader) throw new Error("expected age-limited event stream body");
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("event_sse_age_rotation");
  const completion = await Promise.race([
    reader.read().then((chunk) => chunk.done),
    new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 250)),
  ]);
  expect(completion).toBe(true);
  reader.releaseLock();
});

test("rejects unknown SSE cursors but keeps a known tip cursor live without transient ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-event-cursor-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store, maxBacklogEvents: 5 });
  const sessionId = "session_event_cursor" as SessionId;

  try {
    await store.append({
      id: "event_cursor_tip",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    });

    const unknown = await handler(new Request(
      `http://chili.test/events?sessionId=${sessionId}&afterEventId=event_cursor_missing`,
    ));
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({
      error: { message: expect.stringContaining("Unknown event cursor") },
    });

    const controller = new AbortController();
    const response = await handler(new Request(
      `http://chili.test/events?sessionId=${sessionId}&afterEventId=event_cursor_tip`,
      { signal: controller.signal },
    ));
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("expected event stream body");

    await store.append({
      id: "event_cursor_transient",
      type: "tool.output_delta",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        callId: "toolcall_cursor" as import("@chili/protocol").ToolCallId,
        stream: "stdout",
        delta: "live",
      },
    });
    const transientChunk = await reader.read();
    const transientText = new TextDecoder().decode(transientChunk.value);
    expect(transientText).toContain('"id":"event_cursor_transient"');
    expect(transientText).not.toContain("id: event_cursor_transient");

    await store.append({
      id: "event_cursor_durable",
      type: "turn.started",
      time: 3 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_cursor" as TurnId },
    });
    const durableChunk = await reader.read();
    expect(new TextDecoder().decode(durableChunk.value)).toContain("id: event_cursor_durable");

    controller.abort();
    reader.releaseLock();
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
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
  const localTaskId = "task_local_http" as TaskId;
  const localRunId = "agentrun_local_http" as AgentRunId;
  const localPath = "/root/local_reader" as AgentPath;

  await store.appendMany([
    {
      id: "event_agent_root",
      type: "agent.spawned",
      time: 2 as TimestampMs,
      sessionId: session.sessionId,
      payload: { runId: rootRunId, path: rootPath, taskName: "lead" },
    },
    {
      id: "event_agent_child",
      type: "agent.spawned",
      time: 3 as TimestampMs,
      sessionId: session.sessionId,
      payload: { runId: childRunId, path: childPath, parentPath: rootPath, taskName: "review" },
    },
    {
      id: "event_task_created",
      type: "team.task_created",
      time: 4 as TimestampMs,
      sessionId: session.sessionId,
      payload: { teamId, taskId, ownerPath: childPath },
    },
    {
      id: "event_mailbox",
      type: "agent.message_queued",
      time: 5 as TimestampMs,
      sessionId: session.sessionId,
      payload: {
        path: childPath,
        from: rootPath,
        triggerTurn: true,
        recipientSessionId: "session_mailbox_projection" as SessionId,
      },
    },
    {
      id: "event_task_done",
      type: "team.task_updated",
      time: 6 as TimestampMs,
      sessionId: session.sessionId,
      payload: { teamId, taskId, status: "completed" },
    },
    {
      id: "event_local_task",
      type: "agent.task_created",
      time: 7 as TimestampMs,
      sessionId: session.sessionId,
      payload: {
        taskId: localTaskId,
        path: localPath,
        parentPath: rootPath,
        parentSessionId: session.sessionId,
        childSessionId: "session_child_http" as SessionId,
        taskName: "local reader",
        cwd: "/repo",
        prompt: "read",
      },
    },
    {
      id: "event_local_task_completed",
      type: "agent.task_completed",
      time: 8 as TimestampMs,
      sessionId: session.sessionId,
      payload: {
        taskId: localTaskId,
        path: localPath,
        status: "completed",
        generation: 1,
        summary: "done",
      },
    },
    {
      id: "event_local_agent",
      type: "agent.spawned",
      time: 9 as TimestampMs,
      sessionId: session.sessionId,
      payload: {
        runId: localRunId,
        taskId: localTaskId,
        path: localPath,
        parentPath: rootPath,
        parentSessionId: session.sessionId,
        childSessionId: "session_child_http" as SessionId,
        taskName: "local reader",
        generation: 2,
      },
    },
  ]);

  const response = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/agents`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as RuntimeAgentsSnapshot;

  expect(body.agents.map((agent) => agent.id)).toEqual([rootRunId, childRunId, localRunId]);
  expect(body.agents[0]?.childRunIds).toEqual([childRunId, localRunId]);
  expect(body.agents[1]?.mailboxMessageIds).toEqual(["event_mailbox"]);
  expect(body.tasks[0]?.status).toBe("completed");
  const localTask = body.tasks.find((task) => task.id === localTaskId);
  expect(localTask?.status).toBe("running");
  expect(localTask?.completedAt).toBeUndefined();
  expect(body.mailbox[0]?.triggerTurn).toBe(true);
  expect(body.mailbox[0]?.recipientSessionId).toBe("session_mailbox_projection" as SessionId);
});

test("paginates the full event history for global and session agent projections", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store, maxBacklogEvents: 2 });
  const session = await service.createSession({ cwd: "/repo" });
  const sessionId = session.sessionId;
  const childSessionId = "session_paged_child" as SessionId;
  const taskId = "task_paged_projection" as TaskId;
  const runId = "agentrun_paged_projection" as AgentRunId;
  const path = "/root/paged" as AgentPath;

  await store.appendMany([
    ...Array.from({ length: 5 }, (_, index): ChiliEvent => ({
      id: `event_paged_filler_${index}`,
      type: "session.renamed",
      time: (index + 2) as TimestampMs,
      sessionId,
      payload: { sessionId, title: `filler ${index}` },
    })),
    {
      id: "event_paged_task",
      type: "agent.task_created",
      time: 7 as TimestampMs,
      sessionId,
      payload: {
        taskId,
        path,
        parentPath: "/root" as AgentPath,
        parentSessionId: sessionId,
        childSessionId,
        taskName: "paged projection",
        cwd: "/repo",
        prompt: "finish after the first event page",
      },
    },
    {
      id: "event_paged_spawned",
      type: "agent.spawned",
      time: 8 as TimestampMs,
      sessionId,
      payload: {
        runId,
        taskId,
        path,
        parentPath: "/root" as AgentPath,
        parentSessionId: sessionId,
        childSessionId,
        taskName: "paged projection",
        generation: 1,
      },
    },
    {
      id: "event_paged_task_completed",
      type: "agent.task_completed",
      time: 9 as TimestampMs,
      sessionId,
      payload: { taskId, path, status: "completed", generation: 1, summary: "done" },
    },
    {
      id: "event_paged_completed",
      type: "agent.completed",
      time: 10 as TimestampMs,
      sessionId,
      payload: { runId, taskId, path, status: "completed", generation: 1, summary: "done" },
    },
    {
      id: "event_paged_mailbox",
      type: "agent.message_queued",
      time: 11 as TimestampMs,
      sessionId,
      payload: {
        taskId,
        path,
        from: "/root" as AgentPath,
        triggerTurn: true,
        recipientSessionId: childSessionId,
      },
    },
  ]);

  for (const url of [
    "http://chili.test/agents",
    `http://chili.test/sessions/${sessionId}/agents`,
  ]) {
    const response = await handler(new Request(url));
    expect(response.status).toBe(200);
    const body = (await response.json()) as RuntimeAgentsSnapshot;
    expect(body.agents).toMatchObject([{ id: runId, status: "completed", completedAt: 10 }]);
    expect(body.tasks).toMatchObject([{ id: taskId, status: "completed", completedAt: 9 }]);
    expect(body.mailbox).toMatchObject([{
      id: "event_paged_mailbox",
      recipientSessionId: childSessionId,
      status: "queued",
    }]);
  }
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

  const incompleteListResponse = await handler(new Request("http://chili.test/tasks?status=incomplete"));
  expect(incompleteListResponse.status).toBe(200);
  expect(tasks.lastListStatus).toBe("incomplete");

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
  expect(tasks.lastFollowupSignal).toBeInstanceOf(AbortSignal);

  const legacyFollowupResponse = await handler(
    new Request("http://chili.test/tasks/task_http/followup", {
      method: "POST",
      body: JSON.stringify({ text: "continue", system: ["old"] }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(legacyFollowupResponse.status).toBe(400);
  expect(await legacyFollowupResponse.json()).toMatchObject({
    error: { message: "system is no longer supported in runtime prompt requests" },
  });

  const waitResponse = await handler(
    new Request("http://chili.test/tasks/task_http/wait", {
      method: "POST",
      body: JSON.stringify({ timeoutMs: 10 }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(waitResponse.status).toBe(200);
  expect(await waitResponse.json()).toMatchObject({ id: "task_http" });
  expect(tasks.lastWaitSignal).toBeInstanceOf(AbortSignal);

  const closeResponse = await handler(
    new Request("http://chili.test/tasks/task_http/close", {
      method: "POST",
      body: JSON.stringify({ status: "cancelled", summary: "stopped" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(closeResponse.status).toBe(200);
  expect(await closeResponse.json()).toMatchObject({ id: "task_http", status: "cancelled", summary: "stopped" });

  const incompleteCloseResponse = await handler(
    new Request("http://chili.test/tasks/task_http/close", {
      method: "POST",
      body: JSON.stringify({ status: "incomplete", summary: "planning_only" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(incompleteCloseResponse.status).toBe(200);
  expect(await incompleteCloseResponse.json()).toMatchObject({
    id: "task_http",
    status: "incomplete",
    summary: "planning_only",
  });

  const reconcileResponse = await handler(
    new Request("http://chili.test/tasks/reconcile_stale", {
      method: "POST",
      body: JSON.stringify({
        parentSessionId: "  session_task_owner  ",
        staleAfterMs: 0,
        modes: ["background"],
        limit: 25,
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(reconcileResponse.status).toBe(200);
  expect(await reconcileResponse.json()).toMatchObject({
    scanned: 1,
    closed: [{ id: "task_http", status: "cancelled" }],
  });
  expect(tasks.lastReconcile).toMatchObject({
    parentSessionId: "session_task_owner",
    staleAfterMs: 0,
    modes: ["background"],
    limit: 25,
    requireLeaseEvidence: true,
  });
});

test("task follow-up HTTP requests propagate client abort to the task controller", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const tasks = new AbortableFollowupTaskControlService();
  const handler = createRuntimeHttpHandler({ service, store, tasks });
  const controller = new AbortController();

  const responsePromise = handler(new Request("http://chili.test/tasks/task_http/followup", {
    method: "POST",
    body: JSON.stringify({ text: "wait for capacity" }),
    headers: { "content-type": "application/json" },
    signal: controller.signal,
  }));
  await tasks.started.promise;

  controller.abort();

  const response = await responsePromise;
  expect(response.status).toBe(499);
  expect(tasks.lastFollowupSignal?.aborted).toBe(true);
  expect(await response.json()).toMatchObject({ error: { message: "Task follow-up aborted" } });
});

test("task close HTTP requests cancel a capacity-queued follow-up without changing the terminal task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-http-close-queued-followup-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const taskId = "task_http_queued" as TaskId;
  const limiter = new LocalSubagentConcurrencyLimiter(1);
  const releaseBlocker = await limiter.acquire();
  const taskRuntime: AgentTaskPromptRuntime = {
    async submitPrompt(): Promise<never> {
      throw new Error("queued follow-up must not reach the runtime");
    },
  };

  try {
    await seedCompletedHttpTask(baseStore, taskId);
    const tasks = new AgentTaskControlService({ store, runtime: taskRuntime, runLimiter: limiter });
    const handler = createRuntimeHttpHandler({ service, store, tasks });
    const followupResponsePromise = handler(new Request(`http://chili.test/tasks/${taskId}/followup`, {
      method: "POST",
      body: JSON.stringify({ text: "wait for capacity" }),
      headers: { "content-type": "application/json" },
    }));
    await waitUntil(() => limiter.snapshot().queuedRuns === 1);

    const closeResponse = await handler(new Request(`http://chili.test/tasks/${taskId}/close`, {
      method: "POST",
      body: JSON.stringify({ status: "cancelled" }),
      headers: { "content-type": "application/json" },
    }));
    const followupResponse = await followupResponsePromise;

    expect(closeResponse.status).toBe(200);
    expect(await closeResponse.json()).toMatchObject({ id: taskId, status: "completed", summary: "initial answer" });
    expect(followupResponse.status).toBe(499);
    expect(await baseStore.events({ type: "agent.spawned", limit: 100 })).toHaveLength(1);
    expect(await baseStore.agentTask(taskId)).toMatchObject({ status: "completed", generation: 1 });
  } finally {
    releaseBlocker();
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("projects incomplete agent tasks and runs as terminal", () => {
  const sessionId = "session_incomplete_projection" as SessionId;
  const taskId = "task_incomplete_projection" as TaskId;
  const runId = "agent_incomplete_projection" as AgentRunId;
  const path = "/root/task_incomplete_projection" as AgentPath;
  const events: ChiliEvent[] = [
    {
      id: "event_incomplete_created",
      type: "agent.task_created",
      time: 1 as TimestampMs,
      sessionId,
      payload: {
        taskId,
        path,
        parentPath: "/root" as AgentPath,
        parentSessionId: sessionId,
        childSessionId: "session_incomplete_child" as SessionId,
        taskName: "Inspect repository",
        cwd: "/repo",
        prompt: "Inspect repository",
      },
    },
    {
      id: "event_incomplete_spawned",
      type: "agent.spawned",
      time: 2 as TimestampMs,
      sessionId,
      payload: { runId, taskId, path, taskName: "Inspect repository", generation: 1 },
    },
    {
      id: "event_incomplete_task_done",
      type: "agent.task_completed",
      time: 3 as TimestampMs,
      sessionId,
      payload: { taskId, runId, path, status: "incomplete", generation: 1, error: "planning_only" },
    },
    {
      id: "event_incomplete_agent_done",
      type: "agent.completed",
      time: 4 as TimestampMs,
      sessionId,
      payload: { runId, taskId, path, status: "incomplete", generation: 1, error: "planning_only" },
    },
  ];

  const snapshot = projectRuntimeAgents(events, sessionId);
  expect(snapshot.tasks).toMatchObject([{ id: taskId, status: "incomplete", completedAt: 3 }]);
  expect(snapshot.agents).toMatchObject([{ id: runId, status: "incomplete", completedAt: 4 }]);
});

test("upcasts a legacy mailbox child session in the runtime agent projection", () => {
  const recipientSessionId = "session_legacy_http_recipient" as SessionId;
  const snapshot = projectRuntimeAgents([{
    id: "event_legacy_http_mailbox",
    type: "agent.message_queued",
    time: 1 as TimestampMs,
    sessionId: "session_legacy_http_sender" as SessionId,
    payload: {
      path: "/root/legacy" as AgentPath,
      from: "/root" as AgentPath,
      triggerTurn: true,
      childSessionId: recipientSessionId,
    },
  } as unknown as ChiliEvent]);

  expect(snapshot.mailbox[0]?.recipientSessionId).toBe(recipientSessionId);
  expect(Object.prototype.hasOwnProperty.call(snapshot.mailbox[0], "childSessionId")).toBe(false);
});

test("serves agent tree and mailbox control routes", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const agents = new FakeAgentTreeService();
  const handler = createRuntimeHttpHandler({ service, store, agents });

  const treeResponse = await handler(new Request("http://chili.test/agents/tree?rootPath=/root&includeConsumedMailbox=true"));
  expect(treeResponse.status).toBe(200);
  expect(await treeResponse.json()).toMatchObject({
    rootPath: "/root",
    nodes: [{ path: "/root", children: [{ path: "/root/task_http" }] }],
  });

  const runsResponse = await handler(new Request("http://chili.test/agent_runs?path=/root/task_http&status=incomplete"));
  expect(runsResponse.status).toBe(200);
  expect(await runsResponse.json()).toMatchObject([{ id: "agent_http_child", path: "/root/task_http" }]);
  expect(agents.runQueries.at(-1)).toMatchObject({ path: "/root/task_http", status: "incomplete" });

  const mailboxResponse = await handler(new Request("http://chili.test/mailbox?status=queued"));
  expect(mailboxResponse.status).toBe(200);
  expect(await mailboxResponse.json()).toMatchObject([{ id: "event_mailbox", status: "queued" }]);
  expect(agents.mailboxQueries.at(-1)).toMatchObject({ status: "queued" });

  const taskMailboxResponse = await handler(new Request(
    "http://chili.test/mailbox?taskId=task_http&recipientSessionId=session_mailbox_recipient&status=queued",
  ));
  expect(taskMailboxResponse.status).toBe(200);
  expect(await taskMailboxResponse.json()).toMatchObject([{
    id: "event_mailbox",
    status: "queued",
    recipientSessionId: "session_mailbox_recipient",
  }]);
  expect(agents.mailboxQueries.at(-1)).toMatchObject({
    taskId: "task_http",
    recipientSessionId: "session_mailbox_recipient",
    status: "queued",
  });

  const legacyMailboxResponse = await handler(new Request(
    "http://chili.test/mailbox?childSessionId=session_mailbox_recipient",
  ));
  expect(legacyMailboxResponse.status).toBe(400);
  expect(await legacyMailboxResponse.json()).toEqual({
    error: { message: "Query parameter \"childSessionId\" is not supported" },
  });

  const unknownMailboxResponse = await handler(new Request(
    "http://chili.test/mailbox?legacyScope=obsolete",
  ));
  expect(unknownMailboxResponse.status).toBe(400);
  expect(await unknownMailboxResponse.json()).toEqual({
    error: { message: "Query parameter \"legacyScope\" is not supported" },
  });

  const consumeResponse = await handler(
    new Request("http://chili.test/mailbox/event_mailbox/consume", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(consumeResponse.status).toBe(200);
  expect(await consumeResponse.json()).toMatchObject({ id: "event_mailbox", status: "consumed" });
  expect(agents.consumedIds).toEqual(["event_mailbox"]);
});

test("serves team control routes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-http-team-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const teams = new TeamControlService({
    store,
    createId: createSequentialId(),
    now: () => 10 as TimestampMs,
  });
  const teamDispatcher = new FakeTeamDispatcherService();
  const teamMerger = new FakeTeamMergeService();
  const teamRunner = new FakeTeamExecutionRunnerService();
  const handler = createRuntimeHttpHandler({ service, store, teams, teamDispatcher, teamMerger, teamRunner });
  const ownerSession = await service.createSession({ cwd: "/repo" });
  const reviewerSessionId = "session_reviewer" as SessionId;

  try {
    const createTeamResponse = await handler(
      new Request("http://chili.test/teams", {
        method: "POST",
        body: JSON.stringify({
          sessionId: ownerSession.sessionId,
          name: "alpha",
          leadPath: "/root",
          description: "team api",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(createTeamResponse.status).toBe(201);
    const team = (await createTeamResponse.json()) as { id: TeamId };
    expect(team).toMatchObject({ id: "team_1", name: "alpha", leadPath: "/root" });

    const duplicateTeamResponse = await handler(
      new Request("http://chili.test/teams", {
        method: "POST",
        body: JSON.stringify({
          teamId: team.id,
          sessionId: ownerSession.sessionId,
          name: "must not overwrite alpha",
          leadPath: "/root/replacement",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(duplicateTeamResponse.status).toBe(409);
    expect((await teams.listTeams()).find((candidate) => candidate.id === team.id)).toMatchObject({
      name: "alpha",
      leadPath: "/root",
    });

    await store.append({
      id: "event_http_reviewer_ownership",
      type: "agent.task_created",
      time: 9 as TimestampMs,
      sessionId: ownerSession.sessionId,
      payload: {
        taskId: "task_http_reviewer_ownership" as TaskId,
        path: "/root/reviewer" as AgentPath,
        parentPath: "/root" as AgentPath,
        parentSessionId: ownerSession.sessionId,
        childSessionId: reviewerSessionId,
        taskName: "reviewer ownership",
        cwd: "/repo",
        prompt: "own reviewer session",
      },
    });

    const addMemberResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/members`, {
        method: "POST",
        body: JSON.stringify({
          path: "/root/reviewer",
          name: "reviewer",
          role: "reviewer",
          childSessionId: reviewerSessionId,
          toolScope: ["read"],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(addMemberResponse.status).toBe(201);
    expect(await addMemberResponse.json()).toMatchObject({ path: "/root/reviewer", role: "reviewer" });

    const invalidMemberSessionResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/members`, {
        method: "POST",
        body: JSON.stringify({
          path: "/root/impostor",
          name: "impostor",
          role: "reviewer",
          childSessionId: ownerSession.sessionId,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(invalidMemberSessionResponse.status).toBe(409);
    expect(await invalidMemberSessionResponse.json()).toMatchObject({
      error: { message: expect.stringContaining("is not owned by /root/impostor") },
    });
    expect((await teams.members(team.id)).some((member) => member.path === "/root/impostor")).toBe(false);

    const createTaskResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          taskId: "task_http_explicit",
          title: "Review HTTP team API",
          createdBy: "/root",
          metadata: { source: "original" },
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(createTaskResponse.status).toBe(201);
    const task = (await createTaskResponse.json()) as { id: TaskId };
    expect(task.id).toBe("task_http_explicit" as TaskId);

    const duplicateTaskResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          taskId: task.id,
          title: "must not replace the HTTP task",
          status: "failed",
          metadata: { source: "duplicate" },
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(duplicateTaskResponse.status).toBe(409);
    expect(await duplicateTaskResponse.json()).toMatchObject({
      error: { message: `Team task already exists: ${task.id} in ${team.id}` },
    });
    expect(await teams.tasks(team.id)).toMatchObject([{
      id: task.id,
      teamId: team.id,
      title: "Review HTTP team API",
      status: "pending",
      metadata: { source: "original" },
    }]);

    const assignResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/assign`, {
        method: "POST",
        body: JSON.stringify({
          ownerPath: "/root/reviewer",
          assignedBy: "/root",
          message: "please review",
          messageDelivery: "triggerTurn",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(assignResponse.status).toBe(200);
    expect(await assignResponse.json()).toMatchObject({ id: task.id, ownerPath: "/root/reviewer" });

    const claimResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/claim`, {
        method: "POST",
        body: JSON.stringify({ ownerPath: "/root/reviewer", claimedBy: "/root/reviewer" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(claimResponse.status).toBe(200);
    expect(await claimResponse.json()).toMatchObject({ applied: true, task: { id: task.id, status: "in_progress" } });

    const dispatchResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/dispatch`, {
        method: "POST",
        body: JSON.stringify({ mode: "background", sessionId: ownerSession.sessionId }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(dispatchResponse.status).toBe(200);
    const runningTeamTask = teamTaskRow({
      teamId: team.id,
      taskId: task.id,
      status: "in_progress",
      metadata: teamDispatchMetadata("running"),
    });
    const runningAgentTask = localSubagentTaskRow({ status: "running" });
    expect(await dispatchResponse.json()).toEqual({
      status: "running",
      teamTask: runningTeamTask,
      team_task: runningTeamTask,
      agentTask: runningAgentTask,
      agent_task: runningAgentTask,
    });
    expect(teamDispatcher.dispatchInputs).toMatchObject([
      { teamId: team.id, taskId: task.id, mode: "background", sessionId: ownerSession.sessionId },
    ]);
    expect(teamDispatcher.dispatchInputs[0]?.signal).toBeInstanceOf(AbortSignal);

    teamDispatcher.nextDispatchResult = {
      status: "skipped",
      reason: "missing_owner",
      teamTask: teamTaskRow({ teamId: team.id, taskId: task.id, status: "pending" }),
    };
    const skippedDispatchResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/dispatch`, {
        method: "POST",
        body: JSON.stringify({ sessionId: ownerSession.sessionId }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(skippedDispatchResponse.status).toBe(200);
    const skippedTeamTask = teamTaskRow({ teamId: team.id, taskId: task.id, status: "pending" });
    expect(await skippedDispatchResponse.json()).toEqual({
      status: "skipped",
      teamTask: skippedTeamTask,
      team_task: skippedTeamTask,
      reason: "missing_owner",
    });

    for (const body of [
      { sessionId: "   " },
      { sessionId: 42 },
      { sessionId: ownerSession.sessionId, cwd: 42 },
      { sessionId: ownerSession.sessionId, cwd: "   " },
      { sessionId: ownerSession.sessionId, cwd: "bad\0cwd" },
    ]) {
      const invalidDispatchResponse = await handler(
        new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/dispatch`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(invalidDispatchResponse.status).toBe(400);
    }
    expect(teamDispatcher.dispatchInputs).toHaveLength(2);

    const syncResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/sync`, {
        method: "POST",
        body: JSON.stringify({ sessionId: ownerSession.sessionId }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(syncResponse.status).toBe(200);
    expect(await syncResponse.json()).toEqual({
      applied: true,
      teamTask: teamTaskRow({
        teamId: team.id,
        taskId: task.id,
        status: "completed",
        metadata: teamDispatchMetadata("completed", 102),
      }),
      agentTask: taskRow({ status: "completed", summary: "done" }),
    });
    expect(teamDispatcher.syncInputs).toMatchObject([{ teamId: team.id, taskId: task.id, sessionId: ownerSession.sessionId }]);

    const teamReconcileResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/reconcile_dispatches`, {
        method: "POST",
        body: JSON.stringify({ sessionId: ownerSession.sessionId, limit: 5 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(teamReconcileResponse.status).toBe(200);
    expect(await teamReconcileResponse.json()).toEqual(reconcileResultJson(team.id));
    expect(teamDispatcher.reconcileInputs.at(-1)).toMatchObject({ teamId: team.id, sessionId: ownerSession.sessionId, limit: 5 });

    const globalReconcileResponse = await handler(
      new Request("http://chili.test/teams/reconcile_dispatches", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(globalReconcileResponse.status).toBe(200);
    expect(await globalReconcileResponse.json()).toEqual(reconcileResultJson("team_http" as TeamId));
    expect(teamDispatcher.reconcileInputs.at(-1)).toMatchObject({ limit: 10 });

    const mergeResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/merge`, {
        method: "POST",
        body: JSON.stringify({ sessionId: ownerSession.sessionId, taskId: task.id, cwd: "/repo" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(mergeResponse.status).toBe(200);
    expect(await mergeResponse.json()).toEqual(teamMergeResultJson(team.id, task.id));
    expect(teamMerger.mergeInputs).toMatchObject([
      { teamId: team.id, taskId: task.id, sessionId: ownerSession.sessionId, cwd: "/repo" },
    ]);

    const runLoopResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/run_loop`, {
        method: "POST",
        body: JSON.stringify({
          sessionId: ownerSession.sessionId,
          cwd: "/repo",
          mode: "background",
          once: true,
          maxCycles: 2,
          timeoutMs: 1000,
          pollIntervalMs: 10,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(runLoopResponse.status).toBe(200);
    expect(await runLoopResponse.json()).toEqual(teamRunLoopResultJson(team.id));
    expect(teamRunner.runInputs).toMatchObject([
      {
        teamId: team.id,
        sessionId: ownerSession.sessionId,
        cwd: "/repo",
        mode: "background",
        once: true,
        maxCycles: 2,
        timeoutMs: 1000,
        pollIntervalMs: 10,
      },
    ]);

    const updateResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/update`, {
        method: "POST",
        body: JSON.stringify({ status: "completed", summary: "done" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({ id: task.id, status: "completed", summary: "done" });

    const tasksResponse = await handler(new Request(`http://chili.test/teams/${team.id}/tasks`));
    expect(tasksResponse.status).toBe(200);
    expect(await tasksResponse.json()).toMatchObject([{ id: task.id, status: "completed" }]);

    const messagesResponse = await handler(new Request(`http://chili.test/teams/${team.id}/messages`));
    expect(messagesResponse.status).toBe(200);
    expect(await messagesResponse.json()).toMatchObject([
      { kind: "task_assignment", delivery: "triggerTurn", deliveryStatus: "queued", content: "please review" },
    ]);
    const snapshotResponse = await handler(new Request(`http://chili.test/teams/${team.id}/snapshot`));
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      stats: {
        memberCount: number;
        taskCount: number;
        messageCount: number;
        deliveryCount: number;
      };
      members: Array<{ path: string; taskIds: string[]; deliveryIds: string[] }>;
      tasks: Array<{ id: string; owner?: { path: string }; messageIds: string[] }>;
      messages: Array<{ deliveries: Array<{ path: string; status: string }> }>;
    };
    expect(snapshot.stats).toMatchObject({
      memberCount: 2,
      taskCount: 1,
      messageCount: 1,
      deliveryCount: 1,
    });
    expect(snapshot.members.find((member) => member.path === "/root/reviewer")).toMatchObject({
      taskIds: [task.id],
    });
    expect(snapshot.members.find((member) => member.path === "/root/reviewer")?.deliveryIds).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      id: task.id,
      owner: { path: "/root/reviewer" },
    });
    expect(snapshot.tasks[0]?.messageIds).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      deliveries: [{ path: "/root/reviewer", status: "queued" }],
    });
    expect(await store.agentMailbox({ path: "/root/reviewer" as AgentPath, status: "queued" })).toMatchObject([
      {
        path: "/root/reviewer",
        fromPath: "/root",
        triggerTurn: true,
        recipientSessionId: "session_reviewer",
        taskId: task.id,
      },
    ]);

    await store.append({
      id: "event_http_reviewer_session",
      type: "session.created",
      time: 11 as TimestampMs,
      sessionId: reviewerSessionId,
      payload: { sessionId: reviewerSessionId, cwd: "/repo" },
    });
    const descendantMessageResponse = await handler(new Request(`http://chili.test/teams/${team.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: reviewerSessionId,
        from: "/root/reviewer",
        to: "/root",
        content: "review complete",
      }),
      headers: { "content-type": "application/json" },
    }));
    expect(descendantMessageResponse.status).toBe(201);
    expect(await descendantMessageResponse.json()).toMatchObject({
      fromPath: "/root/reviewer",
      toPath: "/root",
      content: "review complete",
    });
    expect(service.sessionOperationIds).toEqual(Array<SessionId>(10).fill(ownerSession.sessionId));
    expect(await store.events({ type: "team.message_sent", limit: 100 })).toContainEqual(
      expect.objectContaining({
        sessionId: reviewerSessionId,
        payload: expect.objectContaining({ content: "review complete" }),
      }),
    );
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalizes hostile local subagent task errors at the HTTP boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-http-hostile-subagent-error-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const teams = new TeamControlService({
    store,
    createId: createSequentialId(),
    now: () => 20 as TimestampMs,
  });
  const teamDispatcher = new FakeTeamDispatcherService();
  try {
    const ownerSession = await service.createSession({
      sessionId: "session_http_hostile_subagent_error" as SessionId,
      cwd: "/repo",
    });
    const team = await teams.createTeam({
      sessionId: ownerSession.sessionId,
      name: "hostile-subagent-error",
      leadPath: "/root" as AgentPath,
    });
    const hostileMessage = "secret=LOCAL_SUBAGENT_SECRET\n" + "\u0000".repeat(5 * 1024 * 1024);
    const hostileError = Object.create(null) as Error;
    Object.defineProperties(hostileError, {
      message: { enumerable: true, get: () => hostileMessage },
      name: { enumerable: true, get: () => "RemoteSubagentError" },
      stack: { enumerable: true, get: () => { throw new Error("stack accessor must not run"); } },
    });
    const normalized = normalizePersistedError(hostileError);
    teamDispatcher.nextDispatchResult = {
      status: "failed",
      teamTask: teamTaskRow({
        teamId: team.id,
        taskId: "task_http_hostile_subagent_error" as TaskId,
        status: "failed",
      }),
      agentTask: {
        ...localSubagentTaskRow({ status: "failed" }),
        error: hostileError,
      },
    };
    const handler = createRuntimeHttpHandler({ service, store, teams, teamDispatcher });

    const response = await handler(new Request(
      `http://chili.test/teams/${team.id}/tasks/task_http_hostile_subagent_error/dispatch`,
      {
        method: "POST",
        body: JSON.stringify({ sessionId: ownerSession.sessionId }),
        headers: { "content-type": "application/json" },
      },
    ));
    const responseText = await response.text();
    const body = JSON.parse(responseText) as {
      agentTask: { error: string };
      agent_task: { error: string };
    };

    expect(response.status).toBe(200);
    expect(body.agentTask.error).toBe(normalized.message);
    expect(body.agent_task.error).toBe(normalized.message);
    expect(Buffer.byteLength(body.agentTask.error, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    expect(Buffer.byteLength(responseText, "utf8")).toBeLessThanOrEqual(40_000);
    expect(responseText).toContain("[REDACTED]");
    expect(responseText).toContain("error message truncated from");
    expect(responseText).not.toContain("LOCAL_SUBAGENT_SECRET");
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("team HTTP CRUD mutations acquire the owner session operation and stay side-effect free when busy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-http-team-operation-fence-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const teams = new TeamControlService({
    store,
    createId: createSequentialId(),
    now: () => 30 as TimestampMs,
  });
  const handler = createRuntimeHttpHandler({ service, store, teams });
  const owner = await service.createSession({
    sessionId: "session_http_team_operation_owner" as SessionId,
    cwd: "/repo",
  });

  try {
    const team = await teams.createTeam({
      sessionId: owner.sessionId,
      name: "operation fence",
      leadPath: "/root" as AgentPath,
    });
    const task = await teams.createTask({
      teamId: team.id,
      sessionId: owner.sessionId,
      title: "must remain pending",
    });
    const before = await store.events({ limit: 1_000 });
    service.busySessionOperations.add(owner.sessionId);

    const cases = [
      {
        url: "http://chili.test/teams",
        body: { sessionId: owner.sessionId, name: "must not exist", leadPath: "/root" },
      },
      {
        url: `http://chili.test/teams/${team.id}/members`,
        body: { path: "/root/blocked", name: "blocked", role: "worker" },
      },
      {
        url: `http://chili.test/teams/${team.id}/tasks`,
        body: { title: "must not exist" },
      },
      {
        url: `http://chili.test/teams/${team.id}/tasks/${task.id}/assign`,
        body: { ownerPath: "/root" },
      },
      {
        url: `http://chili.test/teams/${team.id}/tasks/${task.id}/claim`,
        body: { ownerPath: "/root" },
      },
      {
        url: `http://chili.test/teams/${team.id}/tasks/${task.id}/update`,
        body: { status: "completed", summary: "must not persist" },
      },
      {
        url: `http://chili.test/teams/${team.id}/messages`,
        body: { from: "/root", to: "/root", content: "must not persist" },
      },
    ];
    for (const testCase of cases) {
      const response = await handler(new Request(testCase.url, {
        method: "POST",
        body: JSON.stringify(testCase.body),
        headers: { "content-type": "application/json" },
      }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringContaining("already running") },
      });
    }

    expect(service.sessionOperationIds).toEqual(Array<SessionId>(cases.length).fill(owner.sessionId));
    expect(await store.events({ limit: 1_000 })).toEqual(before);
    expect((await teams.listTeams()).some((candidate) => candidate.name === "must not exist")).toBe(false);
    expect(await teams.tasks(team.id)).toMatchObject([{ id: task.id, status: "pending" }]);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("team run, merge, dispatch, sync, and reconcile reject invalid owner authority before service calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-http-team-authority-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const teams = new TeamControlService({
    store,
    createId: createSequentialId(),
    now: () => 20 as TimestampMs,
  });
  const teamRunner = new FakeTeamExecutionRunnerService();
  const teamMerger = new FakeTeamMergeService();
  const teamDispatcher = new FakeTeamDispatcherService();
  const handler = createRuntimeHttpHandler({ service, store, teams, teamRunner, teamMerger, teamDispatcher });
  const sessionA = "session_http_team_authority_a" as SessionId;
  const sessionB = "session_http_team_authority_b" as SessionId;
  const sessionMissing = "session_http_team_authority_missing" as SessionId;
  const sessionArchived = "session_http_team_authority_archived" as SessionId;
  const sessionSubagent = "session_http_team_authority_subagent" as SessionId;

  try {
    for (const [index, sessionId, cwd] of [
      [1, sessionA, "/repo/a"],
      [2, sessionB, "/repo/b"],
      [3, sessionArchived, "/repo/archived"],
      [4, sessionSubagent, "/repo/subagent"],
    ] as const) {
      await store.append({
        id: `event_http_team_authority_session_${index}`,
        type: "session.created",
        time: index as TimestampMs,
        sessionId,
        payload: { sessionId, cwd },
      });
    }
    const teamA = await teams.createTeam({ sessionId: sessionA, name: "A", leadPath: "/root" as AgentPath });
    const teamMissing = await teams.createTeam({ sessionId: sessionMissing, name: "missing", leadPath: "/root" as AgentPath });
    const teamArchived = await teams.createTeam({ sessionId: sessionArchived, name: "archived", leadPath: "/root" as AgentPath });
    const teamSubagent = await teams.createTeam({ sessionId: sessionSubagent, name: "subagent", leadPath: "/root" as AgentPath });
    await store.append({
      id: "event_http_team_authority_archived",
      type: "session.archived",
      time: 10 as TimestampMs,
      sessionId: sessionArchived,
      payload: { sessionId: sessionArchived },
    });
    service.blockedSubagentSessions.add(sessionSubagent);

    const beforeRejectedMutations = await store.events({ limit: 1_000 });
    for (const request of [
      { suffix: "members", body: { sessionId: sessionB, path: "/root/blocked", name: "blocked", role: "worker" } },
      { suffix: "tasks", body: { sessionId: sessionB, title: "blocked" } },
      { suffix: "tasks/task_authority/assign", body: { sessionId: sessionB, ownerPath: "/root" } },
      { suffix: "tasks/task_authority/claim", body: { sessionId: sessionB, ownerPath: "/root" } },
      { suffix: "tasks/task_authority/update", body: { sessionId: sessionB, status: "completed" } },
    ]) {
      const response = await handler(new Request(`http://chili.test/teams/${teamA.id}/${request.suffix}`, {
        method: "POST",
        body: JSON.stringify(request.body),
        headers: { "content-type": "application/json" },
      }));
      expect(response.status).toBe(409);
    }
    const archivedActorMessage = await handler(new Request(`http://chili.test/teams/${teamA.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: sessionArchived,
        from: "/root",
        to: "/root",
        content: "blocked",
      }),
      headers: { "content-type": "application/json" },
    }));
    expect(archivedActorMessage.status).toBe(409);
    expect(await store.events({ limit: 1_000 })).toEqual(beforeRejectedMutations);

    const cases = [
      { teamId: teamA.id, body: { sessionId: sessionB, cwd: "/repo/a" }, status: 409 },
      { teamId: teamA.id, body: { sessionId: sessionA, cwd: "/repo/b" }, status: 409 },
      { teamId: teamMissing.id, body: {}, status: 404 },
      { teamId: teamArchived.id, body: {}, status: 409 },
      { teamId: teamSubagent.id, body: {}, status: 409 },
    ];
    for (const route of ["run_loop", "merge"] as const) {
      for (const testCase of cases) {
        const response = await handler(new Request(`http://chili.test/teams/${testCase.teamId}/${route}`, {
          method: "POST",
          body: JSON.stringify(testCase.body),
          headers: { "content-type": "application/json" },
        }));
        expect(response.status).toBe(testCase.status);
      }
    }

    const mutationCases = [
      { teamId: teamA.id, body: { sessionId: sessionB }, status: 409 },
      { teamId: teamMissing.id, body: {}, status: 404 },
      { teamId: teamArchived.id, body: {}, status: 409 },
      { teamId: teamSubagent.id, body: {}, status: 409 },
    ];
    for (const testCase of mutationCases) {
      for (const suffix of ["tasks/task_authority/dispatch", "tasks/task_authority/sync", "reconcile_dispatches"] as const) {
        const response = await handler(new Request(`http://chili.test/teams/${testCase.teamId}/${suffix}`, {
          method: "POST",
          body: JSON.stringify(testCase.body),
          headers: { "content-type": "application/json" },
        }));
        expect(response.status).toBe(testCase.status);
      }
    }
    const globalReconcile = await handler(new Request("http://chili.test/teams/reconcile_dispatches", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    }));
    expect([404, 409]).toContain(globalReconcile.status);

    expect(teamRunner.runInputs).toEqual([]);
    expect(teamMerger.mergeInputs).toEqual([]);
    expect(teamDispatcher.dispatchInputs).toEqual([]);
    expect(teamDispatcher.syncInputs).toEqual([]);
    expect(teamDispatcher.reconcileInputs).toEqual([]);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("maps an archived team run-loop boundary to an HTTP conflict", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const teamId = "team_http_archived" as TeamId;
  const teams = {
    async listTeams() {
      return [{
        id: teamId,
        name: "archived",
        leadPath: "/root" as AgentPath,
        status: "archived" as const,
        createdAt: 1,
        updatedAt: 2,
      }];
    },
  } as unknown as RuntimeTeamService;
  const teamRunner = new FakeTeamExecutionRunnerService();
  const handler = createRuntimeHttpHandler({ service, store, teams, teamRunner });

  const response = await handler(new Request(`http://chili.test/teams/${teamId}/run_loop`, {
    method: "POST",
    body: JSON.stringify({ once: true }),
    headers: { "content-type": "application/json" },
  }));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: { message: `Cannot operate on archived team ${teamId}` },
  });
  expect(teamRunner.runInputs).toEqual([]);
});

test("maps scoped worker team-task mutation denials to HTTP 403", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-http-team-worker-denial-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const teams = new TeamControlService({
    store,
    createId: createSequentialId(),
    now: () => 30 as TimestampMs,
  });

  try {
    const owner = await service.createSession({ cwd: "/repo" });
    const team = await teams.createTeam({
      sessionId: owner.sessionId,
      name: "worker-denial",
      leadPath: "/root" as AgentPath,
    });
    const task = await teams.createTask({
      teamId: team.id,
      sessionId: owner.sessionId,
      title: "protected task",
    });
    teams.updateTask = async () => {
      const error = new Error(
        `Scoped worker cannot update team task ${task.id} in ${team.id}: field is runtime-owned: ownerPath`,
      );
      error.name = "TeamTaskWorkerMutationError";
      throw error;
    };
    const handler = createRuntimeHttpHandler({ service, store, teams });

    const response = await handler(new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/update`, {
      method: "POST",
      body: JSON.stringify({ ownerPath: "/root/other" }),
      headers: { "content-type": "application/json" },
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        message: `Scoped worker cannot update team task ${task.id} in ${team.id}: field is runtime-owned: ownerPath`,
      },
    });
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolves approvals through the runtime HTTP handler", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const calls: unknown[] = [];
  const approvals = {
    resolved: false,
    maxApprovalScope() {
      return "persistent" as const;
    },
    resolve(input: { decision: ApprovalDecisionAction; feedback?: string }) {
      calls.push(input);
      this.resolved = input.decision === "allow_session";
      return this.resolved;
    },
  };
  const handler = createRuntimeHttpHandler({ service, store, approvals });

  const response = await handler(
    new Request("http://chili.test/approvals/approval_http/resolve", {
      method: "POST",
      body: JSON.stringify({ decision: "allow_session", feedback: "" }),
      headers: { "content-type": "application/json" },
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ resolved: true });
  expect(approvals.resolved).toBe(true);
  expect(calls).toEqual([{ approvalId: "approval_http", decision: "allow_session", feedback: "" }]);
});

test("lists and resolves pending user input through the runtime HTTP handler", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const pending: PendingUserInputRequest[] = [
    {
      id: "userinput_http" as UserInputId,
      sessionId: "session_http" as SessionId,
      callId: "toolcall_http" as ToolCallId,
      createdAt: 123,
      questions: [{
        id: "theme",
        header: "Theme",
        question: "Which theme should Chili use?",
        options: [
          { label: "Light", description: "Use a light theme." },
          { label: "Dark", description: "Use a dark theme." },
        ],
      }],
    },
  ];
  const listInputs: unknown[] = [];
  const resolveInputs: unknown[] = [];
  const userInputs = {
    list(input: { sessionId?: SessionId } = {}) {
      listInputs.push(input);
      return pending.filter((request) => !input.sessionId || request.sessionId === input.sessionId);
    },
    resolve(input: { inputId: UserInputId; answers: UserInputAnswers }) {
      resolveInputs.push(input);
      const index = pending.findIndex((request) => request.id === input.inputId);
      if (index < 0) return false;
      pending.splice(index, 1);
      return true;
    },
  };
  const handler = createRuntimeHttpHandler({ service, store, userInputs });

  const listResponse = await handler(new Request("http://chili.test/user-inputs?sessionId=session_http"));
  expect(listResponse.status).toBe(200);
  expect(await listResponse.json()).toEqual([expect.objectContaining({
    id: "userinput_http",
    sessionId: "session_http",
    callId: "toolcall_http",
    createdAt: 123,
  })]);

  const resolveResponse = await handler(new Request("http://chili.test/user-inputs/userinput_http/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: { theme: ["Dark"] } }),
  }));
  expect(resolveResponse.status).toBe(200);
  expect(await resolveResponse.json()).toEqual({ resolved: true });
  expect(listInputs).toEqual([{ sessionId: "session_http" }, {}]);
  expect(resolveInputs).toEqual([{ inputId: "userinput_http", answers: { theme: ["Dark"] } }]);

  const repeatedResponse = await handler(new Request("http://chili.test/user-inputs/userinput_http/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: { theme: ["Dark"] } }),
  }));
  expect(repeatedResponse.status).toBe(404);
});

test("validates user input HTTP filters and answer bodies before resolving", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const request: PendingUserInputRequest = {
    id: "userinput_validation" as UserInputId,
    sessionId: "session_validation" as SessionId,
    callId: "toolcall_validation" as ToolCallId,
    createdAt: 123,
    questions: [{
      id: "theme",
      header: "Theme",
      question: "Which theme should Chili use?",
      options: [
        { label: "Light", description: "Use a light theme." },
        { label: "Dark", description: "Use a dark theme." },
      ],
    }],
  };
  const resolveInputs: unknown[] = [];
  const handler = createRuntimeHttpHandler({
    service,
    store,
    userInputs: {
      list: () => [request],
      resolve(input) {
        resolveInputs.push(input);
        return false;
      },
    },
  });

  const badRequests = [
    { answers: {} },
    { answers: { unknown: ["Dark"] } },
    { answers: { theme: ["Light", "Dark"] } },
    { answers: { theme: ["Dark"] }, unexpected: true },
  ];
  for (const body of badRequests) {
    const response = await handler(new Request("http://chili.test/user-inputs/userinput_validation/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(400);
  }
  expect(resolveInputs).toEqual([]);

  const conflict = await handler(new Request("http://chili.test/user-inputs/userinput_validation/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: { theme: ["Dark"] } }),
  }));
  expect(conflict.status).toBe(409);
  expect(resolveInputs).toHaveLength(1);

  const unknownFilter = await handler(new Request("http://chili.test/user-inputs?unexpected=true"));
  expect(unknownFilter.status).toBe(400);
});

test("approval resolvers without scope introspection can only resolve one-shot decisions", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const calls: unknown[] = [];
  const handler = createRuntimeHttpHandler({
    service,
    store,
    approvals: {
      resolve(input: unknown) {
        calls.push(input);
        return true;
      },
    },
  });

  const response = await handler(
    new Request("http://chili.test/approvals/approval_http/resolve", {
      method: "POST",
      body: JSON.stringify({ decision: "allow_always" }),
      headers: { "content-type": "application/json" },
    }),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { message: "Approval decision allow_always exceeds the maximum approval scope once." },
  });
  expect(calls).toEqual([]);
});

test("rejects approval decisions above the pending request scope", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const calls: unknown[] = [];
  const handler = createRuntimeHttpHandler({
    service,
    store,
    approvals: {
      maxApprovalScope: () => "once" as const,
      resolve(input: unknown) {
        calls.push(input);
        return true;
      },
    },
  });

  const response = await handler(
    new Request("http://chili.test/approvals/approval_http/resolve", {
      method: "POST",
      body: JSON.stringify({ decision: "allow_session" }),
      headers: { "content-type": "application/json" },
    }),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { message: "Approval decision allow_session exceeds the maximum approval scope once." },
  });
  expect(calls).toEqual([]);
});

test("gets and sets permission profiles through the runtime HTTP handler", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  let profile: RuntimePermissionProfileId = "default";
  const permissions = {
    get() {
      return permissionConfig(profile);
    },
    set(nextProfile: RuntimePermissionProfileId) {
      profile = nextProfile;
      return permissionConfig(profile);
    },
  };
  const handler = createRuntimeHttpHandler({ service, store, permissions });

  const getResponse = await handler(new Request("http://chili.test/permissions"));
  expect(getResponse.status).toBe(200);
  expect(await getResponse.json()).toMatchObject({ profile: "default" });

  const setResponse = await handler(
    new Request("http://chili.test/permissions", {
      method: "POST",
      body: JSON.stringify({ profile: "full-access" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(setResponse.status).toBe(200);
  expect(await setResponse.json()).toMatchObject({ profile: "full-access" });
  expect(String(profile)).toBe("full-access");

  const badResponse = await handler(
    new Request("http://chili.test/permissions", {
      method: "POST",
      body: JSON.stringify({ profile: "unsafe" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(badResponse.status).toBe(400);
});

test("serves prompt commands and submits expanded command prompts", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const commands = new FakePromptCommandControl();
  const handler = createRuntimeHttpHandler({ service, store, commands });
  const session = await service.createSession({ cwd: "/persisted/project" });

  const listResponse = await handler(new Request("http://chili.test/commands"));
  expect(listResponse.status).toBe(200);
  expect(await listResponse.json()).toMatchObject({
    roots: [{ id: "prompt.project.joke", name: "joke", description: "Tell a joke" }],
  });

  const reloadResponse = await handler(
    new Request("http://chili.test/commands/reload", { method: "POST" }),
  );
  expect(reloadResponse.status).toBe(200);
  expect(commands.reloadCount).toBe(1);

  const sessionListResponse = await handler(
    new Request(`http://chili.test/sessions/${session.sessionId}/commands?cwd=%2Funtrusted`),
  );
  expect(sessionListResponse.status).toBe(200);

  const sessionReloadResponse = await handler(
    new Request(`http://chili.test/sessions/${session.sessionId}/commands/reload`, {
      method: "POST",
      body: JSON.stringify({ cwd: "/untrusted" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(sessionReloadResponse.status).toBe(200);
  expect(commands.reloadCount).toBe(2);
  expect(commands.listInputs).toEqual([{}, { cwd: "/persisted/project" }]);
  expect(commands.reloadInputs).toEqual([{}, { cwd: "/persisted/project" }]);

  const submitResponse = await handler(
    new Request(`http://chili.test/sessions/${session.sessionId}/command_async`, {
      method: "POST",
      body: JSON.stringify({
        commandId: "prompt.project.joke",
        args: "typescript",
        modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
      headers: { "content-type": "application/json" },
    }),
  );

  expect(submitResponse.status).toBe(202);
  expect(await submitResponse.json()).toEqual({ status: "accepted", sessionId: session.sessionId });
  expect(commands.lastRun).toEqual({ commandId: "prompt.project.joke", args: "typescript", cwd: "/persisted/project" });
  expect(service.lastPrompt).toMatchObject({
    sessionId: session.sessionId,
    cwd: "/persisted/project",
    text: "Tell a short joke about typescript.",
    displayText: "/joke typescript",
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
    reasoningLevel: "high",
    serviceTier: "fast",
    toolPolicy: {
      allowedTools: ["read", "write"],
      writeScope: ["AGENTS.md"],
    },
  });

  commands.lastRun = undefined;
  service.lastPrompt = undefined;
  const legacyNameResponse = await handler(
    new Request(`http://chili.test/sessions/${session.sessionId}/command_async`, {
      method: "POST",
      body: JSON.stringify({ name: "joke" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(legacyNameResponse.status).toBe(400);
  expect(await legacyNameResponse.json()).toEqual({ error: { message: "commandId is required" } });
  expect(commands.lastRun).toBeUndefined();
  expect(service.lastPrompt).toBeUndefined();

  const usageResponse = await handler(
    new Request(`http://chili.test/sessions/${session.sessionId}/command`, {
      method: "POST",
      body: JSON.stringify({ commandId: "prompt.project.required" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(usageResponse.status).toBe(400);
  expect(await usageResponse.json()).toEqual({
    error: { message: "Command prompt.project.required requires: /prompt project required <input>" },
  });

  const missingResponse = await handler(
    new Request(`http://chili.test/sessions/${session.sessionId}/command_async`, {
      method: "POST",
      body: JSON.stringify({ commandId: "prompt.project.missing" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(missingResponse.status).toBe(404);
  expect(await missingResponse.json()).toEqual({
    error: { message: "Unknown command ID: prompt.project.missing" },
  });
  expect(service.lastPrompt).toBeUndefined();
});

test("canonicalizes a persisted legacy workspace for command catalogs and execution", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "chili-http-command-cwd-"));
  const workspace = join(fixture, "workspace");
  const workspaceAlias = join(fixture, "workspace-alias");
  try {
    await mkdir(workspace);
    await symlink(workspace, workspaceAlias);
    const canonicalWorkspace = await realpath(workspace);
    const baseStore = new MemoryEventStore();
    const store = new ObservableEventStore(baseStore);
    const service = new FakeRuntimeService(store);
    const commands = new FakePromptCommandControl();
    const handler = createRuntimeHttpHandler({ service, store, commands });
    const session = await service.createSession({
      sessionId: "session_legacy_command_cwd" as SessionId,
      cwd: workspaceAlias,
    });

    expect((await store.sessions())[0]?.cwd).toBe(workspaceAlias);
    expect((await handler(new Request(
      `http://chili.test/sessions/${session.sessionId}/commands`,
    ))).status).toBe(200);
    expect((await handler(new Request(
      `http://chili.test/sessions/${session.sessionId}/commands/reload`,
      { method: "POST" },
    ))).status).toBe(200);
    expect((await handler(new Request(
      `http://chili.test/sessions/${session.sessionId}/command`,
      {
        method: "POST",
        body: JSON.stringify({ commandId: "prompt.project.joke" }),
        headers: { "content-type": "application/json" },
      },
    ))).status).toBe(200);

    expect(commands.listInputs).toEqual([{ cwd: canonicalWorkspace }]);
    expect(commands.reloadInputs).toEqual([{ cwd: canonicalWorkspace }]);
    expect(commands.lastRun?.cwd).toBe(canonicalWorkspace);
    expect(service.lastPrompt?.cwd).toBe(canonicalWorkspace);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("rejects direct HTTP prompts, commands, controls, and lifecycle mutations for subagent sessions", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const commands = new FakePromptCommandControl();
  const handler = createRuntimeHttpHandler({ service, store, commands });
  const session = await service.createSession({
    sessionId: "session_http_child" as SessionId,
  });
  service.blockedSubagentSessions.add(session.sessionId);

  const requests = [
    new Request(`http://chili.test/sessions/${session.sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "bypass synchronously" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({ text: "bypass", cwd: 42 }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/command_async`, {
      method: "POST",
      body: JSON.stringify({ commandId: "prompt.project.joke" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/command`, {
      method: "POST",
      body: JSON.stringify({ commandId: "prompt.project.joke", cwd: "   " }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/goal`, {
      method: "POST",
      body: JSON.stringify({ objective: "bypass through goal" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/goal`, {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/goal`, {
      method: "DELETE",
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/commands`),
    new Request(`http://chili.test/sessions/${session.sessionId}/commands/reload`, {
      method: "POST",
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/model`, {
      method: "POST",
      body: JSON.stringify({ modelSelection: { provider: "openai-codex", model: "gpt-5.5" } }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/reasoning`, {
      method: "POST",
      body: JSON.stringify({ reasoningLevel: "high" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/service-tier`, {
      method: "POST",
      body: JSON.stringify({ serviceTier: "fast" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/delegation`, {
      method: "POST",
      body: JSON.stringify({ policy: "off" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/goal`, {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/goal`, {
      method: "DELETE",
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/commands`),
    new Request(`http://chili.test/sessions/${session.sessionId}/commands/reload`, {
      method: "POST",
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/rename`, {
      method: "POST",
      body: JSON.stringify({ title: "blocked rename" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/archive`, {
      method: "POST",
    }),
  ];

  for (const request of requests) {
    const response = await handler(request);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("Use task_followup for the owning task") },
    });
  }
  expect(service.lastPrompt).toBeUndefined();
  expect(service.goal).toBeUndefined();
  expect(commands.lastRun).toBeUndefined();
});

test("rejects prompt and mutation routes after a session is archived", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });
  const session = await service.createSession({
    sessionId: "session_http_archived" as SessionId,
  });

  const archive = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/archive`, {
    method: "POST",
  }));
  expect(archive.status).toBe(204);
  expect((await store.sessions()).find((candidate) => candidate.id === session.sessionId)?.status).toBe("archived");

  const blockedRequests = [
    new Request(`http://chili.test/sessions/${session.sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "must stay archived" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/delegation`, {
      method: "POST",
      body: JSON.stringify({ policy: "off" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/rename`, {
      method: "POST",
      body: JSON.stringify({ title: "must stay archived" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${session.sessionId}/archive`, {
      method: "POST",
    }),
  ];

  for (const request of blockedRequests) {
    const response = await handler(request);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { message: `Session is not active: ${session.sessionId} (archived)` },
    });
  }
});

test("rejects a known pending child over HTTP before its session row exists", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const commands = new FakePromptCommandControl();
  const handler = createRuntimeHttpHandler({ service, store, commands });
  const sessionId = "session_http_pending_child" as SessionId;
  service.blockedSubagentSessions.add(sessionId);

  const requests = [
    new Request(`http://chili.test/sessions/${sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({text: "race the pending child", cwd: 42 }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${sessionId}/command_async`, {
      method: "POST",
      body: JSON.stringify({commandId: "prompt.project.joke" }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${sessionId}/command`, {
      method: "POST",
      body: JSON.stringify({commandId: "prompt.project.joke", cwd: null }),
      headers: { "content-type": "application/json" },
    }),
    new Request(`http://chili.test/sessions/${sessionId}/goal`, {
      method: "POST",
      body: JSON.stringify({objective: "race through a goal continuation" }),
      headers: { "content-type": "application/json" },
    }),
  ];

  expect(await store.sessions()).toEqual([]);
  for (const request of requests) {
    const response = await handler(request);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("Use task_followup for the owning task") },
    });
  }
  expect(service.lastPrompt).toBeUndefined();
  expect(service.goal).toBeUndefined();
  expect(commands.lastRun).toBeUndefined();
});

test("serves MCP management routes through optional runtime control", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const mcp = new FakeMcpControlService();
  const handler = createRuntimeHttpHandler({ service, store, mcp });

  const listResponse = await handler(new Request("http://chili.test/mcp"));
  expect(listResponse.status).toBe(200);
  expect(await listResponse.json()).toMatchObject({
    servers: [{ name: "github", status: "running", toolCount: 2 }],
  });

  const statusResponse = await handler(new Request("http://chili.test/mcp/status"));
  expect(statusResponse.status).toBe(200);
  expect(await statusResponse.json()).toMatchObject({
    summary: { total: 1, running: 1, disabled: 0, authRequired: 0, errored: 0 },
  });

  const addResponse = await handler(
    new Request("http://chili.test/mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "remote_docs",
        transport: "http",
        url: "https://mcp.example/docs",
        enabled: false,
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(addResponse.status).toBe(201);
  expect(await addResponse.json()).toMatchObject({ name: "remote_docs", status: "disabled", enabled: false });
  expect(mcp.added).toMatchObject({
    name: "remote_docs",
    transport: "http",
    url: "https://mcp.example/docs",
    enabled: false,
  });

  const stdioAddResponse = await handler(
    new Request("http://chili.test/mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(stdioAddResponse.status).toBe(403);

  const serverResponse = await handler(new Request("http://chili.test/mcp/github"));
  expect(serverResponse.status).toBe(200);
  expect(await serverResponse.json()).toMatchObject({ name: "github", status: "running" });

  const toolsResponse = await handler(new Request("http://chili.test/mcp/github/tools"));
  expect(toolsResponse.status).toBe(200);
  expect(await toolsResponse.json()).toEqual({
    server: "github",
    tools: [{ name: "search_issues", description: "Search issues" }],
  });

  const authResponse = await handler(
    new Request("http://chili.test/mcp/github/auth", {
      method: "POST",
      body: JSON.stringify({ callbackUrl: "http://localhost/callback", scopes: ["repo"] }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(authResponse.status).toBe(200);
  expect(await authResponse.json()).toEqual({
    server: "github",
    status: "pending",
    url: "https://auth.example/github",
  });
  expect(mcp.authInput).toEqual({ callbackUrl: "http://localhost/callback", scopes: ["repo"] });

  const reloadResponse = await handler(new Request("http://chili.test/mcp/reload", { method: "POST" }));
  expect(reloadResponse.status).toBe(200);
  expect(await reloadResponse.json()).toMatchObject({ reloaded: true, errors: [] });

  const logoutResponse = await handler(new Request("http://chili.test/mcp/github/logout", { method: "POST" }));
  expect(logoutResponse.status).toBe(200);
  expect(await logoutResponse.json()).toEqual({ server: "github", loggedOut: true });

  const removeResponse = await handler(new Request("http://chili.test/mcp/github", { method: "DELETE" }));
  expect(removeResponse.status).toBe(200);
  expect(await removeResponse.json()).toEqual({ server: "github", removed: true });
});

test("scopes MCP catalog views to the persisted canonical session workspace", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "chili-mcp-http-scope-"));
  const workspace = join(tempRoot, "workspace");
  const workspaceAlias = join(tempRoot, "workspace-alias");
  await mkdir(workspace);
  await symlink(workspace, workspaceAlias);

  try {
    const baseStore = new MemoryEventStore();
    const store = new ObservableEventStore(baseStore);
    const service = new FakeRuntimeService(store);
    const mcp = new FakeMcpControlService();
    const handler = createRuntimeHttpHandler({ service, store, mcp });
    const sessionId = "session_mcp_scope" as SessionId;
    await store.append({
      id: "event_session_mcp_scope",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: workspaceAlias },
    });

    const query = `sessionId=${encodeURIComponent(sessionId)}`;
    expect((await handler(new Request(`http://chili.test/mcp?${query}`))).status).toBe(200);
    expect((await handler(new Request(`http://chili.test/mcp/status?${query}`))).status).toBe(200);
    expect((await handler(new Request(`http://chili.test/mcp/github?${query}`))).status).toBe(200);
    expect((await handler(new Request(`http://chili.test/mcp/github/tools?${query}`))).status).toBe(200);
    expect((await handler(new Request(`http://chili.test/mcp/reload?${query}`, { method: "POST" }))).status).toBe(200);

    const canonicalWorkspace = await realpath(workspace);
    expect(mcp.scopeInputs).toEqual([
      { operation: "list", cwd: canonicalWorkspace },
      { operation: "list", cwd: canonicalWorkspace },
      { operation: "list", cwd: canonicalWorkspace },
      { operation: "tools", cwd: canonicalWorkspace },
      { operation: "reload", cwd: canonicalWorkspace },
    ]);
    expect(service.sessionOperationIds).toEqual([sessionId]);

    const callCount = mcp.scopeInputs.length;
    const missing = await handler(new Request("http://chili.test/mcp/status?sessionId=session_missing"));
    expect(missing.status).toBe(404);
    expect(mcp.scopeInputs).toHaveLength(callCount);

    const unsupported = await handler(new Request(`http://chili.test/mcp?${query}&cwd=${encodeURIComponent(workspace)}`));
    expect(unsupported.status).toBe(400);
    expect(mcp.scopeInputs).toHaveLength(callCount);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("keeps archived MCP reads project-scoped while reload remains active-only", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "chili-mcp-http-archived-scope-"));
  const workspace = join(tempRoot, "workspace");
  const workspaceAlias = join(tempRoot, "workspace-alias");
  await mkdir(workspace);
  await symlink(workspace, workspaceAlias);

  try {
    const baseStore = new MemoryEventStore();
    const store = new ObservableEventStore(baseStore);
    const service = new FakeRuntimeService(store);
    const mcp = new FakeMcpControlService();
    const handler = createRuntimeHttpHandler({ service, store, mcp });
    const client = new HttpRuntimeClient({
      baseUrl: "http://chili.test/",
      fetch: ((input, init) => handler(new Request(input, init))) as typeof fetch,
    });
    const sessionId = "session_mcp_archived_scope" as SessionId;
    await store.append({
      id: "event_session_mcp_archived_scope_created",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: workspaceAlias },
    });
    await store.append({
      id: "event_session_mcp_archived_scope_archived",
      type: "session.archived",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId },
    });

    const reloadResponse = await handler(new Request(`http://chili.test/mcp/reload?sessionId=${sessionId}`, {
      method: "POST",
    }));
    expect(reloadResponse.status).toBe(409);
    expect(await reloadResponse.json()).toEqual({
      error: { message: `Session is not active: ${sessionId} (archived)` },
    });
    expect(mcp.scopeInputs).toEqual([]);

    expect(await client.listMcpServers({ sessionId })).toMatchObject({
      servers: [{ name: "github", status: "running" }],
    });
    expect(await client.mcpStatus({ sessionId })).toMatchObject({
      summary: { total: 1, running: 1 },
    });
    expect(await client.mcpServer({ server: "github", sessionId })).toMatchObject({
      name: "github",
      status: "running",
    });
    expect(await client.listMcpTools({ server: "github", sessionId })).toEqual({
      server: "github",
      tools: [{ name: "search_issues", description: "Search issues" }],
    });

    const canonicalWorkspace = await realpath(workspace);
    expect(mcp.scopeInputs).toEqual([
      { operation: "list", cwd: canonicalWorkspace },
      { operation: "list", cwd: canonicalWorkspace },
      { operation: "list", cwd: canonicalWorkspace },
      { operation: "tools", cwd: canonicalWorkspace },
    ]);

    const activeChildId = "session_mcp_active_child" as SessionId;
    const archivedChildId = "session_mcp_archived_child" as SessionId;
    for (const childId of [activeChildId, archivedChildId]) {
      await store.append({
        id: `event_${childId}_created`,
        type: "session.created",
        time: 3 as TimestampMs,
        sessionId: childId,
        payload: { sessionId: childId, cwd: workspaceAlias },
      });
      service.blockedSubagentSessions.add(childId);
    }
    await store.append({
      id: "event_session_mcp_archived_child_archived",
      type: "session.archived",
      time: 4 as TimestampMs,
      sessionId: archivedChildId,
      payload: { sessionId: archivedChildId },
    });

    for (const childId of [activeChildId, archivedChildId]) {
      const childQuery = `sessionId=${childId}`;
      for (const path of [
        `/mcp?${childQuery}`,
        `/mcp/status?${childQuery}`,
        `/mcp/github?${childQuery}`,
        `/mcp/github/tools?${childQuery}`,
      ]) {
        const response = await handler(new Request(`http://chili.test${path}`));
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: {
            message: expect.stringContaining(`Session ${childId} belongs to a subagent`),
          },
        });
      }
      const reload = await handler(new Request(
        `http://chili.test/mcp/reload?${childQuery}`,
        { method: "POST" },
      ));
      expect(reload.status).toBe(409);
      expect(await reload.json()).toEqual({
        error: {
          message: expect.stringContaining(`Session ${childId} belongs to a subagent`),
        },
      });
    }
    expect(mcp.scopeInputs).toHaveLength(4);
    expect(service.sessionOperationIds).toEqual([sessionId, activeChildId, archivedChildId]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("returns not implemented for MCP routes without runtime control", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });

  const response = await handler(new Request("http://chili.test/mcp"));

  expect(response.status).toBe(501);
  expect(await response.json()).toEqual({ error: { message: "No MCP control service is configured" } });
});

test("rejects malformed approval resolve payloads before the runtime resolver", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const calls: unknown[] = [];
  const handler = createRuntimeHttpHandler({
    service,
    store,
    approvals: {
      resolve(input: unknown) {
        calls.push(input);
        return true;
      },
    },
  });

  const cases = [
    { body: {}, message: "decision is required" },
    { body: { decision: "allow_forever" }, message: "decision must be one of allow_once, allow_session, allow_always, deny" },
    { body: { decision: "allow_once", feedback: 123 }, message: "feedback must be a string" },
    { body: { decision: "allow_once", scope: "session" }, message: "Unexpected field: scope" },
  ];

  for (const testCase of cases) {
    const response = await handler(
      new Request("http://chili.test/approvals/approval_http/resolve", {
        method: "POST",
        body: JSON.stringify(testCase.body),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: testCase.message } });
  }

  expect(calls).toEqual([]);
});

test("returns conflict when approval is not pending in the runtime queue", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const approvals = {
    resolve() {
      return false;
    },
  };
  const handler = createRuntimeHttpHandler({ service, store, approvals });

  const response = await handler(
    new Request("http://chili.test/approvals/approval_orphan/resolve", {
      method: "POST",
      body: JSON.stringify({ decision: "allow_once" }),
      headers: { "content-type": "application/json" },
    }),
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: {
      message: "Approval is not pending in this runtime. It may have been handled already or orphaned by a server restart.",
    },
  });
});

test("passes request cancellation through team run loop HTTP route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-http-team-abort-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  try {
    const session = await service.createSession({ cwd: "/repo" });
    const teams = new TeamControlService({
      store,
      createId: createSequentialId(),
      now: () => 10 as TimestampMs,
    });
    const team = await teams.createTeam({
      sessionId: session.sessionId,
      name: "abort",
      leadPath: "/root" as AgentPath,
    });
    const controller = new AbortController();
    const teamRunner = new AbortObservingTeamExecutionRunnerService(() => controller.abort());
    const handler = createRuntimeHttpHandler({ service, store, teams, teamRunner });

    const response = await handler(
      new Request(`http://chili.test/teams/${team.id}/run_loop`, {
        method: "POST",
        body: JSON.stringify({ once: true }),
        headers: { "content-type": "application/json" },
        signal: controller.signal,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ teamId: team.id, stopReason: "aborted" });
    expect(teamRunner.seenSignal).toBeInstanceOf(AbortSignal);
    expect(teamRunner.signalAbortedAfterAbort).toBe(true);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("serves model control routes and prompt model overrides", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });
  const session = await service.createSession();

  const modelsResponse = await handler(new Request("http://chili.test/models?provider=openai-codex"));
  expect(modelsResponse.status).toBe(200);
  expect(await modelsResponse.json()).toEqual([
    {
      provider: "openai-codex",
      model: "gpt-5.5",
      displayName: "GPT-5.5",
      connectionLabel: "ChatGPT OAuth",
      authSource: "oauth",
      endpoint: "https://chatgpt.com",
      capabilities: { reasoning: true },
    },
  ]);

  const setModelResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/model`, {
    method: "POST",
    body: JSON.stringify({
      modelSelection: { provider: "openai-codex", model: "gpt-5.6-terra" },
    }),
    headers: { "content-type": "application/json" },
  }));
  expect(setModelResponse.status).toBe(200);
  expect(service.modelSelection).toEqual({ provider: "openai-codex", model: "gpt-5.6-terra" });

  const setReasoningResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/reasoning`, {
    method: "POST",
    body: JSON.stringify({ reasoningLevel: "ultra" }),
    headers: { "content-type": "application/json" },
  }));
  expect(setReasoningResponse.status).toBe(200);
  expect(service.reasoningLevel).toBe("ultra");

  const setServiceTierResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/service-tier`, {
    method: "POST",
    body: JSON.stringify({ serviceTier: "fast" }),
    headers: { "content-type": "application/json" },
  }));
  expect(setServiceTierResponse.status).toBe(200);
  expect(service.serviceTier).toBe("fast");

  const delegationResponse = await handler(
    new Request(`http://chili.test/sessions/${session.sessionId}/delegation`),
  );
  expect(delegationResponse.status).toBe(200);
  expect(await delegationResponse.json()).toEqual({
    sessionId: session.sessionId,
    policy: "explicit",
    source: "default",
  });

  const setDelegationResponse = await handler(new Request(
    `http://chili.test/sessions/${session.sessionId}/delegation`,
    {
      method: "POST",
      body: JSON.stringify({ policy: "proactive" }),
      headers: { "content-type": "application/json" },
    },
  ));
  expect(setDelegationResponse.status).toBe(200);
  expect(service.delegationPolicy).toBe("proactive");
  expect(await setDelegationResponse.json()).toEqual({
    sessionId: session.sessionId,
    policy: "proactive",
    source: "session",
  });

  const promptResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      text: "hello",
      skillMentions: [{ name: "reviewer", path: "/repo/.chili/skills/reviewer/SKILL.md" }],
      modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
      reasoningLevel: "xhigh",
      serviceTier: "fast",
    }),
    headers: { "content-type": "application/json" },
  }));
  expect(promptResponse.status).toBe(202);
  expect(await promptResponse.json()).toEqual({ status: "accepted", sessionId: session.sessionId });
  expect(service.lastPrompt).toMatchObject({
    sessionId: session.sessionId,
    cwd: "/repo",
    skillMentions: [{ name: "reviewer", path: "/repo/.chili/skills/reviewer/SKILL.md" }],
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
    reasoningLevel: "xhigh",
    serviceTier: "fast",
  });

  const legacyPromptResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      text: "hello",
      system: ["old"],
    }),
    headers: { "content-type": "application/json" },
  }));
  expect(legacyPromptResponse.status).toBe(400);
  expect(await legacyPromptResponse.json()).toMatchObject({
    error: { message: "system is no longer supported in runtime prompt requests" },
  });
});

test("serves persistent goal control routes", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });
  const session = await service.createSession();

  const setResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/goal`, {
    method: "POST",
    body: JSON.stringify({
      objective: "Ship the goal route",
      tokenBudget: 50_000,
      replace: true,
    }),
    headers: { "content-type": "application/json" },
  }));
  expect(setResponse.status).toBe(201);
  expect(await setResponse.json()).toMatchObject({ objective: "Ship the goal route", status: "active" });

  const pauseResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/goal`, {
    method: "PATCH",
    body: JSON.stringify({ status: "paused" }),
    headers: { "content-type": "application/json" },
  }));
  expect(pauseResponse.status).toBe(200);
  expect(await pauseResponse.json()).toMatchObject({ status: "paused" });

  const getResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/goal`));
  expect(getResponse.status).toBe(200);
  expect(await getResponse.json()).toMatchObject({ objective: "Ship the goal route", status: "paused" });

  const clearResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/goal`, {
    method: "DELETE",
  }));
  expect(clearResponse.status).toBe(200);
  expect(await clearResponse.json()).toMatchObject({ cleared: true });
});

test("does not accept async prompts or commands for missing or busy sessions", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new BusyRuntimeService(store);
  const commands = new FakePromptCommandControl();
  const backgroundErrors: unknown[] = [];
  const handler = createRuntimeHttpHandler({
    service,
    store,
    commands,
    onBackgroundError: (error) => backgroundErrors.push(error),
  });

  for (const [action, body] of [
    ["prompt_async", { text: "hello" }],
    ["command_async", { commandId: "prompt.project.joke" }],
  ] as const) {
    const missingResponse = await handler(new Request(`http://chili.test/sessions/session_missing/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }));
    expect(missingResponse.status).toBe(404);
  }

  const created = await service.createSession();
  for (const [action, body] of [
    ["prompt_async", { text: "hello" }],
    ["command_async", { commandId: "prompt.project.joke" }],
  ] as const) {
    const busyResponse = await handler(new Request(`http://chili.test/sessions/${created.sessionId}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }));
    expect(busyResponse.status).toBe(409);
  }

  expect(service.accepted).toBe(false);
  expect(backgroundErrors).toEqual([]);
});

test("returns async prompt boundary failures before a 202 response", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new AsyncBoundaryFailureRuntimeService(store);
  const commands = new FakePromptCommandControl();
  const backgroundErrors: unknown[] = [];
  const handler = createRuntimeHttpHandler({
    service,
    store,
    commands,
    onBackgroundError: (error) => backgroundErrors.push(error),
  });
  const session = await service.createSession();

  for (const [action, body] of [
    ["prompt_async", { text: "hello" }],
    ["command_async", { commandId: "prompt.project.joke" }],
  ] as const) {
    const response = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { message: `Session is not active: ${session.sessionId} (archived)` },
    });
  }

  expect(backgroundErrors).toEqual([]);
});

test("does not return 202 when an async prompt claim loses a session boundary race", async () => {
  const cases = [
    {
      name: "archived",
      status: 409,
      createError: (sessionId: SessionId) => new RuntimeSessionInactiveError(sessionId, "archived"),
    },
    {
      name: "subagent",
      status: 409,
      createError: (sessionId: SessionId) => new RuntimeSubagentSessionAccessError(sessionId),
    },
    {
      name: "not-found",
      status: 404,
      createError: (sessionId: SessionId) => new RuntimeSessionNotFoundError(sessionId),
    },
  ];

  for (const item of cases) {
    const baseStore = new MemoryEventStore();
    const store = new ObservableEventStore(baseStore);
    const service = new FakeRuntimeService(store);
    const session = await service.createSession({
      sessionId: `session_http_async_claim_race_${item.name}` as SessionId,
    });
    service.submitPromptAsync = (input) => {
      throw item.createError(input.sessionId);
    };
    const handler = createRuntimeHttpHandler({ service, store });

    const response = await handler(
      new Request(`http://chili.test/sessions/${session.sessionId}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({ text: "race after preflight" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(item.status);
    expect((await response.json()) as { error?: { message?: string } }).toMatchObject({
      error: { message: item.createError(session.sessionId).message },
    });
  }
});

test("maps a runtime missing-session preflight to 404", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new MissingSessionRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });

  const response = await handler(
    new Request("http://chili.test/sessions/session_missing_preflight/prompt_async", {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
      headers: { "content-type": "application/json" },
    }),
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: { message: "Session not found: session_missing_preflight" },
  });
});

test("uses one canonical persisted workspace for prompt and command routes", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "chili-http-cwd-"));
  const workspace = join(fixture, "workspace");
  const workspaceAlias = join(fixture, "workspace-alias");
  const missingWorkspace = join(fixture, "missing-workspace");

  try {
    await mkdir(workspace);
    await symlink(workspace, workspaceAlias);
    const canonicalWorkspace = await realpath(workspace);

    const baseStore = new MemoryEventStore();
    const store = new ObservableEventStore(baseStore);
    const service = new FakeRuntimeService(store);
    const commands = new FakePromptCommandControl();
    const handler = createRuntimeHttpHandler({ service, store, commands });

    for (const cwd of [null, 42, "   "]) {
      const response = await handler(new Request("http://chili.test/sessions", {
        method: "POST",
        body: JSON.stringify({ cwd }),
        headers: { "content-type": "application/json" },
      }));
      expect(response.status).toBe(400);
    }

    const createResponse = await handler(new Request("http://chili.test/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd: workspaceAlias }),
      headers: { "content-type": "application/json" },
    }));
    expect(createResponse.status).toBe(201);
    const session = (await createResponse.json()) as RuntimeSessionRef;
    expect((await store.sessions())[0]?.cwd).toBe(canonicalWorkspace);

    const acceptedRoutes = [
      { action: "prompt", body: { text: "sync prompt" }, status: 200 },
      { action: "prompt_async", body: { text: "async prompt", cwd: workspaceAlias }, status: 202 },
      { action: "command", body: { commandId: "prompt.project.joke" }, status: 200 },
      { action: "command_async", body: { commandId: "prompt.project.joke", cwd: workspaceAlias }, status: 202 },
    ] as const;

    for (const requestCase of acceptedRoutes) {
      const response = await handler(new Request(
        `http://chili.test/sessions/${session.sessionId}/${requestCase.action}`,
        {
          method: "POST",
          body: JSON.stringify(requestCase.body),
          headers: { "content-type": "application/json" },
        },
      ));
      expect(response.status).toBe(requestCase.status);
      expect(service.lastPrompt?.cwd).toBe(canonicalWorkspace);
      if (requestCase.action.startsWith("command")) {
        expect(commands.lastRun?.cwd).toBe(canonicalWorkspace);
      }
    }

    for (const action of ["prompt", "prompt_async", "command", "command_async"] as const) {
      service.lastPrompt = undefined;
      commands.lastRun = undefined;
      const body = action.startsWith("command")
        ? { commandId: "prompt.project.joke", cwd: missingWorkspace }
        : { text: "wrong workspace", cwd: missingWorkspace };
      const response = await handler(new Request(
        `http://chili.test/sessions/${session.sessionId}/${action}`,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        },
      ));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringContaining("does not match the session workspace") },
      });
      expect(service.lastPrompt).toBeUndefined();
      expect(commands.lastRun).toBeUndefined();
    }

    for (const cwd of [null, 7, "\t "]) {
      for (const action of ["prompt", "prompt_async", "command", "command_async"] as const) {
        const body = action.startsWith("command")
          ? { commandId: "prompt.project.joke", cwd }
          : { text: "invalid workspace", cwd };
        const response = await handler(new Request(
          `http://chili.test/sessions/${session.sessionId}/${action}`,
          {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          },
        ));
        expect(response.status).toBe(400);
      }
    }

    await expect(access(missingWorkspace)).rejects.toThrow();
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
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
  modelSelection: ModelSelection | undefined;
  reasoningLevel: ReasoningLevel | undefined;
  serviceTier: ServiceTier | undefined;
  delegationPolicy: DelegationPolicy = "explicit";
  delegationSource: DelegationPolicySource = "default";
  lastPrompt: SubmitPromptInput | undefined;
  goal: SessionGoal | undefined;
  readonly blockedSubagentSessions = new Set<SessionId>();
  readonly busySessionOperations = new Set<SessionId>();
  readonly sessionOperationIds: SessionId[] = [];

  constructor(protected readonly store: EventStore & EventPublisher) {}

  async withSessionOperation<T>(
    sessionId: SessionId,
    fn: (operation: RuntimeSessionOperation) => Promise<T> | T,
  ): Promise<T> {
    this.sessionOperationIds.push(sessionId);
    const assertCurrent = (): void => {
      if (!this.busySessionOperations.has(sessionId)) return;
      const error = new Error(`Session is already running: ${sessionId}`);
      error.name = "RuntimeBusyError";
      throw error;
    };
    assertCurrent();
    const controller = new AbortController();
    const result = await fn({ signal: controller.signal, assertCurrent });
    assertCurrent();
    return result;
  }

  async assertSessionTurnAllowed(sessionId: SessionId): Promise<void> {
    await this.assertSessionReadAllowed(sessionId);
    const session = (await this.store.sessions()).find((candidate) => candidate.id === sessionId);
    if (session && session.status !== "active") {
      throw new RuntimeSessionInactiveError(sessionId, session.status);
    }
  }

  async assertSessionReadAllowed(sessionId: SessionId): Promise<void> {
    if (this.blockedSubagentSessions.has(sessionId)) {
      throw new RuntimeSubagentSessionAccessError(sessionId);
    }
  }

  async createSession(input: { sessionId?: SessionId; cwd?: string } = {}): Promise<RuntimeSessionRef> {
    const sessionId = input.sessionId ?? ("session_http" as SessionId);
    if ((await this.store.sessions()).some((candidate) => candidate.id === sessionId)) {
      throw new RuntimeSessionAlreadyExistsError(sessionId);
    }
    await this.store.append({
      id: "event_session_created",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: input.cwd ?? "/repo" },
    });
    return { sessionId };
  }

  async listModels(input: { provider?: string } = {}): Promise<RuntimeModelDescriptor[]> {
    const models: RuntimeModelDescriptor[] = [
      {
        provider: "openai-codex",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        connectionLabel: "ChatGPT OAuth",
        authSource: "oauth",
        endpoint: "https://chatgpt.com",
        capabilities: { reasoning: true },
      },
    ];
    return input.provider ? models.filter((model) => model.provider === input.provider) : models;
  }

  async getModelConfig(sessionId: SessionId): Promise<RuntimeModelConfig> {
    return {
      sessionId,
      availableReasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
      models: await this.listModels(),
      ...(this.modelSelection ? { modelSelection: this.modelSelection } : {}),
      ...(this.reasoningLevel ? { reasoningLevel: this.reasoningLevel } : {}),
      ...(this.serviceTier ? { serviceTier: this.serviceTier } : {}),
    };
  }

  async setModel(input: { sessionId: SessionId; modelSelection: ModelSelection }): Promise<RuntimeModelConfig> {
    this.modelSelection = input.modelSelection;
    return this.getModelConfig(input.sessionId);
  }

  async setReasoning(input: { sessionId: SessionId; reasoningLevel: ReasoningLevel }): Promise<RuntimeModelConfig> {
    this.reasoningLevel = input.reasoningLevel;
    return this.getModelConfig(input.sessionId);
  }

  async setServiceTier(input: { sessionId: SessionId; serviceTier: ServiceTier }): Promise<RuntimeModelConfig> {
    this.serviceTier = input.serviceTier;
    return this.getModelConfig(input.sessionId);
  }

  async getDelegationConfig(sessionId: SessionId): Promise<RuntimeDelegationConfig> {
    return {
      sessionId,
      policy: this.delegationPolicy,
      source: this.delegationSource,
    };
  }

  async setDelegationPolicy(input: { sessionId: SessionId; policy: DelegationPolicy }): Promise<RuntimeDelegationConfig> {
    this.delegationPolicy = input.policy;
    this.delegationSource = "session";
    return this.getDelegationConfig(input.sessionId);
  }

  async getGoal(input: { sessionId: SessionId }): Promise<SessionGoal | undefined> {
    return this.goal?.sessionId === input.sessionId ? this.goal : undefined;
  }

  async setGoal(input: { sessionId: SessionId; objective: string; tokenBudget?: number }): Promise<SessionGoal> {
    this.goal = {
      sessionId: input.sessionId,
      objective: input.objective,
      status: "active",
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 3 as TimestampMs,
      updatedAt: 3 as TimestampMs,
    };
    return this.goal;
  }

  async updateGoal(input: { sessionId: SessionId; status?: SessionGoalStatus }): Promise<SessionGoal> {
    if (!this.goal || this.goal.sessionId !== input.sessionId) throw new Error("No goal");
    this.goal = {
      ...this.goal,
      sessionId: input.sessionId,
      ...(input.status ? { status: input.status } : {}),
      updatedAt: 4 as TimestampMs,
    };
    return this.goal;
  }

  async clearGoal(input: { sessionId: SessionId }): Promise<{ cleared: boolean; previousGoal?: SessionGoal }> {
    if (!this.goal || this.goal.sessionId !== input.sessionId) return { cleared: false };
    const previousGoal = this.goal;
    this.goal = undefined;
    return { cleared: true, previousGoal };
  }

  async submitPrompt(input: SubmitPromptInput): Promise<Awaited<ReturnType<RuntimeHttpService["submitPrompt"]>>> {
    this.lastPrompt = input;
    return { status: "completed", turns: [], finishReason: "stop" };
  }

  submitPromptAsync(input: SubmitPromptInput): void {
    this.lastPrompt = input;
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

  async renameSession(sessionId: SessionId, title: string): Promise<void> {
    await this.store.append({
      id: "event_session_renamed",
      type: "session.renamed",
      time: 3 as TimestampMs,
      sessionId,
      payload: { sessionId, title },
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

class AsyncBoundaryFailureRuntimeService extends FakeRuntimeService {
  override submitPromptAsync(input: SubmitPromptInput): void {
    throw new RuntimeSessionInactiveError(input.sessionId, "archived");
  }
}

class MissingSessionRuntimeService extends FakeRuntimeService {
  override async assertSessionTurnAllowed(sessionId: SessionId): Promise<void> {
    throw new RuntimeSessionNotFoundError(sessionId);
  }
}

class FakePromptCommandControl implements PromptCommandControl {
  reloadCount = 0;
  listInputs: Array<{ cwd?: string }> = [];
  reloadInputs: Array<{ cwd?: string }> = [];
  lastRun: RuntimeCommandInvocation | undefined;

  async list(input: { cwd?: string } = {}): Promise<RuntimeCommandCatalog> {
    this.listInputs.push({ ...input });
    return promptCommandCatalog();
  }

  async reload(input: { cwd?: string } = {}): Promise<RuntimeCommandCatalog> {
    this.reloadInputs.push({ ...input });
    this.reloadCount += 1;
    return promptCommandCatalog();
  }

  async run(input: RuntimeCommandInvocation): Promise<PromptCommandRunResult> {
    this.lastRun = { ...input };
    if (input.commandId === "prompt.project.required") {
      throw new PromptCommandUsageError(input.commandId, "/prompt project required <input>");
    }
    if (input.commandId === "prompt.project.missing") {
      throw new PromptCommandNotFoundError(input.commandId);
    }
    return {
      prompt: `Tell a short joke about ${input.args ?? "coding"}.`,
      command: promptCommandCatalog().roots[0]!,
      metadata: {
        commandId: "prompt.project.joke",
        commandPath: "/joke",
        source: "project",
        allowedTools: ["read", "write"],
        writeScope: ["AGENTS.md"],
      },
    };
  }
}

class FakeMcpControlService implements RuntimeMcpControlService {
  added: Parameters<NonNullable<RuntimeMcpControlService["add"]>>[0] | undefined;
  authInput: Parameters<NonNullable<RuntimeMcpControlService["auth"]>>[1] | undefined;
  readonly scopeInputs: Array<{ operation: "list" | "reload" | "tools"; cwd?: string }> = [];

  async list(input: RuntimeMcpScopeInput = {}): Promise<Awaited<ReturnType<RuntimeMcpControlService["list"]>>> {
    this.scopeInputs.push({ operation: "list", ...input });
    return {
      servers: [mcpServer()],
    };
  }

  async reload(input: RuntimeMcpScopeInput = {}): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["reload"]>>>> {
    this.scopeInputs.push({ operation: "reload", ...input });
    return {
      reloaded: true,
      servers: [mcpServer()],
      errors: [],
    };
  }

  async add(input: Parameters<NonNullable<RuntimeMcpControlService["add"]>>[0]): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["add"]>>>> {
    this.added = input;
    const server: Awaited<ReturnType<NonNullable<RuntimeMcpControlService["add"]>>> = {
      name: input.name,
      status: input.enabled === false ? "disabled" : "running",
      enabled: input.enabled ?? true,
    };
    if (input.transport) server.transport = input.transport;
    if (input.command) server.command = input.command;
    if (input.args) server.args = input.args;
    if (input.url) server.url = input.url;
    return server;
  }

  async remove(server: string): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["remove"]>>>> {
    return { server, removed: true };
  }

  async tools(
    server: string,
    input: RuntimeMcpScopeInput = {},
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["tools"]>>>> {
    this.scopeInputs.push({ operation: "tools", ...input });
    return {
      server,
      tools: [{ name: "search_issues", description: "Search issues" }],
    };
  }

  async auth(
    server: string,
    input?: Parameters<NonNullable<RuntimeMcpControlService["auth"]>>[1],
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["auth"]>>>> {
    this.authInput = input;
    return {
      server,
      status: "pending",
      url: `https://auth.example/${server}`,
    };
  }

  async logout(server: string): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["logout"]>>>> {
    return { server, loggedOut: true };
  }
}

class FakeTaskControlService implements RuntimeTaskControlService {
  lastListStatus: string | undefined;
  lastFollowupText: string | undefined;
  lastFollowupSignal: AbortSignal | undefined;
  lastWaitSignal: AbortSignal | undefined;
  lastReconcile: unknown;

  async listTasks(query: { status?: string } = {}): Promise<AgentTaskRow[]> {
    this.lastListStatus = query.status;
    return [taskRow({ status: "running" })];
  }

  async getTask(): Promise<AgentTaskRow> {
    return taskRow({ status: "running" });
  }

  async followupTask(
    input: Parameters<RuntimeTaskControlService["followupTask"]>[0],
  ): Promise<Awaited<ReturnType<RuntimeTaskControlService["followupTask"]>>> {
    this.lastFollowupText = input.text;
    this.lastFollowupSignal = input.signal;
    return {
      task: taskRow({ status: "completed", summary: "done" }),
      result: {
        status: "completed",
        turns: [],
        finishReason: "stop",
      },
    };
  }

  async waitForTask(input: Parameters<RuntimeTaskControlService["waitForTask"]>[0]): Promise<AgentTaskRow> {
    this.lastWaitSignal = input.signal;
    return taskRow({ status: "completed", summary: "done" });
  }

  async closeTask(input: { status?: "completed" | "incomplete" | "failed" | "cancelled"; summary?: string }): Promise<AgentTaskRow> {
    const rowInput: { status: AgentTaskRow["status"]; summary?: string } = { status: input.status ?? "cancelled" };
    if (input.summary) rowInput.summary = input.summary;
    return taskRow(rowInput);
  }

  async reconcileStaleTasks(input = {}): Promise<{ scanned: number; closed: AgentTaskRow[] }> {
    this.lastReconcile = input;
    return { scanned: 1, closed: [taskRow({ status: "cancelled" })] };
  }
}

class AbortableFollowupTaskControlService extends FakeTaskControlService {
  readonly started = deferred<void>();

  override async followupTask(
    input: Parameters<RuntimeTaskControlService["followupTask"]>[0],
  ): Promise<Awaited<ReturnType<RuntimeTaskControlService["followupTask"]>>> {
    this.lastFollowupText = input.text;
    this.lastFollowupSignal = input.signal;
    this.started.resolve();
    if (input.signal?.aborted) throw abortError("Task follow-up aborted");
    return new Promise((_, reject) => {
      input.signal?.addEventListener(
        "abort",
        () => reject(abortError("Task follow-up aborted")),
        { once: true },
      );
    });
  }
}

class FakeAgentTreeService implements RuntimeAgentTreeService {
  consumedIds: string[] = [];
  runQueries: AgentRunQuery[] = [];
  mailboxQueries: AgentMailboxQuery[] = [];

  async snapshot(): Promise<AgentTreeSnapshot> {
    const root = agentRunRow({ id: "agent_http_root", path: "/root", taskName: "lead" });
    const child = agentRunRow({ id: "agent_http_child", path: "/root/task_http", parentPath: "/root", taskName: "review" });
    const mailbox = mailboxRow({ status: "queued" });
    return {
      rootPath: "/root" as AgentPath,
      agents: [root, child],
      tasks: [taskRow({ status: "running" })],
      mailbox: [mailbox],
      nodes: [
        {
          path: "/root" as AgentPath,
          taskName: "lead",
          status: "running",
          runIds: [root.id],
          runs: [root],
          tasks: [],
          mailbox: [],
          createdAt: 1,
          updatedAt: 1,
          children: [
            {
              path: "/root/task_http" as AgentPath,
              parentPath: "/root" as AgentPath,
              taskName: "review",
              status: "running",
              runIds: [child.id],
              runs: [child],
              tasks: [taskRow({ status: "running" })],
              mailbox: [mailbox],
              children: [],
              createdAt: 2,
              updatedAt: 2,
            },
          ],
        },
      ],
    };
  }

  async agentRuns(query: AgentRunQuery = {}): Promise<AgentRunRow[]> {
    this.runQueries.push(query);
    return [agentRunRow({ id: "agent_http_child", path: "/root/task_http", parentPath: "/root", taskName: "review" })];
  }

  async mailbox(query: AgentMailboxQuery = {}): Promise<AgentMailboxRow[]> {
    this.mailboxQueries.push(query);
    return [mailboxRow({ status: "queued" })];
  }

  async consumeMailbox(input: { messageId: string }): Promise<AgentMailboxRow> {
    this.consumedIds.push(input.messageId);
    return mailboxRow({ status: "consumed" });
  }
}

class FakeTeamDispatcherService implements RuntimeTeamDispatcherService {
  dispatchInputs: Array<Parameters<RuntimeTeamDispatcherService["dispatchTask"]>[0]> = [];
  syncInputs: Array<Parameters<RuntimeTeamDispatcherService["syncTask"]>[0]> = [];
  reconcileInputs: Array<NonNullable<Parameters<RuntimeTeamDispatcherService["reconcileTasks"]>[0]>> = [];
  nextDispatchResult: Awaited<ReturnType<RuntimeTeamDispatcherService["dispatchTask"]>> | undefined;

  async dispatchTask(
    input: Parameters<RuntimeTeamDispatcherService["dispatchTask"]>[0],
  ): Promise<Awaited<ReturnType<RuntimeTeamDispatcherService["dispatchTask"]>>> {
    this.dispatchInputs.push(input);
    if (this.nextDispatchResult) {
      const result = this.nextDispatchResult;
      this.nextDispatchResult = undefined;
      return result;
    }
    return {
      status: "running",
      teamTask: teamTaskRow({
        teamId: input.teamId,
        taskId: input.taskId,
        status: "in_progress",
        metadata: teamDispatchMetadata("running"),
      }),
      agentTask: localSubagentTaskRow({ status: "running" }),
    };
  }

  async syncTask(
    input: Parameters<RuntimeTeamDispatcherService["syncTask"]>[0],
  ): Promise<Awaited<ReturnType<RuntimeTeamDispatcherService["syncTask"]>>> {
    this.syncInputs.push(input);
    return {
      applied: true,
      teamTask: teamTaskRow({
        teamId: input.teamId,
        taskId: input.taskId,
        status: "completed",
        metadata: teamDispatchMetadata("completed", 102),
      }),
      agentTask: taskRow({ status: "completed", summary: "done" }),
    };
  }

  async reconcileTasks(
    input: NonNullable<Parameters<RuntimeTeamDispatcherService["reconcileTasks"]>[0]> = {},
  ): Promise<Awaited<ReturnType<RuntimeTeamDispatcherService["reconcileTasks"]>>> {
    this.reconcileInputs.push(input);
    return reconcileResultJson(input.teamId ?? ("team_http" as TeamId));
  }
}

class FakeTeamExecutionRunnerService implements RuntimeTeamExecutionRunnerService {
  runInputs: Array<Parameters<RuntimeTeamExecutionRunnerService["run"]>[0]> = [];

  async run(input: Parameters<RuntimeTeamExecutionRunnerService["run"]>[0]): Promise<Awaited<ReturnType<RuntimeTeamExecutionRunnerService["run"]>>> {
    this.runInputs.push(input);
    return teamRunLoopResultJson(input.teamId);
  }
}

class FakeTeamMergeService implements RuntimeTeamMergeService {
  mergeInputs: Array<Parameters<RuntimeTeamMergeService["mergeTeamTasks"]>[0]> = [];

  async mergeTeamTasks(
    input: Parameters<RuntimeTeamMergeService["mergeTeamTasks"]>[0],
  ): Promise<Awaited<ReturnType<RuntimeTeamMergeService["mergeTeamTasks"]>>> {
    this.mergeInputs.push(input);
    return teamMergeResultJson(input.teamId, input.taskId ?? ("task_http" as TaskId));
  }
}

class AbortObservingTeamExecutionRunnerService implements RuntimeTeamExecutionRunnerService {
  seenSignal: AbortSignal | undefined;
  signalAbortedAfterAbort = false;

  constructor(private readonly abortRequest: () => void) {}

  async run(input: Parameters<RuntimeTeamExecutionRunnerService["run"]>[0]): Promise<Awaited<ReturnType<RuntimeTeamExecutionRunnerService["run"]>>> {
    this.seenSignal = input.signal;
    this.abortRequest();
    this.signalAbortedAfterAbort = input.signal?.aborted ?? false;
    return {
      ...teamRunLoopResultJson(input.teamId),
      stopReason: this.signalAbortedAfterAbort ? "aborted" : "once",
    };
  }
}

function reconcileResultJson(teamId: TeamId): Awaited<ReturnType<RuntimeTeamDispatcherService["reconcileTasks"]>> {
  return {
    scanned: 2,
    synced: [
      {
        applied: true,
        teamTask: teamTaskRow({
          teamId,
          taskId: "task_http" as TaskId,
          status: "completed",
          metadata: teamDispatchMetadata("completed", 102),
        }),
        agentTask: taskRow({ status: "completed", summary: "done" }),
      },
    ],
    skipped: [
      {
        applied: false,
        reason: "agent_running",
        teamTask: teamTaskRow({
          teamId,
          taskId: "task_skip_http" as TaskId,
          status: "in_progress",
          metadata: teamDispatchMetadata("running"),
        }),
        agentTask: taskRow({ status: "running" }),
      },
    ],
    errors: [],
  };
}

function teamRunLoopResultJson(teamId: TeamId): Awaited<ReturnType<RuntimeTeamExecutionRunnerService["run"]>> {
  return {
    teamId,
    cycles: 1,
    stopReason: "once",
    startedAt: 100,
    endedAt: 110,
    maxConcurrentDispatches: 4,
    maxConcurrentVerifications: 2,
    dispatched: [
      {
        teamId,
        taskId: "task_http" as TaskId,
        ownerPath: "/root/reviewer" as AgentPath,
        agentTaskId: "task_agent_http" as TaskId,
        status: "running",
      },
    ],
    completed: [],
    accepted: [],
    reopened: [],
    merged: [],
    mergeFailed: [],
    mergeConflicted: [],
    mergeSkipped: [],
    failed: [],
    blocked: [],
    skipped: [],
    stillRunning: [
      {
        teamId,
        taskId: "task_http" as TaskId,
        ownerPath: "/root/reviewer" as AgentPath,
        agentTaskId: "task_agent_http" as TaskId,
        title: "HTTP team task",
      },
    ],
    errors: [],
  };
}

function teamMergeResultJson(teamId: TeamId, taskId: TaskId): Awaited<ReturnType<RuntimeTeamMergeService["mergeTeamTasks"]>> {
  return {
    scanned: 1,
    applied: [
      {
        status: "applied",
        teamTask: teamTaskRow({ teamId, taskId, status: "completed" }),
        diffSummary: { filesChanged: 1, paths: ["packages/core/src/team.ts"], truncatedPaths: false, diffBytes: 120 },
      },
    ],
    failed: [],
    conflicted: [],
    skipped: [],
    errors: [],
  };
}

function teamDispatchMetadata(agentStatus: "running" | "completed", syncedAt?: number): Record<string, unknown> {
  return {
    chiliTeamDispatch: {
      agentTaskId: "task_agent_http",
      agentPath: "/root/reviewer/task_agent_http",
      runId: "agent_http_dispatch",
      childSessionId: "session_child_dispatch",
      mode: "background",
      dispatchedAt: 101,
      agentStatus,
      ...(syncedAt === undefined ? {} : { syncedAt }),
    },
  };
}

function localSubagentTaskRow(input: { status: "running" | "completed" | "incomplete" | "failed" | "cancelled" }): {
  taskId: TaskId;
  runId: AgentRunId;
  path: AgentPath;
  parentPath: AgentPath;
  childSessionId: SessionId;
  status: "running" | "completed" | "incomplete" | "failed" | "cancelled";
} {
  return {
    taskId: "task_agent_http" as TaskId,
    runId: "agent_http_dispatch" as AgentRunId,
    path: "/root/reviewer/task_agent_http" as AgentPath,
    parentPath: "/root/reviewer" as AgentPath,
    childSessionId: "session_child_dispatch" as SessionId,
    status: input.status,
  };
}

function mcpServer() {
  return {
    name: "github",
    status: "running" as const,
    enabled: true,
    transport: "http" as const,
    url: "https://mcp.example/github",
    toolCount: 2,
    auth: {
      required: true,
      authenticated: true,
      provider: "github",
    },
  };
}

function teamTaskRow(input: {
  teamId: TeamId;
  taskId: TaskId;
  status: TeamTaskRow["status"];
  metadata?: Record<string, unknown>;
}): TeamTaskRow {
  const row: TeamTaskRow = {
    id: input.taskId,
    teamId: input.teamId,
    title: "HTTP team task",
    status: input.status,
    ownerPath: "/root/reviewer" as AgentPath,
    dependsOn: [],
    createdAt: 1,
    updatedAt: 2,
  };
  if (input.metadata) row.metadata = input.metadata;
  return row;
}

function taskRow(input: { status: AgentTaskRow["status"]; summary?: string }): AgentTaskRow {
  const row: AgentTaskRow = {
    id: "task_http" as TaskId,
    path: "/root/task_http" as AgentPath,
    taskName: "review",
    status: input.status,
    generation: 0,
    childSessionId: "session_child" as SessionId,
    createdAt: 1,
    updatedAt: 2,
  };
  if (input.summary) row.summary = input.summary;
  return row;
}

function agentRunRow(input: { id: string; path: string; parentPath?: string; taskName: string }): AgentRunRow {
  const row: AgentRunRow = {
    id: input.id as AgentRunId,
    path: input.path as AgentPath,
    taskName: input.taskName,
    status: "running",
    createdAt: 1,
  };
  if (input.parentPath) row.parentPath = input.parentPath as AgentPath;
  return row;
}

function mailboxRow(input: { status: AgentMailboxRow["status"] }): AgentMailboxRow {
  const row: AgentMailboxRow = {
    id: "event_mailbox",
    path: "/root/task_http" as AgentPath,
    fromPath: "/root" as AgentPath,
    triggerTurn: true,
    status: input.status,
    taskId: "task_http" as TaskId,
    recipientSessionId: "session_mailbox_recipient" as SessionId,
    createdAt: 3,
  };
  if (input.status === "consumed") row.consumedAt = 4;
  return row;
}

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}

async function collectEventStreamText(
  handler: (request: Request) => Promise<Response>,
  url: string,
): Promise<string> {
  const controller = new AbortController();
  const response = await handler(new Request(url, { signal: controller.signal }));
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("expected event stream body");
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const abortTimer = setTimeout(() => controller.abort(), 50);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
  } finally {
    clearTimeout(abortTimer);
    controller.abort();
    reader.releaseLock();
  }
  return chunks.join("") + decoder.decode();
}

function sseIds(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("id: "))
    .map((line) => line.slice("id: ".length));
}

function permissionConfig(profile: RuntimePermissionProfileId): RuntimePermissionConfig {
  return {
    profile,
    profiles: [
      { id: "default", label: "Default", description: "Default permissions", current: profile === "default" },
      { id: "auto-review", label: "Auto-review", description: "Auto-review permissions", current: profile === "auto-review", disabledReason: "disabled" },
      { id: "full-access", label: "Full Access", description: "Full access permissions", current: profile === "full-access" },
    ],
  };
}

function promptCommandCatalog(): RuntimeCommandCatalog {
  return {
    roots: [
      {
        id: "prompt.project.joke",
        name: "joke",
        path: "/joke",
        title: "Joke",
        description: "Tell a joke",
        group: "project",
        source: "project",
        argumentMode: "optional",
        argumentHint: "[topic]",
        selectionMode: "execute",
        concurrency: "allow",
        hidden: false,
        enabled: true,
        executionTarget: "prompt",
        children: [],
      },
    ],
    diagnostics: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve: (value?: T) => resolve(value as T),
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

async function seedCompletedHttpTask(store: SqliteEventStore, taskId: TaskId): Promise<void> {
  const sessionId = "session_http_parent" as SessionId;
  const childSessionId = "session_http_child" as SessionId;
  const path = `/root/${taskId}` as AgentPath;
  const runId = `agent_initial_${taskId}` as AgentRunId;
  await store.appendMany([
    {
      id: `event_created_${taskId}`,
      type: "agent.task_created",
      time: 1 as TimestampMs,
      sessionId,
      payload: {
        taskId,
        path,
        parentPath: "/root" as AgentPath,
        parentSessionId: sessionId,
        childSessionId,
        taskName: "queued worker",
        cwd: "/repo",
        prompt: "initial work",
        mode: "resumable",
      },
    },
    {
      id: `event_spawned_${taskId}`,
      type: "agent.spawned",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        runId,
        taskId,
        path,
        parentPath: "/root" as AgentPath,
        parentSessionId: sessionId,
        childSessionId,
        taskName: "queued worker",
        cwd: "/repo",
        mode: "resumable",
        generation: 1,
      },
    },
    {
      id: `event_completed_${taskId}`,
      type: "agent.completed",
      time: 3 as TimestampMs,
      sessionId,
      payload: {
        runId,
        taskId,
        path,
        status: "completed",
        generation: 1,
        summary: "initial answer",
      },
    },
  ]);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

class MemoryEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];
  readonly sessionRows = new Map<string, SessionRow>();
  readonly approvalRows: ApprovalRow[] = [];

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
      return;
    }
    if (event.type === "session.renamed") {
      const session = this.sessionRows.get(event.payload.sessionId);
      if (session) this.sessionRows.set(event.payload.sessionId, { ...session, title: event.payload.title, updatedAt: event.time });
      return;
    }
    if (event.type === "session.archived") {
      const session = this.sessionRows.get(event.payload.sessionId);
      if (session) this.sessionRows.set(event.payload.sessionId, { ...session, status: "archived", updatedAt: event.time });
    }
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    let events = this.items.filter((event) => {
      if (query.sessionId && event.sessionId !== query.sessionId) return false;
      if (query.type && event.type !== query.type) return false;
      return true;
    });
    if (query.afterEventId) {
      const cursorIndex = events.findIndex((event) => event.id === query.afterEventId);
      if (cursorIndex < 0) throw new UnknownEventCursorError(query.afterEventId);
      events = events.slice(cursorIndex + 1);
    }
    if (query.beforeEventId) {
      const cursorIndex = events.findIndex((event) => event.id === query.beforeEventId);
      if (cursorIndex < 0) throw new UnknownEventCursorError(query.beforeEventId);
      events = events.slice(0, cursorIndex);
    }
    const limit = query.limit ?? events.length;
    return query.tail && !query.afterEventId ? events.slice(-limit) : events.slice(0, limit);
  }

  async sessions(): Promise<SessionRow[]> {
    return [...this.sessionRows.values()];
  }

  async messages(): Promise<Message[]> {
    return [];
  }

  async pendingApprovals(sessionId?: SessionId, limit?: number): Promise<ApprovalRow[]> {
    const rows = sessionId
      ? this.approvalRows.filter((approval) => approval.sessionId === sessionId)
      : this.approvalRows;
    return rows.slice(0, limit ?? rows.length);
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

class DelayedEmitEventStore extends MemoryEventStore implements EventPublisher {
  private readonly listeners = new Set<(event: ChiliEvent) => void>();

  subscribe(listener: (event: ChiliEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ChiliEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
