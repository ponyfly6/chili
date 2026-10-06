import { expect, expectTypeOf, test } from "bun:test";
import { isLegacyWorkflowEvent, isRuntimeEvent, type ChiliEvent, type RuntimeEvent } from "./index.js";
import { LEGACY_WORKFLOW_EVENT_TYPES, type LegacyWorkflowEvent } from "./legacy-workflow-events.js";
import { parseChiliEvent, parseRuntimeEvent } from "./runtime-validation.js";

// Retired business identities and models are accessible only through the historical module.
// @ts-expect-error TaskId is not a current runtime identity.
import type { TaskId as DefaultTaskId } from "./index.js";
// @ts-expect-error AgentTaskStatus is not a current runtime state.
import type { AgentTaskStatus as DefaultTaskStatus } from "./index.js";
// @ts-expect-error TeamEvent is not a current runtime event family.
import type { TeamEvent as DefaultTeamEvent } from "./index.js";

const counts = {
  dispatched: 1, completed: 1, accepted: 1, reopened: 0, merged: 1,
  mergeFailed: 0, mergeConflicted: 0, mergeSkipped: 0, failed: 0,
  blocked: 0, skipped: 0, stillRunning: 0, errors: 0,
};

const fixtures: Record<LegacyWorkflowEvent["type"], { payload: Record<string, unknown>; required: string }> = {
  "agent.task_created": { payload: { taskId: "task_old", path: "/root/old", parentPath: "/root", parentSessionId: "root", childSessionId: "child", taskName: "old", cwd: "/workspace", prompt: "Historical task" }, required: "taskId" },
  "agent.spawned": { payload: { runId: "run_old", path: "/root/old", taskName: "old" }, required: "runId" },
  "agent.message_queued": { payload: { path: "/root/old", from: "/root", triggerTurn: true, message: { content: "Old mailbox message" } }, required: "triggerTurn" },
  "agent.message_claimed": { payload: { messageId: "mail_old", claimedBy: "/root/old" }, required: "messageId" },
  "agent.message_requeued": { payload: { messageId: "mail_old", error: "old error" }, required: "messageId" },
  "agent.message_discarded": { payload: { messageId: "mail_old", reason: "historical discard" }, required: "reason" },
  "agent.message_consumed": { payload: { messageId: "mail_old", consumedBy: "/root/old" }, required: "messageId" },
  "agent.task_completed": { payload: { taskId: "task_old", path: "/root/old", status: "completed" }, required: "status" },
  "agent.completed": { payload: { runId: "run_old", path: "/root/old", status: "incomplete" }, required: "status" },
  "team.created": { payload: { teamId: "team_old", name: "old", leadPath: "/root" }, required: "leadPath" },
  "team.owner_session_bound": { payload: { teamId: "team_old", ownerSessionId: "root" }, required: "ownerSessionId" },
  "team.member_added": { payload: { teamId: "team_old", path: "/root/old", name: "old", role: "worker" }, required: "role" },
  "team.member_status_changed": { payload: { teamId: "team_old", path: "/root/old", status: "closed" }, required: "status" },
  "team.task_created": { payload: { teamId: "team_old", taskId: "task_old", dependsOn: ["prior"] }, required: "taskId" },
  "team.task_assigned": { payload: { teamId: "team_old", taskId: "task_old", ownerPath: "/root/old" }, required: "ownerPath" },
  "team.task_claimed": { payload: { teamId: "team_old", taskId: "task_old", ownerPath: "/root/old" }, required: "ownerPath" },
  "team.task_updated": { payload: { teamId: "team_old", taskId: "task_old", status: "completed" }, required: "taskId" },
  "team.message_sent": { payload: { teamId: "team_old", messageId: "mail_old", from: "/root", to: "*", content: "Old broadcast" }, required: "content" },
  "team.run_started": { payload: { teamId: "team_old", runId: "run_old", mode: "background", once: true, maxCycles: 1, timeoutMs: 1000, pollIntervalMs: 0 }, required: "once" },
  "team.run_progress": { payload: { teamId: "team_old", runId: "run_old", cycle: 1, phase: "merge", counts }, required: "counts" },
  "team.run_completed": { payload: { teamId: "team_old", runId: "run_old", cycles: 1, stopReason: "drained", startedAt: 1, endedAt: 2, counts }, required: "stopReason" },
};

test("current runtime events and historical workflow events are disjoint", () => {
  expectTypeOf<Extract<RuntimeEvent, { type: LegacyWorkflowEvent["type"] }>>().toEqualTypeOf<never>();
  expectTypeOf<ChiliEvent>().toEqualTypeOf<RuntimeEvent | LegacyWorkflowEvent>();
  expect(Object.keys(fixtures).sort()).toEqual([...LEGACY_WORKFLOW_EVENT_TYPES].sort());
  const current = parseRuntimeEvent({ id: "current", type: "session.created", sessionId: "root", time: 1, payload: { sessionId: "root", cwd: "/workspace" } });
  expect(isRuntimeEvent(current)).toBe(true);
  expect(isLegacyWorkflowEvent(current)).toBe(false);
});

for (const type of LEGACY_WORKFLOW_EVENT_TYPES) {
  test(`${type} remains strictly readable but cannot become a current runtime write`, () => {
    const fixture = fixtures[type];
    const event = { id: `historical_${type}`, type, sessionId: "root", time: 1, payload: { ...fixture.payload, futureField: "preserved" } };
    const parsed = parseChiliEvent(event);
    expect<unknown>(parsed).toEqual(event);
    expect(isLegacyWorkflowEvent(parsed)).toBe(true);
    expect(isRuntimeEvent(parsed)).toBe(false);
    expect(() => parseRuntimeEvent(event)).toThrow("historical workflow event");
    const invalid = { ...event, payload: { ...event.payload, [fixture.required]: undefined } };
    expect(() => parseChiliEvent(invalid)).toThrow(`payload.${fixture.required}`);
  });
}

test("historical nested payloads retain validation for mailbox parts, modes and counts", () => {
  const event = (type: LegacyWorkflowEvent["type"], change: Record<string, unknown>) => ({
    id: "historical", type, time: 1, payload: { ...fixtures[type].payload, ...change },
  });
  expect(() => parseChiliEvent(event("agent.message_queued", { message: { content: "ambiguous", parts: [] } }))).toThrow("exactly one");
  expect(() => parseChiliEvent(event("agent.message_queued", { message: { parts: [{ type: "tool_result" }] } }))).toThrow("parts[0]");
  expect(() => parseChiliEvent(event("agent.task_created", { mode: "new_task_kind" }))).toThrow("mode");
  expect(() => parseChiliEvent(event("team.task_created", { dependsOn: [7] }))).toThrow("dependsOn[0]");
  expect(() => parseChiliEvent(event("team.run_progress", { counts: { ...counts, merged: -1 } }))).toThrow("counts.merged");
  expect(() => parseChiliEvent(event("team.message_sent", { delivery: "new_delivery" }))).toThrow("delivery");
});
