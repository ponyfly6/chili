import { access, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { normalizePersistedError, PERSISTED_ERROR_LIMITS } from "@chili/protocol";
import {
  RuntimeSessionAlreadyExistsError,
  RuntimeSessionCreationConflictError,
  RuntimeSessionInactiveError,
  RuntimeForeignOwnerError,
  RuntimeSessionNotFoundError,
  RuntimeSessionAccessError,
  type RuntimeSessionOperation,
  type SubmitPromptInput,
} from "@chili/core";
import type {
  ApprovalRow,
  EventPublisher,
  EventQuery,
  EventStore,
  SessionRow,
} from "@chili/store";
import { ObservableEventStore, SqliteEventStore, UnknownEventCursorError } from "@chili/store";
import { HttpRuntimeClient, type RuntimeSessionEventWindow } from "@chili/sdk";
import type {
  AgentPath,
  ChiliEvent,
  RuntimeEvent,
  DelegationPolicy,
  DelegationPolicySource,
  EventEnvelope,
  Message,
  MessageId,
  PartId,
  ModelSelection,
  PendingUserInputRequest,
  ReasoningLevel,
  RuntimeModelConfig,
  RuntimeDelegationConfig,
  RuntimeModelDescriptor,
  RuntimePermissionConfig,
  RuntimePermissionProfileId,
  RuntimePermissionUpdateOptions,
  RuntimeCommandCatalog,
  RuntimeCommandInvocation,
  RuntimeSessionRef,
  ServiceTier,
  SessionId,
  TimestampMs,
  ToolCallId,
  TurnId,
  UserInputAnswers,
  UserInputId,
} from "@chili/protocol";
import type {
  RuntimeHttpService,
  RuntimeMcpControlService,
  RuntimeMcpScopeInput,
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

test("serves authenticated HTTPS with typed-array and Bun.file TLS credentials", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const certificate = readFileSync(new URL("./fixtures/localhost-test-cert.pem", import.meta.url));
  const server = startRuntimeHttpServer({
    service: new FakeRuntimeService(store), store, hostname: "0.0.0.0", authToken: "x".repeat(32),
    tls: {
      cert: new Uint8Array(certificate),
      key: Bun.file(new URL("./fixtures/localhost-test-key.pem", import.meta.url)),
    },
  });
  try {
    const url = server.url.replace("0.0.0.0", "127.0.0.1");
    expect(new URL(server.url).protocol).toBe("https:");
    const unauthorized = await fetch(`${url}health`, { tls: { rejectUnauthorized: false } });
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${url}health`, {
      headers: { authorization: `Bearer ${"x".repeat(32)}` },
      tls: { rejectUnauthorized: false },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  } finally {
    await server.close();
  }
});

test("rejects unsupported multiple TLS certificates without silently dropping SNI", () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const tls = {
    cert: readFileSync(new URL("./fixtures/localhost-test-cert.pem", import.meta.url)),
    key: readFileSync(new URL("./fixtures/localhost-test-key.pem", import.meta.url)),
  };
  expect(() => startRuntimeHttpServer({
    service: new FakeRuntimeService(store), store,
    tls: [tls, { ...tls, serverName: "secondary.test" }],
  })).toThrow("multiple TLS certificates");
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

test("request audit snapshots stay complete in storage while SSE and replay deliver a compact cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-http-request-audit-"));
  const baseStore = new SqliteEventStore(join(directory, "events.sqlite"));
  try {
    const store = new ObservableEventStore(baseStore);
    const service = new FakeRuntimeService(store);
    const { sessionId } = await service.createSession({ cwd: "/workspace" });
    const contentVersion = "prepared-content-version";
    const requestEvent: RuntimeEvent = {
      id: "event_request_snapshot", type: "model.request_prepared", time: 2 as TimestampMs, sessionId,
      payload: {
        turnId: "turn_request_snapshot" as TurnId, requestId: "request_snapshot", attempt: 1, contentVersion,
        request: {
          version: 1, purpose: "turn", contentVersion, sessionRevision: 1,
          system: ["REQUEST_AUDIT_CANARY" + "x".repeat(5_000_000)], developer: [], contextualUser: [],
          messages: [], tools: [], sources: [], budget: {},
        },
      },
    };
    await store.append(requestEvent);
    const handler = createRuntimeHttpHandler({ service, store, maxEventStreamDurableEvents: 2 });
    const client = new HttpRuntimeClient({
      baseUrl: "http://chili.test/",
      fetch: ((input, init) => handler(new Request(input, init))) as typeof fetch,
    });
    const streamed: ChiliEvent[] = [];
    for await (const event of client.streamEvents({ sessionId })) streamed.push(event);
    expect(streamed.map((event) => event.id)).toContain(requestEvent.id);
    expect(streamed.find((event) => event.id === requestEvent.id)?.payload).toEqual({
      turnId: "turn_request_snapshot" as TurnId, requestId: "request_snapshot", attempt: 1, contentVersion,
    });
    const replay = await handler(new Request(`http://chili.test/sessions/${sessionId}/events?window=replayable`));
    const body = await replay.text();
    expect(body).not.toContain("REQUEST_AUDIT_CANARY");
    expect(body.length).toBeLessThan(8_000);
    const window = JSON.parse(body) as RuntimeSessionEventWindow;
    expect(window.truncated).toBe(false);
    expect(window.events.find((event) => event.id === requestEvent.id)).toEqual(streamed.find((event) => event.id === requestEvent.id));
    expect((await store.events({ sessionId, type: "model.request_prepared" }))[0]?.payload).toEqual(requestEvent.payload);

    const messageId = "message_program_result" as MessageId;
    await store.append({ id: "event_program_message", type: "message.created", sessionId, time: 3 as TimestampMs,
      payload: { messageId, role: "assistant" } });
    const resultEvent: RuntimeEvent = { id: "event_program_result", type: "message.part_added", sessionId, time: 4 as TimestampMs,
      payload: { messageId, part: {
        id: "part_program_result" as PartId, messageId, sessionId, type: "tool_result", callId: "call_program" as ToolCallId,
        output: "Concise model and display output", structuredData: { internal: "PROGRAM_DATA_CANARY", rows: [1, 2, 3] },
      } } };
    await store.append(resultEvent);
    const messages = await handler(new Request(`http://chili.test/sessions/${sessionId}/messages`));
    const messageText = await messages.text();
    expect(messageText).toContain("Concise model and display output");
    expect(messageText).not.toContain("PROGRAM_DATA_CANARY");
    const streamedResult: ChiliEvent[] = [];
    for await (const event of client.streamEvents({ sessionId, afterEventId: requestEvent.id })) streamedResult.push(event);
    expect(JSON.stringify(streamedResult)).not.toContain("PROGRAM_DATA_CANARY");
    expect((await store.messages(sessionId))[0]?.parts[0]).toMatchObject({ structuredData: { internal: "PROGRAM_DATA_CANARY", rows: [1, 2, 3] } });
  } finally {
    baseStore.close();
    await rm(directory, { recursive: true, force: true });
  }
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
  const event: RuntimeEvent = {
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
  } as RuntimeEvent);
  baseStore.items.push({
    id: "event_sse_after_oversized",
    type: "session.renamed",
    time: 2 as TimestampMs,
    sessionId,
    payload: { sessionId, title: "after poison" },
  } as RuntimeEvent);
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

test("SSE streams SQLite byte pages and resyncs oversized rows even without metadata acceleration", async () => {
  const baseStore = new SqliteEventStore(":memory:");
  const observable = new ObservableEventStore(baseStore);
  const sessionId = "session_sse_byte_pages" as SessionId;
  const store: EventStore & EventPublisher = {
    append: observable.append.bind(observable), appendMany: observable.appendMany.bind(observable),
    events: observable.events.bind(observable), sessions: observable.sessions.bind(observable),
    messages: observable.messages.bind(observable), pendingApprovals: observable.pendingApprovals.bind(observable),
    subscribe: observable.subscribe.bind(observable),
  };
  const small = Array.from({ length: 12 }, (_, index) => sseStatusEvent(sessionId, index));
  try {
    await store.appendMany([
      ...small,
      { id: "event_large_legal", type: "session.renamed", time: 20 as TimestampMs, sessionId, payload: { sessionId, title: "x".repeat(300_000) } },
      { id: "event_large_poison", type: "session.renamed", time: 21 as TimestampMs, sessionId, payload: { sessionId, title: "x".repeat(4_100_000) } },
    ]);
    const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store, maxEventStreamPageBytes: 1_024 });
    const reader = (await handler(new Request(`http://chili.test/events?sessionId=${sessionId}`))).body!.getReader();
    const received: string[] = [];
    for (let index = 0; index < small.length + 1; index += 1) {
      received.push(...sseIds(new TextDecoder().decode((await reader.read()).value)));
    }
    expect(received).toEqual([...small.map((event) => event.id), "event_large_legal"]);
    const recovery = new TextDecoder().decode((await reader.read()).value);
    expect(recovery).toContain("event: chili.resync");
    expect(recovery).toContain('"afterEventId":"event_large_poison"');
    expect((await reader.read()).done).toBe(true);
  } finally {
    baseStore.close();
  }
});

