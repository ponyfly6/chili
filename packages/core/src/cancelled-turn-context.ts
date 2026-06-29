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

  const cancelledTurnIds = new Set<string>();
  for (const [turnId, status] of completedStatusByTurn) {
    if (status === "cancelled") cancelledTurnIds.add(turnId);
  }

  const statusEvents = await readEvents(store, { sessionId, type: "session.status_changed" });
  for (const event of statusEvents) {
    const payload = recordPayload(event);
    const turnId = stringValue(payload.turnId);
    const status = stringValue(payload.status);
    if (turnId && status === "cancelled" && !completedStatusByTurn.has(turnId)) {
      cancelledTurnIds.add(turnId);
    }
  }

  if (cancelledTurnIds.size === 0) return [...messages];

  const meaningfulOutputTurnIds = new Set<string>();
  for (const message of messages) {
    if (!message.turnId || message.role === "user") continue;
    if (message.parts.some(isMeaningfulAssistantOutput)) {
      meaningfulOutputTurnIds.add(message.turnId);
    }
  }

  const removableTurnIds = new Set(
    [...cancelledTurnIds].filter((turnId) => !meaningfulOutputTurnIds.has(turnId)),
  );
  if (removableTurnIds.size === 0) return [...messages];

  return messages.filter((message) => !message.turnId || !removableTurnIds.has(message.turnId));
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
  if (part.type === "text") return part.text.trim().length > 0;
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
