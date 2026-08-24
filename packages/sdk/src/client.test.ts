import { expect, test } from "bun:test";
import {
  EventCursorResyncRequiredError,
  HttpRuntimeClient,
  isEventCursorResyncRequiredError,
} from "./client.js";
import type { SessionId } from "@chili/protocol";

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
      requests.push(new Request(input, init));
      return Response.json({ servers: [], summary: {}, tools: [], reloaded: true, errors: [] });
    }) as typeof fetch,
  });

  await client.listMcpServers({ sessionId });
  await client.mcpStatus({ sessionId });
  await client.mcpServer({ server: "github/issues", sessionId });
  await client.listMcpTools({ server: "github/issues", sessionId });
  await client.reloadMcp({ sessionId });

  expect(requests.map((request) => {
    const url = new URL(request.url);
    return [request.method, url.pathname, url.searchParams.get("sessionId")];
  })).toEqual([
    ["GET", "/api/mcp", sessionId],
    ["GET", "/api/mcp/status", sessionId],
    ["GET", "/api/mcp/github%2Fissues", sessionId],
    ["GET", "/api/mcp/github%2Fissues/tools", sessionId],
    ["POST", "/api/mcp/reload", sessionId],
  ]);
});

test("mailbox filters by the canonical recipient session query", async () => {
  const requests: Request[] = [];
  const recipientSessionId = "session_mailbox_recipient" as SessionId;
  const client = new HttpRuntimeClient({
    baseUrl: "http://chili.test/api",
    fetch: (async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json([{
        id: "mailbox_1",
        path: "/root/worker",
        fromPath: "/root",
        triggerTurn: true,
        status: "queued",
        recipientSessionId,
        createdAt: 1,
      }]);
    }) as typeof fetch,
  });

  expect(await client.mailbox({
    path: "/root/worker",
    recipientSessionId,
    status: "queued",
    limit: 25,
  })).toMatchObject([{ recipientSessionId }]);

  const requestUrl = new URL(requests[0]!.url);
  expect(requestUrl.pathname).toBe("/api/mailbox");
  expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
    path: "/root/worker",
    recipientSessionId,
    status: "queued",
    limit: "25",
  });
  expect(requestUrl.searchParams.has("childSessionId")).toBe(false);
});
