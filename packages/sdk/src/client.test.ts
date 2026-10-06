import { expect, test } from "bun:test";
import {
  EventCursorResyncRequiredError,
  EventTransportResyncRequiredError,
  HttpRuntimeClient,
  isEventCursorResyncRequiredError,
  isEventTransportResyncRequiredError,
} from "./client.js";
import type { SessionId, UserInputId } from "@chili/protocol";

test("listSessions aborts a stalled real HTTP read", async () => {
  let received = false;
  let release!: () => void;
  const response = new Promise<Response>((resolveResponse) => {
    release = () => resolveResponse(Response.json([]));
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      received = true;
      return response;
    },
  });
  const controller = new AbortController();
  try {
    const client = new HttpRuntimeClient({ baseUrl: `http://127.0.0.1:${server.port}` });
    const reading = client.listSessions({ signal: controller.signal });
    for (let attempt = 0; attempt < 100 && !received; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
    expect(received).toBe(true);
    controller.abort();
    await expect(reading).rejects.toThrow();
  } finally {
    controller.abort();
    release();
    await server.stop(true);
  }
});

test("streamEvents exposes a cursor resync signal for rejected resume cursors", async () => {
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: (async () => new Response(JSON.stringify({
      error: { message: "Unknown event cursor. Reconnect without afterEventId to resync." },
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
  });

  let caught: unknown;
  try {
    for await (const _event of client.streamEvents({ afterEventId: "event_missing" })) {
      // A rejected cursor must fail before the stream yields an event.
    }
  } catch (error) {
    caught = error;
  }

  expect(isEventCursorResyncRequiredError(caught)).toBe(true);
  expect(caught).toBeInstanceOf(EventCursorResyncRequiredError);
  expect(caught).toMatchObject({
    name: "EventCursorResyncRequiredError",
    code: "EVENT_CURSOR_RESYNC_REQUIRED",
    status: 409,
    afterEventId: "event_missing",
    message: "Unknown event cursor. Reconnect without afterEventId to resync.",
  });
});

test("streamEvents keeps non-resume HTTP conflicts as ordinary errors", async () => {
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: (async () => new Response(JSON.stringify({ error: { message: "conflict" } }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
  });

  let caught: unknown;
  try {
    for await (const _event of client.streamEvents()) {
      // A failed response must not yield events.
    }
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(isEventCursorResyncRequiredError(caught)).toBe(false);
  expect((caught as Error).message).toBe("conflict");
});

test("streamEvents exposes a bounded transport resync cursor without yielding a synthetic event", async () => {
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: (async () => new Response(
      "event: chili.resync\ndata: {\"reason\":\"event_transport_limit\",\"afterEventId\":\"event_poison\",\"message\":\"Authoritative resync required\"}\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch,
  });

  const yielded: unknown[] = [];
  let caught: unknown;
  try {
    for await (const event of client.streamEvents()) yielded.push(event);
  } catch (error) {
    caught = error;
  }

  expect(yielded).toEqual([]);
  expect(isEventTransportResyncRequiredError(caught)).toBe(true);
  expect(caught).toBeInstanceOf(EventTransportResyncRequiredError);
  expect(caught).toMatchObject({
    code: "EVENT_TRANSPORT_RESYNC_REQUIRED",
    resumeAfterEventId: "event_poison",
    message: "Authoritative resync required",
  });
  expect(isEventCursorResyncRequiredError(caught)).toBe(false);
});

test("delegation client reads and updates the deterministic session policy endpoint", async () => {
  const requests: Request[] = [];
  const sessionId = "session_1" as SessionId;
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test/api",
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const policy = request.method === "POST"
        ? (JSON.parse(await request.clone().text()) as { policy: string }).policy
        : "explicit";
      return Response.json({ sessionId: "session_1", policy, source: request.method === "POST" ? "session" : "default" });
    }) as typeof fetch,
  });

  expect(await client.getDelegationConfig({ sessionId })).toEqual({
    sessionId,
    policy: "explicit",
    source: "default",
  });
  expect(await client.setDelegationPolicy({
    sessionId,
    policy: "proactive",
  })).toEqual({
    sessionId,
    policy: "proactive",
    source: "session",
  });

  expect(requests.map((request) => [request.method, request.url])).toEqual([
    ["GET", "http://chili.test/api/sessions/session_1/delegation"],
    ["POST", "http://chili.test/api/sessions/session_1/delegation"],
  ]);
  expect(await requests[1]!.json()).toEqual({ policy: "proactive" });
});