test("streams and resumes a worst legal tool result that remains replayable beside a near-limit approval window", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const sessionId = "session_sse_legal_tool_result" as SessionId;
  const messageId = "message_sse_legal_tool_result";
  const sessionCreated: RuntimeEvent = {
    id: "event_sse_legal_session_created",
    type: "session.created",
    time: 0 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd: "/repo" },
  };
  const created: RuntimeEvent = {
    id: "event_sse_legal_message_created",
    type: "message.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { messageId: messageId as never, role: "assistant" },
  };
  const escapedArtifactId = "\\\"".repeat(256);
  const partAdded: RuntimeEvent = {
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

test("normalizes hostile service errors at the HTTP boundary", async () => {
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
  service.getModelConfig = async () => { throw hostileError("RuntimeSessionNotFoundError"); };
  const handler = createRuntimeHttpHandler({ service, store });
  const requests = [
    handler(new Request(`http://chili.test/sessions/${sessionId}/model`)),
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

test("returns conflicts for foreign execution owners", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const service = new FakeRuntimeService(store);
  const { sessionId } = await service.createSession({ cwd: "/workspace" });
  const handler = createRuntimeHttpHandler({ service, store });
  const error = new RuntimeForeignOwnerError(sessionId);
  service.assertSessionTurnAllowed = async () => { throw error; };
  const response = await handler(new Request(`http://chili.test/sessions/${sessionId}/prompt`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Continue" }),
  }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: { message: error.message } });
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

test("rejects unknown event query parameters", async () => {
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
  await baseStore.appendMany(Array.from({ length: 6_000 }, (_, index): RuntimeEvent => ({
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
  ] as RuntimeEvent[]);
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
    ...Array.from({ length: 40 }, (_, index): RuntimeEvent => ({
      id: `event_approval_flood_${index}`,
      type: "session.renamed",
      time: (4 + index) as TimestampMs,
      sessionId,
      payload: { sessionId, title: `flood-${index}` },
    })),
  ] as RuntimeEvent[]);
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
    ...Array.from({ length: 100 }, (_, index): RuntimeEvent => ({
      id: `event_active_flood_${index}`,
      type: "session.renamed",
      time: (3 + index) as TimestampMs,
      sessionId,
      payload: { sessionId, title: `child-flood-${index}` },
    })),
    {
      id: "event_active_tool_tail",
      type: "tool.call_updated",
      time: 104 as TimestampMs,
      sessionId,
      payload: { callId: "call_active", status: "running" },
    },
  ] as RuntimeEvent[]);
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
      ...Array.from({ length: 5 }, (_, index): RuntimeEvent => ({
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
        message: "Event backlog exceeds the 5-event replay limit. Restore /events/snapshot, then resume from its cursor.",
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
  const event: RuntimeEvent = {
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

test("SSE cursor excludes an extremely late emit after many live events", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_lifetime_dedupe" as SessionId;
  const committed: RuntimeEvent = {
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
    const event: RuntimeEvent = {
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

test("SSE streams beyond the former 4096-event boundary and remains live", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_unlimited" as SessionId;
  const events = Array.from({ length: 4_200 }, (_, index) => sseStatusEvent(sessionId, index));
  store.items.push(...events);
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });
  const response = await handler(new Request(`http://chili.test/events?sessionId=${sessionId}`));
  const reader = response.body!.getReader();
  try {
    const ids: string[] = [];
    for (let index = 0; index < events.length; index += 1) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      ids.push(...sseIds(new TextDecoder().decode(chunk.value)));
    }
    expect(ids).toEqual(events.map((event) => event.id));
    store.emit(events[0]!);
    const next = sseStatusEvent(sessionId, 4_200);
    store.items.push(next);
    store.emit(next);
    expect(sseIds(new TextDecoder().decode((await reader.read()).value))).toEqual([next.id]);
  } finally {
    await reader.cancel();
  }
});

test("SSE polls committed rows without notifications and catches up before a live delta", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_poll" as SessionId;
  const handler = createRuntimeHttpHandler({
    service: new FakeRuntimeService(store), store, eventStreamPollIntervalMs: 5,
  });
  const response = await handler(new Request(`http://chili.test/events?sessionId=${sessionId}`));
  const reader = response.body!.getReader();
  try {
    const unannounced = sseStatusEvent(sessionId, 0);
    store.items.push(unannounced);
    expect(sseIds(new TextDecoder().decode((await reader.read()).value))).toEqual([unannounced.id]);
    const anchor: RuntimeEvent = {
      id: "event_poll_anchor", type: "tool.call_started", time: 2 as TimestampMs, sessionId,
      payload: { turnId: "turn_poll" as TurnId, callId: "call_poll" as ToolCallId, toolName: "shell", input: {} },
    };
    store.items.push(anchor);
    store.emit(sseOutputEvent(sessionId, 1, "call_poll"));
    expect(sseIds(new TextDecoder().decode((await reader.read()).value))).toEqual([anchor.id]);
    const delta = new TextDecoder().decode((await reader.read()).value);
    expect(delta).toContain("tool.output_delta");
    expect(sseIds(delta)).toEqual([]);
  } finally {
    await reader.cancel();
  }
});

test("SSE orders replay-time writes and delayed notifications before their transient output", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_handoff" as SessionId;
  const initial = sseStatusEvent(sessionId, 0);
  store.items.push(initial);
  const entered = deferred<void>();
  const release = deferred<void>();
  const originalEvents = store.events.bind(store);
  let first = true;
  store.events = async (query = {}) => {
    const rows = await originalEvents(query);
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return rows;
  };
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });
  const responsePromise = handler(new Request(`http://chili.test/events?sessionId=${sessionId}`));
  await entered.promise;
  const anchor: RuntimeEvent = {
    id: "event_handoff_anchor", type: "tool.call_started", time: 2 as TimestampMs, sessionId,
    payload: { turnId: "turn_handoff" as TurnId, callId: "call_handoff" as ToolCallId, toolName: "shell", input: {} },
  };
  store.items.push(anchor);
  store.emit(sseOutputEvent(sessionId, 1, "call_handoff"));
  store.emit(initial);
  release.resolve();
  const reader = (await responsePromise).body!.getReader();
  try {
    const chunks = [];
    for (let index = 0; index < 3; index += 1) chunks.push(new TextDecoder().decode((await reader.read()).value));
    expect(sseIds(chunks.join(""))).toEqual([initial.id, anchor.id]);
    expect(chunks[2]).toContain("tool.output_delta");
  } finally {
    await reader.cancel();
  }
});

test("SSE resumes from the client-consumed cursor rather than the server enqueue position", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_partial" as SessionId;
  const events = Array.from({ length: 120 }, (_, index) => sseStatusEvent(sessionId, index));
  store.items.push(...events);
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store, maxEventStreamBufferedBytes: 4_096 });
  const first = (await handler(new Request(`http://chili.test/events?sessionId=${sessionId}`))).body!.getReader();
  const consumed: string[] = [];
  for (let index = 0; index < 3; index += 1) consumed.push(...sseIds(new TextDecoder().decode((await first.read()).value)));
  await first.cancel();
  const resumed = (await handler(new Request(
    `http://chili.test/events?sessionId=${sessionId}&afterEventId=${consumed.at(-1)}`,
  ))).body!.getReader();
  try {
    for (let index = consumed.length; index < events.length; index += 1) {
      consumed.push(...sseIds(new TextDecoder().decode((await resumed.read()).value)));
    }
    expect(consumed).toEqual(events.map((event) => event.id));
  } finally {
    await resumed.cancel();
  }
});

