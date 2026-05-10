import type { Message } from "@chili/protocol";

interface ContextMessageFormatOptions {
  includeToolCallStatus?: boolean;
  errorToolResultMode?: "error_only" | "error_and_output";
  nestedCompactionLabel?: "compaction" | "previous_context_summary";
}

export function formatConversationMessages(messages: readonly Message[]): string {
  return formatContextMessages(messages, {
    includeToolCallStatus: true,
    errorToolResultMode: "error_only",
    nestedCompactionLabel: "compaction",
  });
}

export function formatCompactionSourceMessages(messages: readonly Message[]): string {
  return formatContextMessages(messages, {
    includeToolCallStatus: false,
    errorToolResultMode: "error_and_output",
    nestedCompactionLabel: "previous_context_summary",
  });
}

function formatContextMessages(messages: readonly Message[], options: ContextMessageFormatOptions): string {
  return messages.map((message) => formatContextMessage(message, options)).join("\n\n");
}

function formatContextMessage(message: Message, options: ContextMessageFormatOptions): string {
  const compactionPart = message.parts.find((part) => part.type === "compaction");
  if (compactionPart?.type === "compaction") {
    return `[context_summary ${message.id}]\n${compactionPart.summary ?? ""}`;
  }

  const parts = message.parts.map((part) => formatContextPart(part, options)).filter(Boolean).join("\n");
  return `[${message.role} ${message.id}]\n${parts}`;
}

function formatContextPart(part: Message["parts"][number], options: ContextMessageFormatOptions): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "image":
      return `[image ${part.mimeType}${part.filename ? ` ${part.filename}` : ""}${part.sourcePath ? ` ${part.sourcePath}` : ""}]`;
    case "reasoning":
      return `[reasoning]\n${part.text}`;
    case "tool_call": {
      const status = options.includeToolCallStatus ? ` ${part.status}` : "";
      return `[tool_call ${part.toolName} ${part.callId}${status}]\n${safeJson(part.input)}`;
    }
    case "tool_result":
      return formatToolResultPart(part, options);
    case "patch":
      return `[patch]\n${part.files.join("\n")}`;
    case "artifact":
      return `[artifact ${part.artifactId}]`;
    case "compaction":
      return options.nestedCompactionLabel === "previous_context_summary"
        ? `[previous_context_summary]\n${part.summary ?? ""}`
        : `[compaction ${part.reason} ${part.boundaryMessageId}]\n${part.summary ?? ""}`;
    case "agent_handoff":
      return `[agent_handoff ${part.agentPath}]\n${part.summary}`;
  }
}

function formatToolResultPart(
  part: Extract<Message["parts"][number], { type: "tool_result" }>,
  options: ContextMessageFormatOptions,
): string {
  const prefix = `[tool_result ${part.callId}${part.error ? " error" : ""}]`;
  if (!part.error) return `${prefix}\n${part.output}`;
  if (options.errorToolResultMode === "error_and_output") return `${prefix}\nError: ${part.error}\n${part.output}`;
  return `${prefix}\n${part.error}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
