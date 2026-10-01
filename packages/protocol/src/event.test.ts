import { expect, test } from "bun:test";
import type { AgentMessageQueuedPayload, AgentPath, SessionId } from "./index.js";

test("agent mailbox payload names its destination as the recipient session", () => {
  const payload: AgentMessageQueuedPayload = {
    path: "/root/reviewer" as AgentPath,
    from: "/root" as AgentPath,
    recipientSessionId: "session_reviewer" as SessionId,
    triggerTurn: true,
  };

  expect(payload).toEqual({
    path: "/root/reviewer",
    from: "/root",
    recipientSessionId: "session_reviewer" as SessionId,
    triggerTurn: true,
  });

  const legacyPayload: AgentMessageQueuedPayload = {
    path: "/root/reviewer" as AgentPath,
    from: "/root" as AgentPath,
    triggerTurn: true,
    // @ts-expect-error The mailbox destination is no longer a child-agent-specific field.
    childSessionId: "session_reviewer" as SessionId,
  };
  expect(legacyPayload).not.toHaveProperty("recipientSessionId");
});