test("SSE pauses database reads under byte backpressure and resumes when pulled", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_pressure" as SessionId;
  store.items.push(...Array.from({ length: 200 }, (_, index) => sseStatusEvent(sessionId, index)));
  const originalEvents = store.events.bind(store);
  let queries = 0;
  store.events = async (query = {}) => { queries += 1; return originalEvents(query); };
  const handler = createRuntimeHttpHandler({
    service: new FakeRuntimeService(store), store,
    maxEventStreamBufferedBytes: 1_024, eventStreamPollIntervalMs: 5,
  });
  const reader = (await handler(new Request(`http://chili.test/events?sessionId=${sessionId}`))).body!.getReader();
  try {
    await new Promise((resolve) => setTimeout(resolve, 15));
    const blockedQueries = queries;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(queries).toBe(blockedQueries);
    for (let index = 0; index < 80; index += 1) expect((await reader.read()).done).toBe(false);
    expect(queries).toBeGreaterThan(blockedQueries);
  } finally {
    await reader.cancel();
  }
});

test("SSE drops queued bytes and subscriptions when a slow consumer times out", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_stall" as SessionId;
  store.items.push(...Array.from({ length: 100 }, (_, index) => sseStatusEvent(sessionId, index)));
  const handler = createRuntimeHttpHandler({
    service: new FakeRuntimeService(store), store,
    maxEventStreamBufferedBytes: 1_024, eventStreamStallTimeoutMs: 15,
  });
  const reader = (await handler(new Request(`http://chili.test/events?sessionId=${sessionId}`))).body!.getReader();
  expect(store.listenerCount).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(store.listenerCount).toBe(0);
  await expect(reader.read()).rejects.toThrow("buffer stall timeout");
});

