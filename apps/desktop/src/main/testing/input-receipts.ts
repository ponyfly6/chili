import type { RuntimeInputAccepted, RuntimeInputQueue, SessionId } from "@chili/protocol";

export function emptyInputQueue(sessionId: string, paused = false, revision = 0): RuntimeInputQueue {
  return { sessionId: sessionId as SessionId, paused, revision, pendingCount: 0, interruptedCount: 0, items: [] };
}

export function acceptedInput(sessionId: string, text = "work", pending = false, submissionId = "submission_test"): RuntimeInputAccepted {
  const input: RuntimeInputAccepted["input"] = {
    sessionId: sessionId as SessionId, inputId: `input_${submissionId}`, submissionId,
    mode: "queue", state: pending ? "pending" : "claimed", sequence: 1, revision: 1,
    text, acceptedAt: 1, updatedAt: 1,
  };
  return { status: "accepted", sessionId: input.sessionId, input,
    queue: { ...emptyInputQueue(sessionId, false, 1), pendingCount: pending ? 1 : 0, items: [input] } };
}