test("MCP catalog requests carry the selected session scope", async () => {
  const requests: Request[] = [];
  const sessionId = "session_mcp/scope" as SessionId;
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test/api",
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/status")) {
        return Response.json({ servers: [], summary: { total: 0, running: 0, disabled: 0, authRequired: 0, errored: 0 } });
      }
      if (path.endsWith("/tools")) return Response.json({ server: "github/issues", tools: [] });
      if (path.endsWith("/auth")) return Response.json({ server: "github/issues", status: "pending" });
      if (path.endsWith("/logout")) return Response.json({ server: "github/issues", loggedOut: true });
      if (path.endsWith("/reload")) return Response.json({ reloaded: true, servers: [], errors: [] });
      if (path.endsWith("/connect") || path.endsWith("/disconnect")) {
        return Response.json({ name: "github/issues", status: path.endsWith("/connect") ? "running" : "stopped", enabled: true });
      }
      if (path.endsWith("/github%2Fissues")) {
        return Response.json({ name: "github/issues", status: "running", enabled: true });
      }
      return Response.json({ servers: [] });
    }) as typeof fetch,
  });

  await client.listMcpServers({ sessionId });
  await client.mcpStatus({ sessionId });
  await client.mcpServer({ server: "github/issues", sessionId });
  await client.listMcpTools({ server: "github/issues", sessionId });
  await client.reloadMcp({ sessionId });
  await client.connectMcpServer({ server: "github/issues", sessionId });
  await client.disconnectMcpServer({ server: "github/issues", sessionId });
  await client.authMcpServer({ server: "github/issues", sessionId });
  await client.logoutMcpServer({ server: "github/issues", sessionId });

  expect(requests.map((request) => {
    const url = new URL(request.url);
    return [request.method, url.pathname, url.searchParams.get("sessionId")];
  })).toEqual([
    ["GET", "/api/mcp", sessionId],
    ["GET", "/api/mcp/status", sessionId],
    ["GET", "/api/mcp/github%2Fissues", sessionId],
    ["GET", "/api/mcp/github%2Fissues/tools", sessionId],
    ["POST", "/api/mcp/reload", sessionId],
    ["POST", "/api/mcp/github%2Fissues/connect", sessionId],
    ["POST", "/api/mcp/github%2Fissues/disconnect", sessionId],
    ["POST", "/api/mcp/github%2Fissues/auth", sessionId],
    ["POST", "/api/mcp/github%2Fissues/logout", sessionId],
  ]);
});

test("user input client lists pending requests and resolves answers with the expected URL and body", async () => {
  const requests: Request[] = [];
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test/api",
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "GET") {
        return Response.json([{
          id: "userinput_sdk",
          sessionId: "session_sdk",
          callId: "toolcall_sdk",
          questions: [{
            id: "choice",
            header: "Choice",
            question: "Choose one",
            options: [
              { label: "A", description: "First" },
              { label: "B", description: "Second" },
            ],
          }],
          createdAt: 123,
        }]);
      }
      return Response.json({ resolved: true });
    }) as typeof fetch,
  });

  expect(await client.listUserInputs({ sessionId: "session_sdk" as SessionId })).toMatchObject([{
    id: "userinput_sdk",
    sessionId: "session_sdk",
  }]);
  expect(await client.pendingUserInputs()).toHaveLength(1);
  expect(await client.resolveUserInput({
    inputId: "userinput_sdk/choice" as UserInputId,
    answers: { theme: ["Dark"] },
  })).toEqual({ resolved: true });

  expect(requests.map((request) => [request.method, request.url])).toEqual([
    ["GET", "http://chili.test/api/user-inputs?sessionId=session_sdk"],
    ["GET", "http://chili.test/api/user-inputs"],
    ["POST", "http://chili.test/api/user-inputs/userinput_sdk%2Fchoice/resolve"],
  ]);
  expect(await requests[2]!.json()).toEqual({ answers: { theme: ["Dark"] } });
});