test("HTTP socket backpressure stops SSE reads while a fast connection continues", async () => {
  const store = new GeneratedTransportEventStore();
  const server = startRuntimeHttpServer({
    service: new FakeRuntimeService(store), store,
    maxBacklogEvents: 50_000,
    maxEventStreamBufferedBytes: 32_768,
    maxEventStreamPageBytes: 32_768,
    eventStreamPollIntervalMs: 5,
    eventStreamStallTimeoutMs: 400,
  });
  const address = new URL(server.url);
  const socket = connectTcp({ host: "127.0.0.1", port: Number(address.port) });
  socket.on("error", () => {});
  const fastAbort = new AbortController();
  try {
    await once(socket, "connect");
    socket.pause();
    socket.write(`GET /events?sessionId=session_transport_slow HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: close\r\n\r\n`);
    await waitUntil(() => (store.produced.get("session_transport_slow") ?? 0) > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paused = store.produced.get("session_transport_slow")!;
    expect(paused).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.produced.get("session_transport_slow")).toBe(paused);

    const response = await fetch(`${server.url}events?sessionId=session_transport_fast`, { signal: fastAbort.signal });
    const reader = response.body!.getReader();
    let text = "";
    while (sseIds(text).length < GeneratedTransportEventStore.fastCount) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      text += new TextDecoder().decode(chunk.value);
    }
    expect(sseIds(text)).toEqual(Array.from({ length: GeneratedTransportEventStore.fastCount }, (_, index) => `transport_${index}`));
    await reader.cancel();
    fastAbort.abort();
    await waitUntil(() => store.listenerCount === 0, 2_000);
    expect(store.produced.get("session_transport_slow")).toBe(paused);
  } finally {
    fastAbort.abort();
    socket.destroy();
    await server.close();
  }
});

test("SSE bounds transient notifications even while initial replay is blocked", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_transient_pressure" as SessionId;
  const entered = deferred<void>();
  const release = deferred<void>();
  store.events = async () => { entered.resolve(); await release.promise; return []; };
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store, maxEventStreamTransientBytes: 1_024 });
  const pending = handler(new Request(`http://chili.test/events?sessionId=${sessionId}`));
  await entered.promise;
  for (let index = 0; index < 100; index += 1) store.emit(sseOutputEvent(sessionId, index, "call_buffer"));
  expect(store.listenerCount).toBe(0);
  release.resolve();
  const reader = (await pending).body!.getReader();
  const chunk = await reader.read();
  const text = new TextDecoder().decode(chunk.value);
  expect(chunk.value!.byteLength).toBeLessThan(4_096);
  expect(text).toContain("event: chili.resync");
  expect(text).toContain("transient_buffer_overflow");
  expect(text).not.toContain("tool.output_delta");
  expect((await reader.read()).done).toBe(true);
});

test("SSE fromStart rejects an oversized empty-snapshot catchup instead of silently tailing", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_from_start" as SessionId;
  store.items.push(...Array.from({ length: 4 }, (_, index) => sseStatusEvent(sessionId, index)));
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store, maxBacklogEvents: 3 });
  expect((await handler(new Request(`http://chili.test/events?sessionId=${sessionId}&fromStart=true`))).status).toBe(409);
  expect((await handler(new Request(`http://chili.test/events?fromStart=true&afterEventId=event`))).status).toBe(400);
  expect((await handler(new Request("http://chili.test/events?fromStart=false"))).status).toBe(400);
});

