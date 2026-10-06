import { randomUUID } from "node:crypto";
import type { McpElicitationRequest, McpElicitationResult, McpServerConfig } from "@chili/mcp";
import { timestampNow, parseUserInputQuestions, type ChiliEvent, type SessionId, type ToolCallId, type UserInputId, type UserInputQuestion } from "@chili/protocol";
import { type DeferredUserInputQueue, UserInputDeniedError, validateExternalInputSchema } from "@chili/tools";

export interface McpElicitationContext {
  sessionId: SessionId;
  callId: ToolCallId;
  signal: AbortSignal;
}
export interface McpElicitationOptions {
  queue: DeferredUserInputQueue;
  events: { publish(event: ChiliEvent): Promise<void> };
}

/** Form values are disclosed only after explicit consent for this server request. */
export async function elicitMcpInput(
  options: McpElicitationOptions, server: McpServerConfig, request: McpElicitationRequest, context: McpElicitationContext,
): Promise<McpElicitationResult> {
  const ask = async (question: UserInputQuestion): Promise<string[]> => {
    context.signal.throwIfAborted();
    const questions = parseUserInputQuestions([{ ...question, question: question.question.replace(/[\r\n\t]+/g, " ") }]);
    const id = `mcpinput_${randomUUID()}` as UserInputId;
    const now = timestampNow();
    const outcome = options.queue.ask({ id, sessionId: context.sessionId, callId: context.callId, questions, createdAt: now }, context.signal)
      .then((answers) => ({ ok: true as const, answers }), (error: unknown) => ({ ok: false as const, error }));
    try {
      await options.events.publish({ id: randomUUID(), type: "user_input.requested", time: now, sessionId: context.sessionId,
        payload: { inputId: id, callId: context.callId, questions } });
    } catch (error) { options.queue.deny(id, error); await outcome; throw error; }
    const result = await outcome;
    if (!result.ok) {
      await options.events.publish({ id: randomUUID(), type: "user_input.cancelled", time: timestampNow(), sessionId: context.sessionId,
        payload: { inputId: id, reason: "MCP input was cancelled." } });
      throw result.error;
    }
    await options.events.publish({ id: randomUUID(), type: "user_input.resolved", time: timestampNow(), sessionId: context.sessionId,
      payload: { inputId: id, answers: result.answers } });
    context.signal.throwIfAborted();
    return result.answers[question.id]!;
  };

  try {
    if (request.mode === "url") {
      const url = new URL(request.url);
      if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password) throw new Error("Unsupported MCP interaction URL");
      const answer = await ask({ id: "consent", header: "MCP", question: `${server.name}: ${request.message}\n\nOpen this address to complete the request, then select Continue:\n${url.href}`,
        options: choices(["Continue", "Decline", "Cancel"]) });
      return { action: action(answer[0]) };
    }

    const properties = Object.entries(request.requestedSchema.properties);
    if (properties.length > 20) throw new Error("MCP form exceeds the 20-field limit");
    const consent = await ask({ id: "consent", header: "MCP", question: `${server.name}: ${request.message}\n\nShare the following information with this server?\n${properties.map(([name]) => name).join(", ")}`,
      options: choices(["Continue", "Decline", "Cancel"]) });
    if (action(consent[0]) !== "accept") return { action: action(consent[0]) };
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const [index, [name, schema]] of properties.entries()) {
      context.signal.throwIfAborted();
      const field = schema as unknown as Record<string, unknown>;
      const required = request.requestedSchema.required?.includes(name) ?? false;
      if (!required) {
        const include = await ask({ id: `include_${index}`, header: "MCP", question: `${server.name}: Include the optional field “${name}”?`,
          options: choices(["Provide value", "Skip field"]) });
        if (include[0] === "Skip field") continue;
        if (include[0] !== "Provide value") throw new Error("Choose whether to provide the optional MCP field");
      }
      const values = enumValues(field);
      if (field.type === "array") {
        if (!values || values.length > 20) throw new Error("MCP multiple-selection fields require at most 20 choices");
        const selected: string[] = [];
        for (const [choiceIndex, value] of values.entries()) {
          const answer = await ask({ id: `field_${index}_${choiceIndex}`, header: "MCP",
            question: `${server.name}: ${typeof field.title === "string" ? field.title : name} — include “${value}”?`,
            options: choices(["Include", "Exclude"]) });
          if (answer[0] === "Include") selected.push(value);
          else if (answer[0] !== "Exclude") throw new Error("Choose Include or Exclude for the MCP selection");
        }
        Object.defineProperty(content, name, { value: selected, enumerable: true });
        continue;
      }
      const labels = field.type === "boolean" ? ["true", "false"] : values;
      const optionsForField = labels && labels.length >= 2 && labels.length <= 3 && labels.every((label) => label.length <= 120) ? choices(labels) : [];
      let invalid = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const answer = await ask({ id: `field_${index}`, header: "MCP", question: `${server.name}: ${typeof field.title === "string" ? field.title : name}${typeof field.description === "string" ? `\n${field.description}` : ""}${values ? `\nAllowed values: ${values.join(", ")}` : ""} ${fieldHint(field)}${invalid ? " The previous answer did not match these requirements. Please try again." : ""}`,
          options: optionsForField });
        try {
          const value = parseField(field, answer);
          await validateExternalInputSchema({ type: "object", properties: { value: field }, required: ["value"] }, { value }, context.signal);
          Object.defineProperty(content, name, { value, enumerable: true });
          break;
        } catch (error) {
          context.signal.throwIfAborted();
          if (attempt === 2) throw error;
          invalid = true;
        }
      }
    }
    await validateExternalInputSchema(request.requestedSchema, content, context.signal);
    return { action: "accept", content };
  } catch (error) {
    if (error instanceof UserInputDeniedError && !context.signal.aborted) return { action: "cancel" };
    throw error;
  }
}

