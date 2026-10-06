import { expect, expectTypeOf, test } from "bun:test";
import type { ChiliEvent, RuntimeEvent } from "./event.js";
import { parseChiliEvent, parseRuntimeEvent } from "./runtime-validation.js";

test("event names refer to the same current runtime protocol", () => {
  expectTypeOf<ChiliEvent>().toEqualTypeOf<RuntimeEvent>();
  expectTypeOf<Extract<ChiliEvent, { type: `agent.${string}` | `team.${string}` }>>().toEqualTypeOf<never>();
  const event = {
    id: "event_created", type: "session.created", time: 1,
    sessionId: "session_root", payload: { sessionId: "session_root", cwd: "/repo" },
  };
  for (const parse of [parseChiliEvent, parseRuntimeEvent]) {
    expect<unknown>(parse(event)).toEqual(event);
    expect(() => parse({ ...event, payload: { sessionId: "another", cwd: "/repo" } })).toThrow("must match");
  }
});

test("event decoders reject removed Agent and Team event types", () => {
  for (const [type, payload] of [
    ["agent.task_created", { taskId: "task_old", path: "/root/worker", parentPath: "/root", parentSessionId: "root", childSessionId: "child", taskName: "worker", cwd: "/repo", prompt: "work" }],
    ["agent.message_queued", { path: "/root/worker", from: "/root", triggerTurn: true, message: { content: "work" } }],
    ["team.created", { teamId: "team_old", name: "team", leadPath: "/root" }],
    ["team.task_updated", { teamId: "team_old", taskId: "task_old", status: "completed" }],
  ]) {
    for (const parse of [parseChiliEvent, parseRuntimeEvent]) {
      expect(() => parse({ id: "event_removed", type, time: 1, payload })).toThrow("event.type");
    }
  }
});
