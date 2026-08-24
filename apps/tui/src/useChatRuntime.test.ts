import { expect, test } from "bun:test";
import type { SessionId } from "@chili/protocol";
import type { ChatSessionView } from "@chili/sdk";
import { acceptedFeedbackMatchesStatus, type ChatRuntimeFeedback } from "./useChatRuntime.js";

const sessionId = "session_feedback_gate" as SessionId;
const accepted: ChatRuntimeFeedback = {
  status: "accepted",
  message: "prompt queued",
  acceptedSessionId: sessionId,
  acceptedAgainstStatusEventId: "event_old_status",
};

test("unrelated events do not clear a per-session accepted acknowledgement", () => {
  const view = {
    sessionId,
    statusEventId: "event_old_status",
    lastEventId: "event_from_another_session",
  } as Pick<ChatSessionView, "sessionId" | "statusEventId" | "lastEventId">;

  expect(acceptedFeedbackMatchesStatus(accepted, view)).toBe(true);
});

test("a new status event for the accepted session clears the acknowledgement gate", () => {
  expect(acceptedFeedbackMatchesStatus(accepted, {
    sessionId,
    statusEventId: "event_new_status",
  })).toBe(false);
});

test("an acknowledgement never attaches to a different visible session", () => {
  expect(acceptedFeedbackMatchesStatus(accepted, {
    sessionId: "session_other" as SessionId,
    statusEventId: "event_old_status",
  })).toBe(false);
});