function choices(labels: string[]): UserInputQuestion["options"] {
  return labels.map((label) => ({ label, description: label }));
}
function action(value: string | undefined): "accept" | "decline" | "cancel" {
  return value === "Continue" ? "accept" : value === "Decline" ? "decline" : "cancel";
}
function enumValues(schema: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) return schema.enum as string[];
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((value) => (value as { const: string }).const);
  if (schema.type === "array" && schema.items && typeof schema.items === "object") return enumValues(schema.items as Record<string, unknown>);
  return undefined;
}
function parseField(schema: Record<string, unknown>, answers: string[]): string | number | boolean | string[] {
  const first = answers[0]!;
  const enums = enumValues(schema);
  if (schema.type === "boolean") {
    if (first !== "true" && first !== "false") throw new Error("MCP boolean input must be true or false");
    return first === "true";
  }
  if (schema.type === "integer" || schema.type === "number") {
    const value = Number(first);
    if (!first.trim() || !Number.isFinite(value) || schema.type === "integer" && !Number.isSafeInteger(value)) throw new Error("Invalid MCP numeric input");
    return value;
  }
  if (schema.type !== "string" || enums && !enums.includes(first)) throw new Error("Invalid MCP string input");
  return first;
}

function fieldHint(field: Record<string, unknown>): string {
  const hints: string[] = [];
  if (field.type === "integer") hints.push("Enter a whole number.");
  if (field.type === "number") hints.push("Enter a number.");
  if (typeof field.minimum === "number") hints.push(`Minimum: ${field.minimum}.`);
  if (typeof field.maximum === "number") hints.push(`Maximum: ${field.maximum}.`);
  if (typeof field.minLength === "number") hints.push(`At least ${field.minLength} characters.`);
  if (typeof field.maxLength === "number") hints.push(`At most ${field.maxLength} characters.`);
  if (typeof field.format === "string") hints.push(`Format: ${field.format}.`);
  return hints.join(" ");
}
