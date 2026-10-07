import type { EventEnvelope, Message, MessagePart, SessionId } from "@chili/protocol";
import type { EventQuery, EventStore } from "@chili/store";

const EVENT_PAGE_SIZE = 10_000;

export async function messagesForContext(store: EventStore, sessionId: SessionId): Promise<Message[]> {
  return filterCancelledPromptMessagesForContext(store, sessionId, await store.messages(sessionId));
}

export async function filterCancelledPromptMessagesForContext(
  store: EventStore,
  sessionId: SessionId,
  messages: readonly Message[],
): Promise<Message[]> {
  if (!messages.some((message) => message.turnId)) return [...messages];

  const completedEvents = await readEvents(store, { sessionId, type: "turn.completed" });
  const completedStatusByTurn = new Map<string, string>();
  for (const event of completedEvents) {
    const payload = recordPayload(event);
    const turnId = stringValue(payload.turnId);
    const status = stringValue(payload.status);
    if (turnId && status) completedStatusByTurn.set(turnId, status);
  }

  const removableStatusTurnIds = new Set<string>();
  for (const [turnId, status] of completedStatusByTurn) {
    if (status === "cancelled" || status === "failed") removableStatusTurnIds.add(turnId);
  }

  const statusEvents = await readEvents(store, { sessionId, type: "session.status_changed" });
  for (const event of statusEvents) {
    const payload = recordPayload(event);
    const turnId = stringValue(payload.turnId);
    const status = stringValue(payload.status);
    if (
      turnId &&
      (status === "cancelled" || status === "failed") &&
      !completedStatusByTurn.has(turnId)
    ) {
      removableStatusTurnIds.add(turnId);
    }
  }

  if (removableStatusTurnIds.size === 0) return [...messages];

  const meaningfulOutputTurnIds = new Set<string>();
  for (const message of messages) {
    if (!message.turnId || message.role === "user") continue;
    if (message.parts.some(isMeaningfulAssistantOutput)) {
      meaningfulOutputTurnIds.add(message.turnId);
    }
  }

  const removableTurnIds = new Set(
    [...removableStatusTurnIds].filter((turnId) => !meaningfulOutputTurnIds.has(turnId)),
  );
  if (removableTurnIds.size === 0) return [...messages];

  const completedCompactions = new Map<string, { turnId: string; boundaryMessageId: string }>();
  for (const event of await readEvents(store, { sessionId, type: "turn.compaction_completed" })) {
    const payload = recordPayload(event);
    const messageId = stringValue(payload.messageId);
    const turnId = stringValue(payload.turnId);
    const boundaryMessageId = stringValue(payload.boundaryMessageId);
    if (messageId && turnId && boundaryMessageId) completedCompactions.set(messageId, { turnId, boundaryMessageId });
  }
  const committedContextIds = new Set<string>();
  const messageIndexes = new Map(messages.map((message, index) => [message.id, index]));
  for (const [index, message] of messages.entries()) {
    const completed = completedCompactions.get(message.id);
    if (!completed || completed.turnId !== message.turnId) continue;
    const boundaryIndex = messageIndexes.get(completed.boundaryMessageId as Message["id"]);
    if (boundaryIndex === undefined || boundaryIndex >= index) continue;
    if (!message.parts.some((part) => part.type === "compaction" && part.boundaryMessageId === completed.boundaryMessageId)) continue;
    committedContextIds.add(message.id);
    // The boundary can be the failed turn's own user message. Retain that raw
    // anchor so compactedMessageView can replace the whole covered prefix.
    committedContextIds.add(completed.boundaryMessageId);
  }
  return messages.filter((message) => {
    if (!message.turnId || !removableTurnIds.has(message.turnId)) return true;
    return committedContextIds.has(message.id);
  });
}

async function readEvents(
  store: EventStore,
  query: Omit<EventQuery, "afterEventId" | "limit">,
): Promise<EventEnvelope[]> {
  const events: EventEnvelope[] = [];
  let afterEventId: string | undefined;
  while (true) {
    const batch = await store.events({
      ...query,
      ...(afterEventId ? { afterEventId } : {}),
      limit: EVENT_PAGE_SIZE,
    });
    events.push(...batch);
    if (batch.length < EVENT_PAGE_SIZE) return events;
    afterEventId = batch.at(-1)?.id;
    if (!afterEventId) return events;
  }
}

function isMeaningfulAssistantOutput(part: MessagePart): boolean {
  if (part.type === "reasoning") return false;
  if (part.type === "text") return part.synthetic !== true && part.text.trim().length > 0;
  if (part.type === "tool_result") {
    return (
      part.output.trim().length > 0 ||
      (part.error?.trim().length ?? 0) > 0 ||
      (part.content?.length ?? 0) > 0 ||
      (part.artifactIds?.length ?? 0) > 0
    );
  }
  return true;
}

function recordPayload(event: EventEnvelope): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
