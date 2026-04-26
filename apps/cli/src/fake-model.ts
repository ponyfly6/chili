import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";

export class FakeModelRouter implements ModelRouter {
  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    const lastUser = [...input.messages]
      .reverse()
      .flatMap((message) => message.parts)
      .find((part) => part.type === "text");
    const text = lastUser?.type === "text" ? lastUser.text : "";

    const hasToolResult = input.messages.some((message) => message.parts.some((part) => part.type === "tool_result"));
    if (hasToolResult) {
      yield { type: "text_delta", text: "I read the file and the tool loop works." };
      yield { type: "finish", reason: "stop" };
      return;
    }

    if (text.includes("read package")) {
      yield { type: "tool_call", name: "read", input: { filePath: "package.json", maxBytes: 4000 } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    if (text.includes("delegate read")) {
      yield {
        type: "tool_call",
        name: "task",
        input: {
          description: "Read package through a subagent",
          prompt: "read package",
          mode: "one_shot",
        },
      };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    yield { type: "text_delta", text: text ? `Echo: ${text}` : "Chili fake model is ready." };
    yield { type: "finish", reason: "stop" };
  }
}
