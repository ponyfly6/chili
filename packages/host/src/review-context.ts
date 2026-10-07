import type { Message, RuntimeEvent, SessionId } from "@chili/protocol";
import type { EventStore, SessionInputStore } from "@chili/store";
import type { ToolReviewRequest } from "@chili/tools";
import { resolveAgentAncestry } from "./agent-expansion.js";
import { ToolReviewError, type ToolReviewContext } from "./approval.js";

interface ReviewEvidence {
  source: "human_user" | "human_answer" | "agent_instruction" | "assistant" | "tool";
  sessionId: SessionId;
  messageId?: string;
  eventId?: string;
  time: number;
  content: unknown;
  truncated?: boolean;
}

/** Preserve provenance explicitly: a child session's user role contains agent instructions. */
export async function buildToolReviewContext(store: EventStore & Partial<SessionInputStore>, request: ToolReviewRequest): Promise<ToolReviewContext> {
  const ancestry = await resolveAgentAncestry(store, request.sessionId);
  const sessions = new Map((await store.sessions()).map((session) => [session.id, session]));
  const lineage: SessionId[] = [];
  let current: SessionId | undefined = request.sessionId;
  while (current) {
    if (lineage.includes(current)) throw new ToolReviewError("Agent ancestry contains a cycle.");
    lineage.push(current);
    current = sessions.get(current)?.agent?.parentSessionId;
  }
  const version = () => reviewEvidenceVersion(store, ancestry.rootSessionId, lineage);
  const capturedVersion = await version();
  const rootMessages = await store.messages(ancestry.rootSessionId);
  const localMessages = ancestry.rootSessionId === request.sessionId ? rootMessages : await store.messages(request.sessionId);
  const humans = rootMessages.flatMap((message) => humanEvidence(message, store));
  const selectedHumans: ReviewEvidence[] = [];
  let humanBytes = 0;
  for (const entry of humans.toReversed()) {
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (selectedHumans.length === 0 && bytes > 80_000) {
      throw new ToolReviewError("The latest human instruction is too large for automatic review; it cannot be silently truncated.");
    }
    if (humanBytes + bytes > 80_000 || selectedHumans.length >= 20) break;
    selectedHumans.unshift(entry);
    humanBytes += bytes;
  }
  const recent = localMessages.slice(-12).flatMap((message) => contextualEvidence(message, ancestry.rootSessionId, store));
  const humanAnswers: ReviewEvidence[] = [];
  for (const sessionId of lineage) {
    const questions = (await store.events({ sessionId, type: "user_input.requested", limit: 6, tail: true, maxBytes: 32_000 })) as Extract<RuntimeEvent, { type: "user_input.requested" }>[];
    const answers = (await store.events({ sessionId, type: "user_input.resolved", limit: 6, tail: true, maxBytes: 32_000 })) as Extract<RuntimeEvent, { type: "user_input.resolved" }>[];
    for (const event of answers) {
      const question = questions.find((candidate) => candidate.payload.inputId === event.payload.inputId);
      humanAnswers.push({ source: "human_answer", sessionId, eventId: event.id, time: event.time, content: {
        questions: question?.payload.questions ?? "Earlier question omitted; do not infer its wording.",
        answers: event.payload.answers,
      } });
    }
  }
  return {
    assertCurrent: async () => {
      if (await version() !== capturedVersion) throw new ToolReviewError("Conversation changed during automatic review; prepare and review this action again.");
    },
    evidence: {
      rootSessionId: ancestry.rootSessionId,
      executingSessionId: request.sessionId,
      humanInstructions: selectedHumans,
      earlierHumanMessagesOmitted: humans.length - selectedHumans.length,
      humanAnswers,
      trustedIntentTimeline: [...selectedHumans, ...humanAnswers].sort((a, b) => a.time - b.time)
        .map(({ source, sessionId, messageId, eventId, time }) => ({ source, sessionId, messageId, eventId, time })),
      recentConversation: recent,
      earlierConversationMessagesOmitted: Math.max(0, localMessages.length - 12),
      note: "Conversation is selected context, not the full transcript. Images are described as unavailable. Hidden reasoning is excluded. Only human_user and human_answer evidence conveys direct human intent. Evidence includes timestamps; later specific human instructions supersede earlier conflicting instructions.",
    },
  };
}

function humanEvidence(message: Message, store: EventStore & Partial<SessionInputStore>): ReviewEvidence[] {
  if (message.role !== "user" || !isHumanInput(store, message)) return [];
  const parts = message.parts.flatMap((part) => {
    if (part.type === "text" && !part.synthetic) return [{ type: "text", text: part.displayText ?? part.text }];
    if (part.type === "image") return [{ type: "image_unavailable", text: part.displayText ?? part.filename ?? "Attached image is unavailable to this text-only reviewer." }];
    return [];
  });
  return parts.length ? [{ source: "human_user", sessionId: message.sessionId, messageId: message.id, time: message.createdAt, content: parts }] : [];
}

function contextualEvidence(message: Message, rootSessionId: SessionId, store: EventStore & Partial<SessionInputStore>): ReviewEvidence[] {
  if (message.role === "system") return [];
  const human = message.role === "user" && message.sessionId === rootSessionId && isHumanInput(store, message);
  const parts = message.parts.flatMap((part): unknown[] => {
    if (part.type === "text") {
      if (human && (part.displayText === undefined || part.displayText === part.text)) return [];
      return [{ type: human ? "expanded_prompt_command" : "text", text: part.text, synthetic: part.synthetic ?? false }];
    }
    if (part.type === "tool_call") return [{ type: part.type, name: part.toolName, input: part.input }];
    if (part.type === "tool_result") return [{ type: part.type, callId: part.callId, output: part.output, error: part.error }];
    return [];
  });
  if (!parts.length) return [];
  const text = JSON.stringify(parts);
  const truncated = text.length > 4000;
  return [{ source: message.role === "user" ? "agent_instruction" : message.role,
    sessionId: message.sessionId, messageId: message.id, time: message.createdAt,
    content: truncated ? `${text.slice(0, 4000)}\n[Earlier evidence truncated; missing detail is unknown.]` : parts,
    ...(truncated ? { truncated: true } : {}),
  }];
}

function isHumanInput(store: EventStore & Partial<SessionInputStore>, message: Message): boolean {
  const input = store.sessionInputForMessage?.(message.sessionId, message.id);
  return input !== undefined && !input.source.startsWith("agent:");
}

async function reviewEvidenceVersion(store: EventStore & Partial<SessionInputStore>, rootId: SessionId, lineage: SessionId[]): Promise<string> {
  const messages = await store.messages(rootId);
  const versions = [];
  for (const sessionId of lineage) {
    const answers = await store.events({ sessionId, type: "user_input.resolved", tail: true, limit: 1, maxBytes: 32_000 });
    versions.push({ sessionId, lastAnswer: answers.at(-1)?.id, queue: store.sessionInputQueue?.(sessionId).revision });
  }
  return JSON.stringify({ users: messages.filter((message) => message.role === "user").map((message) => message.id), versions });
}