test("adds bearer authentication to JSON and SSE requests", async () => {
  const requests: Request[] = [];
  const event = {
    id: "event_auth",
    type: "session.created",
    time: 1,
    sessionId: "session_auth",
    payload: { sessionId: "session_auth", cwd: "/repo" },
  };
  const client = new HttpRuntimeClient({
    baseUrl: "https://chili.test",
    authToken: "a".repeat(32),
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (new URL(request.url).pathname === "/events") {
        return new Response(`event: chili.event\ndata: ${JSON.stringify(event)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json([]);
    }) as typeof fetch,
  });

  await client.listSessions();
  for await (const _event of client.streamEvents()) {
    // Drain the single event.
  }
  expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
    `Bearer ${"a".repeat(32)}`,
    `Bearer ${"a".repeat(32)}`,
  ]);
  expect(Object.keys(client)).not.toContain("authorization");
  expect(Object.keys(client)).not.toContain("baseUrl");
  expect(Reflect.ownKeys(client)).not.toContain("authorization");
  expect(Reflect.ownKeys(client)).not.toContain("baseUrl");
  expect(JSON.stringify(client)).not.toContain("a".repeat(32));
  expect(JSON.stringify(client)).not.toContain("Bearer");
});

test("rejects credentialed base URLs and cleartext non-loopback bearer transport", () => {
  const authToken = "TRANSPORT_CANARY_".repeat(2);
  for (const baseUrl of [
    "http://127.0.0.1:4317",
    "http://127.255.1.2:4317",
    "http://localhost:4317",
    "http://api.localhost:4317",
    "http://[::1]:4317",
    "https://192.168.1.20:4317",
    "https://control.example.test",
  ]) {
    expect(() => new HttpRuntimeClient({ baseUrl, authToken })).not.toThrow();
  }

  for (const baseUrl of [
    "http://0.0.0.0:4317",
    "http://[::]:4317",
    "http://192.168.1.20:4317",
    "http://control.example.test",
    "http://127.0.0.1.example.test",
  ]) {
    expect(() => new HttpRuntimeClient({ baseUrl, authToken })).toThrow(
      "authToken requires HTTPS for a non-loopback runtime server",
    );
  }

  for (const baseUrl of [
    "https://user:BASEURL_CANARY@control.example.test",
    "https://user:BASEURL_CANARY@control.example.test/api",
    "https://user@control.example.test",
    "https://control.example.test/api?access_token=BASEURL_QUERY_CANARY",
    "https://control.example.test/api#BASEURL_FRAGMENT_CANARY",
  ]) {
    let caught: unknown;
    try {
      new HttpRuntimeClient({ baseUrl });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe("baseUrl must be a credential-free absolute HTTP(S) URL");
    expect((caught as Error).message).not.toContain("BASEURL_CANARY");
  }

  for (const authToken of ["token with spaces", "token\u0000with-control", "token\u007fwith-delete"]) {
    expect(() => new HttpRuntimeClient({ baseUrl: "https://control.example.test", authToken })).toThrow(
      "authToken must be a non-empty string without whitespace",
    );
  }
});

test("bounds and credential-redacts remote HTTP error diagnostics", async () => {
  const authToken = "HTTP_ERROR_CANARY_".repeat(2);
  const remoteCanaries = [
    "REFRESH_CANARY",
    "CLIENT_CANARY",
    "BASIC_CANARY",
    "COOKIE_CANARY",
    "DB_USER_CANARY",
    "DB_PASSWORD_CANARY",
    "SK_CANARY",
    "PERCENT_CANARY",
    "CONTROL_GAP_CANARY",
  ];
  const leaked = new HttpRuntimeClient({
    baseUrl: "https://control.example.test",
    authToken,
    fetch: (async () => new Response(JSON.stringify({
      error: {
        message: [
          `Authorization: Bearer ${authToken}`,
          "refresh_token=REFRESH_CANARY",
          "client_secret=CLIENT_CANARY",
          "Authorization: Basic BASIC_CANARY",
          "Cookie: COOKIE_CANARY",
          "postgres://DB_USER_CANARY:DB_PASSWORD_CANARY@db.example/app",
          "sk-SK_CANARY",
          "https://control.example/status?to%6ben=PERCENT_CANARY",
          "be\u0000arer CONTROL_GAP_CANARY",
          "endpoint=https://user:URL_PASSWORD@control.example.test",
        ].join("\n"),
      },
    }), {
      status: 500,
      statusText: `Bearer ${authToken}`,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
  });
  let leakedError: unknown;
  try {
    await leaked.listSessions();
  } catch (error) {
    leakedError = error;
  }
  expect(leakedError).toBeInstanceOf(Error);
  expect((leakedError as Error).message).toContain("[REDACTED]");
  expect((leakedError as Error).message).not.toContain(authToken);
  expect((leakedError as Error).message).not.toContain("URL_PASSWORD");
  for (const canary of remoteCanaries) expect((leakedError as Error).message).not.toContain(canary);
  expect(new TextEncoder().encode((leakedError as Error).message).byteLength).toBeLessThanOrEqual(2_000);

  let cancelled = false;
  const oversizedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(70_000) + authToken));
    },
    cancel() {
      cancelled = true;
    },
  });
  const oversized = new HttpRuntimeClient({
    baseUrl: "https://control.example.test",
    authToken,
    fetch: (async () => new Response(oversizedBody, {
      status: 502,
      statusText: `Bearer ${authToken}`,
    })) as unknown as typeof fetch,
  });
  await expect(oversized.listSessions()).rejects.toThrow("Runtime request failed with HTTP 502");
  expect(cancelled).toBe(true);
});

test("byte-bounds and credential-redacts SSE resync diagnostics", async () => {
  const authToken = "SSE_RESYNC_CANARY_".repeat(2);
  const remoteCanaries = [
    "REFRESH_CANARY",
    "CLIENT_CANARY",
    "BASIC_CANARY",
    "COOKIE_CANARY",
    "DB_USER_CANARY",
    "DB_PASSWORD_CANARY",
    "SK_CANARY",
    "PERCENT_CANARY",
  ];
  const frame = (afterEventId: string, message: string) => `event: chili.resync\ndata: ${JSON.stringify({
    reason: "event_transport_limit",
    afterEventId,
    message,
  })}\n\n`;
  const streamError = async (body: string): Promise<Error> => {
    const client = new HttpRuntimeClient({
      baseUrl: "https://control.example.test",
      authToken,
      fetch: (async () => new Response(body, {
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch,
    });
    try {
      for await (const _event of client.streamEvents()) {
        // A control frame must fail rather than yield an event.
      }
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected streamEvents to reject");
  };

  const redacted = await streamError(frame(
    "event_safe",
    [
      `Authorization: Bearer ${authToken}`,
      "refresh_token=REFRESH_CANARY",
      "client_secret=CLIENT_CANARY",
      "Authorization: Basic BASIC_CANARY",
      "Cookie: COOKIE_CANARY",
      "postgres://DB_USER_CANARY:DB_PASSWORD_CANARY@db.example/app",
      "sk-SK_CANARY",
      "https://control.example/status?to%6ben=PERCENT_CANARY",
      "endpoint=https://user:SSE_PASSWORD@control.example.test",
    ].join("; "),
  ));
  expect(redacted).toBeInstanceOf(EventTransportResyncRequiredError);
  expect(redacted.message).toContain("[REDACTED]");
  expect(redacted.message).not.toContain(authToken);
  expect(redacted.message).not.toContain("SSE_PASSWORD");
  for (const canary of remoteCanaries) expect(redacted.message).not.toContain(canary);
  expect(new TextEncoder().encode(redacted.message).byteLength).toBeLessThanOrEqual(2_000);

  const hostileCursor = await streamError(frame(`event_${authToken}`, "resync required"));
  expect(hostileCursor).toBeInstanceOf(TypeError);
  expect(hostileCursor.message).toBe("Invalid event resync afterEventId");
  expect(hostileCursor.message).not.toContain(authToken);

  const multibyte = await streamError(frame("event_safe", "é".repeat(1_001)));
  expect(multibyte).toBeInstanceOf(TypeError);
  expect(multibyte.message).toBe("Invalid event resync message");
});

test("rejects malformed JSON response shapes and unexpected no-content responses", async () => {
  const malformed = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: (async () => Response.json([{ id: 7, cwd: "/repo", status: "active", createdAt: 1, updatedAt: 1 }])) as unknown as typeof fetch,
  });
  await expect(malformed.listSessions()).rejects.toThrow("response[0].id");

  const empty = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
  });
  await expect(empty.listSessions()).rejects.toThrow("unexpectedly had no content");
  expect(await empty.getGoal({ sessionId: "session_1" as SessionId })).toBeUndefined();
});

test("rejects malformed and nested-invalid SSE without reflecting hostile JSON", async () => {
  for (const frame of [
    "event: chili.event\ndata: {HOSTILE_CANARY\n\n",
    "event: chili.event\ndata: {\"id\":\"event_bad\",\"type\":\"mcp.progress\",\"time\":1,\"payload\":{}}\n\n",
  ]) {
    const client = new HttpRuntimeClient({
      baseUrl: "http://chili.test",
      fetch: (async () => new Response(frame, {
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      for await (const _event of client.streamEvents()) {
        // Invalid streams must not yield.
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("HOSTILE_CANARY");
  }
});

test("parses CRLF EOF frames and bounds only each SSE frame, not a combined chunk", async () => {
  const event = (id: string, delta: string) => ({
    id,
    type: "tool.output_delta",
    time: 1,
    payload: { callId: `call_${id}`, stream: "stdout", delta },
  });
  const large = "x".repeat(2_100_000);
  const combined = [event("event_one", large), event("event_two", large)]
    .map((value) => `event: chili.event\ndata: ${JSON.stringify(value)}\r\n\r\n`)
    .join("");
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: (async () => new Response(combined, {
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch,
  });
  const ids: string[] = [];
  for await (const value of client.streamEvents()) ids.push(value.id);
  expect(ids).toEqual(["event_one", "event_two"]);

  const eofClient = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: (async () => new Response(
      `event: chili.event\r\ndata: ${JSON.stringify(event("event_eof", "ok"))}`,
      { headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch,
  });
  const eofIds: string[] = [];
  for await (const value of eofClient.streamEvents()) eofIds.push(value.id);
  expect(eofIds).toEqual(["event_eof"]);
});

test("cancels SSE readers on early iteration exit and rejects oversized partial frames", async () => {
  let cancelled = false;
  const event = {
    id: "event_cancel",
    type: "tool.output_delta",
    time: 1,
    payload: { callId: "call_cancel", stream: "stdout", delta: "ok" },
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: chili.event\ndata: ${JSON.stringify(event)}\n\n`));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: (async () => new Response(stream, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
  });
  for await (const _event of client.streamEvents()) break;
  expect(cancelled).toBe(true);

  const oversized = new HttpRuntimeClient({
    baseUrl: "http://chili.test",
    fetch: (async () => new Response(`data: ${"x".repeat(4_100_001)}`, {
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch,
  });
  let caught: unknown;
  try {
    for await (const _event of oversized.streamEvents()) {
      // Oversized partial frames must fail before yielding.
    }
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain("exceeds 4100000 bytes");
});

test("Agent list and input receipts reject malformed server data", async () => {
  const sessionId = "session_sdk_agents" as SessionId;
  const cases = [
    { value: [{ agentId: "child", name: "worker", path: "/root/worker", state: "completed" }], run: (client: HttpRuntimeClient) => client.listAgents({ sessionId }) },
    { value: [{ agentId: "child", name: "worker", path: "/root/worker", state: "idle", parentAgentId: 7 }], run: (client: HttpRuntimeClient) => client.listAgents({ sessionId }) },
    { value: { agentId: "child" }, run: (client: HttpRuntimeClient) => client.spawnAgent({ sessionId, name: "worker", prompt: "work" }) },
    { value: { agentId: "child", inputId: false }, run: (client: HttpRuntimeClient) => client.resumeAgent({ sessionId, agentId: "child" }) },
    { value: { timedOut: false, input: { inputId: "receipt" } }, run: (client: HttpRuntimeClient) => client.waitAgent({ sessionId, agentId: "child", inputId: "receipt" }) },
  ];
  for (const item of cases) {
    const client = new HttpRuntimeClient({ baseUrl: "http://chili.test", fetch: (async () => Response.json(item.value)) as unknown as typeof fetch });
    await expect(item.run(client)).rejects.toThrow();
  }
});

test("Agent wait timeout preserves the concrete input receipt", async () => {
  const input: import("@chili/protocol").RuntimeSessionInput = { inputId: "receipt", submissionId: "submission", sessionId: "child" as SessionId, mode: "queue", state: "pending", revision: 1, sequence: 1, text: "work", acceptedAt: 1, updatedAt: 1 };
  const client = new HttpRuntimeClient({ baseUrl: "http://chili.test", fetch: (async () => Response.json({ input, timedOut: true })) as unknown as typeof fetch });
  expect(await client.waitAgent({ sessionId: "root" as SessionId, agentId: "child", inputId: "receipt", timeoutMs: 0 })).toEqual({ input, timedOut: true });
});
