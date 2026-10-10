import type { ChiliEvent, ConversationPage, MessageId, PartId, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";

/** Small display seeds preserve existing status/result projections without replaying audit history. */
export function conversationDisplayEvents(page: ConversationPage): ChiliEvent[] {
  const events: ChiliEvent[] = [];
  const tools = new Set<string>();
  for (const message of page.messages) {
    const base = { sessionId: page.sessionId as SessionId, time: message.createdAt as TimestampMs };
    const messageId = message.id as MessageId;
    events.push({ ...base, id: `history:message:${message.id}`, type: "message.created", payload: { messageId, role: message.role, ...(message.turnId ? { turnId: message.turnId as TurnId } : {}) } });
    for (const part of message.parts) {
      if (part.callId) {
        const callId = part.callId as ToolCallId;
        if (tools.has(callId)) continue;
        tools.add(callId);
        events.push({ ...base, id: `history:tool:${callId}`, type: "tool.call_started", payload: { callId, toolName: part.toolName ?? "tool", turnId: (message.turnId ?? `history:${message.id}`) as TurnId, input: {} } });
        if (part.status === "completed" || part.status === "failed" || part.status === "cancelled") {
          events.push({ ...base, id: `history:result:${callId}`, type: "tool.call_finished", payload: { callId, status: part.status, ...(part.toolName === "present_file" && part.text ? { output: part.text } : {}) } });
        }
      } else if (part.text) {
        events.push({ ...base, id: `history:part:${part.id}`, type: "message.part_added", payload: { messageId,
          part: { id: part.id as PartId, messageId, sessionId: page.sessionId as SessionId,
            type: part.type === "reasoning" ? "reasoning" : "text", text: part.text, ...(part.phase ? { phase: part.phase } : {}), ...(part.completion ? { completion: part.completion } : {}) } } });
      }
    }
  }
  return events;
}
