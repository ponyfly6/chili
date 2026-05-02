import type { Message } from "@chili/protocol";
import { formatConversationMessages } from "./format.js";
import type { CompactionBoundary, ContextUsage } from "./window.js";
import type { PromptFragment } from "../prompt/fragment.js";

export interface ConversationPromptFragmentInput {
  messages: readonly Message[];
  usage: ContextUsage;
  compactionBoundary?: CompactionBoundary;
}

export function conversationPromptFragment(
  input: ConversationPromptFragmentInput,
): PromptFragment | undefined {
  if (input.messages.length === 0) return undefined;

  const metadata: Record<string, unknown> = {
    kind: "conversation_context",
    messageCount: input.messages.length,
    rawChars: input.usage.rawChars,
    contextChars: input.usage.contextChars,
    budgetChars: input.usage.budgetChars,
    omittedMessages: input.usage.omittedMessages,
    truncatedToolResults: input.usage.truncatedToolResults,
    compactedToolResults: input.usage.compactedToolResults,
  };
  if (input.compactionBoundary) {
    metadata.compactionBoundaryMessageId = input.compactionBoundary.boundaryMessageId;
    metadata.compactionReason = input.compactionBoundary.reason;
  }

  return {
    id: "runtime.conversation",
    layer: "conversation",
    source: "runtime",
    priority: 0,
    lifecycle: "turn",
    trust: "user",
    marker: { open: "<conversation>", close: "</conversation>" },
    content: formatConversationMessages(input.messages),
    metadata,
  };
}
