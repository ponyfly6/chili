import { expect, test } from "bun:test";
import { compactRuntimeEvent, compactRuntimeMessage, type ChiliEvent } from "./event.js";
import type { ExecutionIdentity } from "./execution-identity.js";
import type { PreparedModelRequest } from "./prepared-request.js";
import { parseChiliEvent } from "./runtime-validation.js";

const identity: ExecutionIdentity = {
  profileId: "profile_a",
  profilePath: "/tmp/profile-a",
  authPath: "/tmp/profile-a/auth.json",
  projectId: "project_a",
  projectRoot: "/tmp/project-a",
  workspaceId: "workspace_a",
  workspaceRoot: "/tmp/project-a/worktree",
};

function preparedEvent(): ChiliEvent {
  const request: PreparedModelRequest = {
    version: 1,
    purpose: "turn",
    contentVersion: "sha256:request-content",
    sessionRevision: 7,
    executionIdentity: identity,
    system: ["Rules retained in the audit record"],
    developer: [],
    contextualUser: [],
    messages: [],
    tools: [],
    sources: [],
    budget: { maxChars: 200_000 },
  };
  return parseChiliEvent({
    id: "event_1",
    sessionId: "session_1",
    type: "model.request_prepared",
    time: 1,
    payload: { turnId: "turn_1", requestId: "request_1", attempt: 2, contentVersion: request.contentVersion, request },
  });
}

test("runtime event compaction preserves replay identity without mutating the stored request", () => {
  const full = preparedEvent();
  const compact = compactRuntimeEvent(full);
  expect(compact).toMatchObject({
    id: "event_1",
    sessionId: "session_1",
    type: "model.request_prepared",
    time: 1,
    payload: { turnId: "turn_1", requestId: "request_1", attempt: 2, contentVersion: "sha256:request-content" },
  });
  expect(parseChiliEvent(compact)).toEqual(compact);
  expect(full.payload).toHaveProperty("request.system", ["Rules retained in the audit record"]);
  expect(compactRuntimeEvent(compact)).toEqual(compact);
});

test("legacy full request events acquire the same content reference when parsed or compacted", () => {
  const full = preparedEvent();
  if (full.type !== "model.request_prepared") throw new Error("unexpected event");
  const { contentVersion: _, ...legacyPayload } = full.payload;
  const legacy = { ...full, payload: legacyPayload };
  const parsed = parseChiliEvent(legacy);
  expect(parsed.payload).toHaveProperty("contentVersion", "sha256:request-content");
  expect(legacy.payload).not.toHaveProperty("contentVersion");
  expect(compactRuntimeEvent(legacy as ChiliEvent)).toEqual(compactRuntimeEvent(full));
});

test("request references cannot claim different content than their persisted body", () => {
  const full = preparedEvent();
  expect(() => parseChiliEvent({ ...full, payload: { ...full.payload, contentVersion: "different" } })).toThrow("must match");
  expect(() => parseChiliEvent({ ...full, payload: { turnId: "turn_1", requestId: "request_1", attempt: 1 } })).toThrow("contentVersion");
  expect(() => parseChiliEvent({ ...full, payload: { ...full.payload, attempt: 0 } })).toThrow("positive integer");
});

test("display event compaction retains model content while leaving complete program results in storage", () => {
  const event = parseChiliEvent({
    id: "result_1", type: "message.part_added", time: 1,
    payload: {
      messageId: "message_1",
      part: {
        id: "part_1", messageId: "message_1", sessionId: "session_1", type: "tool_result",
        callId: "call_1", output: "model summary", structuredData: { records: [{ id: "record-a", value: "complete-data" }] },
      },
    },
  });
  const compact = compactRuntimeEvent(event);
  expect(compact.payload).not.toHaveProperty("part.structuredData");
  expect(compact.payload).toHaveProperty("part.output", "model summary");
  expect(event.payload).toHaveProperty("part.structuredData.records[0].value", "complete-data");
  expect(parseChiliEvent(compact)).toEqual(compact);
  if (event.type !== "message.part_added") throw new Error("unexpected event");
  const message = {
    id: event.payload.messageId,
    sessionId: event.payload.part.sessionId,
    role: "tool" as const,
    createdAt: event.time,
    parts: [event.payload.part],
  };
  const displayMessage = compactRuntimeMessage(message);
  expect(displayMessage.parts[0]).not.toHaveProperty("structuredData");
  expect(displayMessage.parts[0]).toHaveProperty("output", "model summary");
  expect(message.parts[0]).toHaveProperty("structuredData.records[0].value", "complete-data");
  expect(compactRuntimeMessage(displayMessage)).toBe(displayMessage);
});

test("resolved model identities validate account revisions without permitting credential fields", () => {
  const event = {
    id: "identity_1", type: "model.request_identity", time: 1,
    payload: {
      turnId: "turn_1", requestId: "request_1", attempt: 1,
      identity: { provider: "test", model: "test-model", accountId: "account-a", credentialVersion: 2, profileId: "profile-a" },
    },
  };
  expect(parseChiliEvent(event)).toMatchObject(event);
  for (const change of [{ credentialVersion: -1 }, { credentialVersion: {} }, { accessToken: "CANARY_TOKEN" }]) {
    expect(() => parseChiliEvent({ ...event, payload: { ...event.payload, identity: { ...event.payload.identity, ...change } } })).toThrow();
  }
});

test("legacy session identity binding requires matching session ownership and a complete identity", () => {
  const event = {
    id: "binding_1", type: "session.identity_bound", sessionId: "session_1", time: 1,
    payload: { sessionId: "session_1", identity },
  };
  expect(parseChiliEvent(event)).toMatchObject(event);
  expect(() => parseChiliEvent({ ...event, sessionId: "session_2" })).toThrow("sessionId");
  expect(() => parseChiliEvent({ ...event, sessionId: undefined })).toThrow("sessionId");
  expect(() => parseChiliEvent({ ...event, payload: { ...event.payload, identity: { profileId: "profile-a" } } })).toThrow();
  expect(() => parseChiliEvent({ ...event, type: "session.created", payload: { ...event.payload, cwd: "/tmp", identity: { ...identity, workspaceId: 3 } } })).toThrow("workspaceId");
  const { authPath: _, ...legacyIdentity } = identity;
  expect(parseChiliEvent({ ...event, payload: { ...event.payload, identity: legacyIdentity } }).type).toBe("session.identity_bound");
});