test("SSE rotates at a durable cursor and resumes without loss or late-emit duplicates", async () => {
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_rotation" as SessionId;
  const events = Array.from({ length: 4 }, (_, index): RuntimeEvent => ({
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

test("default SSE remains live past the former five-minute rotation deadline", async () => {
  const originalTimeout = globalThis.setTimeout;
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => (
    originalTimeout(callback, delay !== undefined && delay >= 300_000 ? 5 : delay, ...args)
  )) as typeof setTimeout);
  const store = new DelayedEmitEventStore();
  const sessionId = "session_sse_no_age_rotation" as SessionId;
  const initial = sseStatusEvent(sessionId, 0);
  store.items.push(initial);
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });
  const reader = (await handler(new Request(`http://chili.test/events?sessionId=${sessionId}`))).body!.getReader();
  try {
    expect(sseIds(new TextDecoder().decode((await reader.read()).value))).toEqual([initial.id]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fresh = sseStatusEvent(sessionId, 1);
    store.items.push(fresh);
    store.emit(fresh);
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(sseIds(new TextDecoder().decode(chunk.value))).toEqual([fresh.id]);
  } finally {
    await reader.cancel();
    timers.mockRestore();
  }
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

test("gets and updates both permission modes and custom review settings", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const service = new FakeRuntimeService(store);
  let config = permissionConfig("auto-review");
  const permissions = {
    get: () => config,
    async set(profile: RuntimePermissionProfileId, options: RuntimePermissionUpdateOptions = {}) {
      config = { ...config, profile, profiles: permissionConfig(profile).profiles };
      if (options.reviewInstructions !== undefined) config.reviewInstructions = options.reviewInstructions;
      if (options.reviewerModel === null) delete config.reviewerModel;
      else if (options.reviewerModel !== undefined) config.reviewerModel = options.reviewerModel;
      return config;
    },
  };
  const handler = createRuntimeHttpHandler({ service, store, permissions });
  const initial = await handler(new Request("http://chili.test/permissions"));
  expect(initial.status).toBe(200);
  expect(await initial.json()).toEqual(permissionConfig("auto-review"));

  for (const profile of ["full-access", "auto-review"] as const) {
    const response = await handler(new Request("http://chili.test/permissions", {
      method: "POST",
      body: JSON.stringify({ profile, reviewInstructions: "Review irreversible changes.", reviewerModel: { provider: "test", model: "reviewer" } }),
      headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ profile, reviewInstructions: "Review irreversible changes.", reviewerModel: { provider: "test", model: "reviewer" } });
  }

  const reset = await handler(new Request("http://chili.test/permissions", {
    method: "POST", body: JSON.stringify({ profile: "auto-review", reviewerModel: null }),
    headers: { "content-type": "application/json" },
  }));
  expect(reset.status).toBe(200);
  expect(await reset.json()).not.toHaveProperty("reviewerModel");
});

test("permission updates reject old modes, grants, and malformed review settings", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const service = new FakeRuntimeService(store);
  const calls: unknown[] = [];
  const handler = createRuntimeHttpHandler({ service, store, permissions: {
    get: () => permissionConfig("auto-review"),
    set(profile, options) { calls.push({ profile, options }); return permissionConfig(profile); },
  } });
  for (const body of [
    { profile: "default" }, { profile: "unsafe" }, {},
    { profile: "auto-review", reviewInstructions: 123 },
    { profile: "auto-review", reviewInstructions: "" },
    { profile: "auto-review", reviewInstructions: " \n " },
    { profile: "auto-review", reviewInstructions: "a".repeat(32_001) },
    { profile: "auto-review", reviewerModel: [] },
    { profile: "auto-review", reviewerModel: { provider: "test" } },
    { profile: "auto-review", reviewerModel: { provider: "test", model: "reviewer", extra: true } },
    { profile: "full-access", rules: [{ action: "allow" }] },
    { profile: "auto-review", reviewInstructions: null },
  ]) {
    const response = await handler(new Request("http://chili.test/permissions", {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(400);
  }
  expect(calls).toEqual([]);
});

test("manual approval mutation endpoint is retired", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });
  for (const decision of ["allow_once", "allow_session", "allow_always", "deny"]) {
    const response = await handler(new Request("http://chili.test/approvals/approval_old/resolve", {
      method: "POST", body: JSON.stringify({ decision }), headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(404);
  }
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

test("rejects invalid command options before rendering a prompt or mutating the session", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const service = new FakeRuntimeService(store);
  const commands = new FakePromptCommandControl();
  const handler = createRuntimeHttpHandler({ service, store, commands });
  const session = await service.createSession({ cwd: "/persisted/project" });
  const invalidOptions = [
    { modelSelection: { provider: "openai-codex" } },
    { modelSelection: null },
    { reasoningLevel: "unknown" },
    { reasoningLevel: "" },
    { serviceTier: "unknown" },
    { serviceTier: false },
    { output: "must not invoke MCP" },
    { toolPolicy: { allowedTools: ["bash"] } },
    { displayText: "forged invocation" },
  ];

  for (const action of ["command", "command_async"]) {
    for (const options of invalidOptions) {
      const response = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: "prompt.project.joke", ...options }),
      }));
      expect(response.status).toBe(400);
      expect(commands.lastRun).toBeUndefined();
      expect(service.lastPrompt).toBeUndefined();
    }
  }
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

test("rejects direct HTTP prompts, commands, controls, and lifecycle mutations for sessions outside the runtime access scope", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const commands = new FakePromptCommandControl();
  const handler = createRuntimeHttpHandler({ service, store, commands });
  const session = await service.createSession({
    sessionId: "session_http_child" as SessionId,
  });
  service.blockedSessionAccess.add(session.sessionId);

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
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("Session identity is not admitted by this runtime") },
    });
  }
  expect(service.lastPrompt).toBeUndefined();
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
  service.blockedSessionAccess.add(sessionId);

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
  ];

  expect(await store.sessions()).toEqual([]);
  for (const request of requests) {
    const response = await handler(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining("Session identity is not admitted by this runtime") },
    });
  }
  expect(service.lastPrompt).toBeUndefined();
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
    expect((await handler(new Request(`http://chili.test/mcp/github/connect?${query}`, { method: "POST" }))).status).toBe(200);
    expect((await handler(new Request(`http://chili.test/mcp/github/disconnect?${query}`, { method: "POST" }))).status).toBe(200);
    expect((await handler(new Request(`http://chili.test/mcp/github/auth?${query}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }))).status).toBe(200);
    expect((await handler(new Request(`http://chili.test/mcp/github/logout?${query}`, { method: "POST" }))).status).toBe(200);

    const canonicalWorkspace = await realpath(workspace);
    expect(mcp.scopeInputs).toEqual([
      { operation: "list", cwd: canonicalWorkspace },
      { operation: "list", cwd: canonicalWorkspace },
      { operation: "list", cwd: canonicalWorkspace },
      { operation: "tools", cwd: canonicalWorkspace },
      { operation: "reload", cwd: canonicalWorkspace },
      { operation: "connect", cwd: canonicalWorkspace },
      { operation: "disconnect", cwd: canonicalWorkspace },
      { operation: "auth", cwd: canonicalWorkspace },
      { operation: "logout", cwd: canonicalWorkspace },
    ]);
    expect(service.sessionOperationIds).toEqual([sessionId, sessionId, sessionId, sessionId, sessionId]);

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

test("keeps archived MCP reads project-scoped while connection mutations remain active-only", async () => {
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

    for (const action of ["connect", "disconnect", "auth", "logout"]) {
      const response = await handler(new Request(`http://chili.test/mcp/github/${action}?sessionId=${sessionId}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
      expect(response.status).toBe(409);
    }
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
      service.blockedSessionAccess.add(childId);
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
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: {
            message: expect.stringContaining(`Session identity is not admitted by this runtime: ${childId}`),
          },
        });
      }
      for (const path of ["reload", "github/connect", "github/disconnect"]) {
        const response = await handler(new Request(`http://chili.test/mcp/${path}?${childQuery}`, { method: "POST" }));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: { message: expect.stringContaining(`Session identity is not admitted by this runtime: ${childId}`) },
        });
      }
    }
    expect(mcp.scopeInputs).toHaveLength(4);
    expect(service.sessionOperationIds).toEqual([
      sessionId, sessionId, sessionId, sessionId, sessionId,
      activeChildId, activeChildId, activeChildId,
      archivedChildId, archivedChildId, archivedChildId,
    ]);
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

test("removed Goal endpoints return 404 for every method", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });
  const { sessionId } = await service.createSession();

  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    const response = await handler(new Request(`http://chili.test/sessions/${sessionId}/goal`, { method }));
    expect(response.status).toBe(404);
  }
  expect(service.lastPrompt).toBeUndefined();
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
      name: "forbidden",
      status: 403,
      createError: (sessionId: SessionId) => new RuntimeSessionAccessError(sessionId),
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

test("SSE never subscribes or queries an already-cancelled request", async () => {
  const store = new CountingEventStore();
  let queries = 0;
  store.events = async () => { queries += 1; return []; };
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });
  const controller = new AbortController();
  controller.abort();
  const response = await handler(new Request("http://chili.test/events", { signal: controller.signal }));
  expect(store.listenerCount).toBe(0);
  expect(queries).toBe(0);
  expect((await response.body!.getReader().read()).done).toBe(true);
});

class FakeRuntimeService implements RuntimeHttpService {
  modelSelection: ModelSelection | undefined;
  reasoningLevel: ReasoningLevel | undefined;
  serviceTier: ServiceTier | undefined;
  delegationPolicy: DelegationPolicy = "explicit";
  delegationSource: DelegationPolicySource = "default";
  lastPrompt: SubmitPromptInput | undefined;
  readonly blockedSessionAccess = new Set<SessionId>();
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
    if (this.blockedSessionAccess.has(sessionId)) {
      throw new RuntimeSessionAccessError(sessionId);
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

  async submitPrompt(input: SubmitPromptInput): Promise<Awaited<ReturnType<RuntimeHttpService["submitPrompt"]>>> {
    this.lastPrompt = input;
    return { status: "completed", turns: [], finishReason: "stop" };
  }

  submitPromptAsync(input: SubmitPromptInput): void {
    this.lastPrompt = input;
  }

  async interrupt(_sessionId: SessionId): Promise<boolean> {
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
  readonly scopeInputs: Array<{ operation: "list" | "reload" | "tools" | "connect" | "disconnect" | "auth" | "logout"; cwd?: string }> = [];

  async connect(server: string, input: RuntimeMcpScopeInput = {}): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["connect"]>>>> {
    this.scopeInputs.push({ operation: "connect", ...input });
    return { ...mcpServer(), name: server };
  }

  async disconnect(server: string, input: RuntimeMcpScopeInput = {}): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["disconnect"]>>>> {
    this.scopeInputs.push({ operation: "disconnect", ...input });
    return { ...mcpServer(), name: server, status: "stopped" };
  }

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
    scope: RuntimeMcpScopeInput = {},
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["auth"]>>>> {
    this.authInput = input;
    this.scopeInputs.push({ operation: "auth", ...scope });
    return {
      server,
      status: "pending",
      url: `https://auth.example/${server}`,
    };
  }

  async logout(server: string, scope: RuntimeMcpScopeInput = {}): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["logout"]>>>> {
    this.scopeInputs.push({ operation: "logout", ...scope });
    return { server, loggedOut: true };
  }
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

function sseStatusEvent(sessionId: SessionId, index: number): RuntimeEvent {
  return {
    id: `event_${sessionId}_${index}`, type: "session.status_changed", time: (index + 1) as TimestampMs,
    sessionId, payload: { sessionId, status: "running" },
  };
}

function sseOutputEvent(sessionId: SessionId, index: number, callId: string): RuntimeEvent {
  return {
    id: `delta_${sessionId}_${index}`, type: "tool.output_delta", time: (index + 1) as TimestampMs, sessionId,
    payload: { callId: callId as ToolCallId, stream: "stdout", delta: "live output ".repeat(10), sequence: index },
  };
}

function permissionConfig(profile: RuntimePermissionProfileId): RuntimePermissionConfig {
  return {
    profile,
    reviewInstructions: "Review dangerous operations.",
    defaultReviewInstructions: "Review dangerous operations.",
    profiles: [
      { id: "auto-review", label: "Auto-review", description: "Auto-review permissions", current: profile === "auto-review" },
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

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

class MemoryEventStore implements EventStore {
  readonly items: RuntimeEvent[] = [];
  readonly sessionRows = new Map<string, SessionRow>();
  readonly approvalRows: ApprovalRow[] = [];

  async append(event: RuntimeEvent): Promise<void> {
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

  async appendMany(events: readonly RuntimeEvent[]): Promise<void> {
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
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  get listenerCount(): number { return this.listeners.size; }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class GeneratedTransportEventStore extends CountingEventStore {
  static readonly fastCount = 500;
  readonly produced = new Map<string, number>();

  async eventReplayBoundary(query: { sessionId?: SessionId; limit?: number }): Promise<{ count: number }> {
    return { count: Math.min(this.total(query.sessionId), query.limit ?? 50_000) };
  }

  override async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    const sessionId = query.sessionId!;
    const start = query.afterEventId ? Number(query.afterEventId.slice("transport_".length)) + 1 : 0;
    const count = Math.min(query.limit ?? 64, Math.max(1, Math.floor((query.maxBytes ?? 32_768) / 2_400)), this.total(sessionId) - start);
    this.produced.set(sessionId, start + count);
    return Array.from({ length: count }, (_, index) => ({
      id: `transport_${start + index}`, type: "session.renamed", time: 1 as TimestampMs, sessionId,
      payload: { sessionId, title: "x".repeat(2_048) },
    }));
  }

  private total(sessionId?: SessionId): number {
    return sessionId === "session_transport_fast" ? GeneratedTransportEventStore.fastCount : 50_000;
  }
}

test("unified Agent routes bind the persisted caller and wait for the requested input", async () => {
  const base = new MemoryEventStore();
  const store = new ObservableEventStore(base);
  const service = new FakeRuntimeService(store);
  const sessionId = "session_agent_root" as SessionId;
  await service.createSession({ sessionId });
  const calls: Array<{ caller: SessionId; operation: string; input: unknown }> = [];
  const receipt = { agentId: "child/one", inputId: "input_1" };
  const settled = agentInputReceipt("child/one");
  const agents = {
    forSession(caller: SessionId) {
      const record = (operation: string, input: unknown) => { calls.push({ caller, operation, input }); };
      return {
        async listAgents(input: {}) { record("list", input); return [{ agentId: "child/one", name: "reviewer", path: "/root/reviewer", state: "idle" as const }]; },
        async spawnAgent(input: { name: string; prompt: string; cwd?: string }) { record("spawn", input); return receipt; },
        async sendAgent(input: { agentId: string; text: string; mode?: "queue" | "steer" }) { record("send", input); return receipt; },
        async waitAgent(input: { agentId: string; inputId: string; timeoutMs?: number }) { record("wait", input); return { input: settled, timedOut: false }; },
        async stopAgent(input: { agentId: string }) { record("stop", input); return { agentId: input.agentId }; },
        async resumeAgent(input: { agentId: string }) { record("resume", input); return { agentId: input.agentId }; },
      };
    },
  };
  const handler = createRuntimeHttpHandler({ service, store, agents });
  const client = new HttpRuntimeClient({ baseUrl: "http://chili.test", fetch: ((input, init) => handler(new Request(input, init))) as typeof fetch });
  expect(await client.listAgents({ sessionId })).toEqual([{ agentId: "child/one", name: "reviewer", path: "/root/reviewer", state: "idle" }]);
  expect(await client.spawnAgent({ sessionId, name: "reviewer", prompt: "inspect changes" })).toEqual(receipt);
  expect(await client.sendAgent({ sessionId, agentId: receipt.agentId, text: "review again", mode: "steer" })).toEqual(receipt);
  expect(await client.waitAgent({ sessionId, agentId: receipt.agentId, inputId: receipt.inputId, timeoutMs: 0 })).toEqual({ input: settled, timedOut: false });
  expect(await client.stopAgent({ sessionId, agentId: receipt.agentId })).toEqual({ agentId: receipt.agentId });
  expect(await client.resumeAgent({ sessionId, agentId: receipt.agentId })).toEqual({ agentId: receipt.agentId });
  expect(calls).toEqual([
    { caller: sessionId, operation: "list", input: {} },
    { caller: sessionId, operation: "spawn", input: { name: "reviewer", prompt: "inspect changes" } },
    { caller: sessionId, operation: "send", input: { agentId: "child/one", text: "review again", mode: "steer" } },
    { caller: sessionId, operation: "wait", input: { agentId: "child/one", inputId: "input_1", timeoutMs: 0 } },
    { caller: sessionId, operation: "stop", input: { agentId: "child/one" } },
    { caller: sessionId, operation: "resume", input: { agentId: "child/one" } },
  ]);
});

test("Agent HTTP control rejects child and archived callers before invoking the controller", async () => {
  const base = new MemoryEventStore();
  const store = new ObservableEventStore(base);
  const service = new FakeRuntimeService(store);
  let called = false;
  const agents = { forSession() { called = true; throw new Error("must not bind"); } };
  const sessionId = "session_agent_invalid" as SessionId;
  await service.createSession({ sessionId });
  const row = base.sessionRows.get(sessionId)!;
  const handler = createRuntimeHttpHandler({ service, store, agents });
  const child = { parentSessionId: "session_parent" as SessionId, name: "worker", path: "/root/worker" as AgentPath, policy: {} };
  for (const invalid of [{ ...row, agent: child }, { ...row, status: "archived" as const }]) {
    base.sessionRows.set(sessionId, invalid);
    for (const [method, suffix] of [["GET", ""], ["POST", ""], ["POST", "/another/send"], ["POST", "/another/wait"], ["POST", "/another/stop"], ["POST", "/another/resume"]] as const) {
      const response = await handler(new Request(`http://chili.test/sessions/${sessionId}/agents${suffix}`, { method }));
      expect(response.status).toBe(403);
    }
  }
  expect(called).toBe(false);
});

test("retired Team, Task, mailbox and global Agent routes are not executable", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const handler = createRuntimeHttpHandler({ service: new FakeRuntimeService(store), store });
  for (const path of ["/teams", "/teams/team_one/tasks", "/teams/team_one/run_loop", "/tasks", "/tasks/task_one/followup", "/tasks/reconcile_stale", "/agents", "/agents/tree", "/agent_runs", "/mailbox"]) {
    for (const method of ["GET", "POST"]) {
      expect((await handler(new Request(`http://chili.test${path}`, { method }))).status).toBe(404);
    }
  }
});

test("Agent HTTP rejects caller overrides and malformed controls before mutation", async () => {
  const base = new MemoryEventStore();
  const store = new ObservableEventStore(base);
  const service = new FakeRuntimeService(store);
  const sessionId = "session_agent_body" as SessionId;
  await service.createSession({ sessionId });
  let invoked = false;
  const method = async () => { invoked = true; return { agentId: "child", inputId: "input" }; };
  const handler = createRuntimeHttpHandler({ service, store, agents: { forSession: () => ({
    spawnAgent: method, sendAgent: method, stopAgent: method, resumeAgent: method,
    listAgents: async () => [], waitAgent: async () => { invoked = true; return { input: agentInputReceipt("child"), timedOut: false }; },
  }) } });
  const cases = [
    { suffix: "", body: { name: "worker", prompt: "work", sessionId: "different_root" } },
    { suffix: "/child/send", body: { text: "hello", mode: "triggerTurn" } },
    { suffix: "/child/wait", body: { timeoutMs: 0 } },
    { suffix: "/child/wait", body: { inputId: "input", timeoutMs: -1 } },
    { suffix: "/child/stop", body: { agentId: "another_child" } },
    { suffix: "/child/resume", body: { prompt: "restart something else" } },
  ];
  for (const { suffix, body } of cases) {
    const response = await handler(new Request(`http://chili.test/sessions/${sessionId}/agents${suffix}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(400);
  }
  expect(invoked).toBe(false);
});

function agentInputReceipt(agentId: string): import("@chili/protocol").RuntimeSessionInput {
  return { inputId: "input_1", submissionId: "submission_1", sessionId: agentId as SessionId, mode: "queue", state: "settled", outcome: "completed", revision: 1, sequence: 1, text: "review again", acceptedAt: 1, updatedAt: 2 };
}

test("disconnecting an Agent wait cancels only its waiter", async () => {
  const store = new ObservableEventStore(new MemoryEventStore());
  const service = new FakeRuntimeService(store);
  const sessionId = "session_agent_wait_abort" as SessionId;
  await service.createSession({ sessionId });
  const started = deferred<void>();
  let stopped = false;
  const mutation = async () => ({ agentId: "child", inputId: "input" });
  const handler = createRuntimeHttpHandler({ service, store, agents: {
    forSession(_caller: SessionId, options: { signal?: AbortSignal } = {}) {
      return {
        listAgents: async () => [], spawnAgent: mutation, sendAgent: mutation, resumeAgent: mutation,
        stopAgent: async () => { stopped = true; return { agentId: "child" }; },
        waitAgent: () => {
          started.resolve();
          return new Promise<import("@chili/protocol").RuntimeAgentWaitResult>((_resolve, reject) => {
            const abort = () => reject(abortError("Wait cancelled"));
            if (options.signal?.aborted) abort();
            else options.signal?.addEventListener("abort", abort, { once: true });
          });
        },
      };
    },
  } });
  const abort = new AbortController();
  const response = handler(new Request(`http://chili.test/sessions/${sessionId}/agents/child/wait`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputId: "input" }), signal: abort.signal,
  }));
  await started.promise;
  abort.abort();
  expect((await response).status).toBe(499);
  expect(stopped).toBe(false);
});
