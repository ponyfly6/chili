import { expect, test } from "bun:test";
import { parseChiliEvent, parsePersistedToolPolicy, parseSessionAgentMetadata } from "./runtime-validation.js";

const metadata = {
  parentSessionId: "session_parent",
  name: "reviewer",
  path: "/root/reviewer",
  policy: {
    allowedTools: ["read", "code_mode"],
    deniedTools: ["bash"],
    writeScope: [],
    executeScope: ["git diff *"],
  },
};

const event = {
  id: "event_created",
  type: "session.created",
  sessionId: "session_child",
  time: 1,
  payload: { sessionId: "session_child", cwd: "/tmp/project", agent: metadata },
};

test("agent metadata preserves every permission constraint and detaches its arrays", () => {
  const parsed = parseSessionAgentMetadata(metadata);
  expect<unknown>(parsed).toEqual(metadata);
  expect(parsed.policy).not.toBe(metadata.policy);
  expect(parsed.policy.allowedTools).not.toBe(metadata.policy.allowedTools);
  expect(parsed.policy.writeScope).toEqual([]);
  expect(parsePersistedToolPolicy({ deniedTools: [] })).toEqual({ deniedTools: [] });
  expect(parsePersistedToolPolicy({})).toEqual({});
  expect<unknown>(parseChiliEvent(event)).toEqual(event);
});

test("invalid permission JSON is rejected without dropping restrictions", () => {
  for (const policy of [
    null,
    [],
    new Date(),
    new Map(),
    { allowedTools: "read" },
    { allowedTools: ["read", 42] },
    { deniedTools: [null] },
    { writeScope: [""] },
    { executeScope: Array(1) },
    { allowedTool: ["read"] },
    { teamId: "team_old" },
    { metadata: {} },
  ]) {
    expect(() => parsePersistedToolPolicy(policy)).toThrow("policy");
    expect(() => parseChiliEvent({ ...event, payload: { ...event.payload, agent: { ...metadata, policy } } })).toThrow("agent.policy");
  }
});

test("agent metadata requires complete stable child identity and a policy", () => {
  const { policy: _, ...withoutPolicy } = metadata;
  expect(() => parseSessionAgentMetadata(withoutPolicy)).toThrow("policy");
  for (const change of [
    { parentSessionId: "" },
    { name: "not/a/segment" },
    { path: "root/reviewer" },
    { path: "/root//reviewer" },
    { path: "/root/reviewer/" },
    { path: "/reviewer" },
    { path: "/root/someone_else" },
    { path: "/root/../reviewer" },
    { taskId: "task_old" },
  ]) {
    expect(() => parseSessionAgentMetadata({ ...metadata, ...change })).toThrow("agent");
  }
  expect(() => parseChiliEvent({ ...event, payload: { ...event.payload, agent: { ...metadata, parentSessionId: event.sessionId } } })).toThrow("parentSessionId");
});

test("root session events do not require agent metadata", () => {
  const rootSession = { ...event, payload: { sessionId: event.sessionId, cwd: "/tmp/project" } };
  expect<unknown>(parseChiliEvent(rootSession)).toEqual(rootSession);
});
