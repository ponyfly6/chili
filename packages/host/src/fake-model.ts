import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import { REVIEWER_SYSTEM_INSTRUCTIONS } from "./approval.js";

export class FakeModelRouter implements ModelRouter {
  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    if (input.system.includes(REVIEWER_SYSTEM_INSTRUCTIONS)) {
      yield { type: "text_delta", text: JSON.stringify({ decision: "allow", reason: "Deterministic fake reviewer fixture." }) };
      yield { type: "finish", reason: "stop" };
      return;
    }
    const discoveryCalls = new Set(input.messages.flatMap((message) => message.parts.flatMap((part) =>
      part.type === "tool_call" && part.toolName === "tool_search" ? [part.callId] : [])));
    const messages = input.messages.map((message) => ({ ...message, parts: message.parts.filter((part) =>
      (part.type !== "tool_call" && part.type !== "tool_result") || !discoveryCalls.has(part.callId)) }))
      .filter((message) => message.parts.length > 0);
    for await (const event of this.fixtureStream({ ...input, messages })) {
      if (event.type === "tool_call" && !input.tools.some((tool) => tool.name === event.name)
        && input.tools.some((tool) => tool.name === "tool_search")) {
        yield { type: "tool_call", name: "tool_search", input: { query: `select:${event.name}` } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      yield event;
    }
  }

  private async *fixtureStream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    const lastUserIndex = findLastUserMessageIndex(input.messages);
    const lastUser = lastUserIndex >= 0 ? input.messages[lastUserIndex] : undefined;
    const lastUserText = lastUser?.parts.find((part) => part.type === "text");
    const text = lastUserText?.type === "text" ? lastUserText.text : "";

    const hasToolResultAfterLatestUser =
      lastUserIndex >= 0 &&
      input.messages.slice(lastUserIndex + 1).some((message) => message.parts.some((part) => part.type === "tool_result"));
    if (hasToolResultAfterLatestUser) {
      yield { type: "text_delta", text: "I read the file and the tool loop works." };
      yield { type: "finish", reason: "stop" };
      return;
    }

    if (text.includes("desktop input fixture")) {
      yield {
        type: "tool_call",
        name: "request_user_input",
        input: {
          questions: [
            {
              id: "desktop_fixture",
              header: "Desktop QA",
              question: "Choose a response for the desktop input fixture.",
              options: [
                { label: "Continue", description: "Resolve the fixture with the primary choice." },
                { label: "Alternate", description: "Resolve the fixture with the alternate choice." },
              ],
            },
          ],
        },
      };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    if (text.includes("desktop review fixture") || text.includes("desktop approval fixture")) {
      yield {
        type: "tool_call",
        name: "bash",
        input: {
          command: "/usr/bin/true",
        },
      };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    if (text.startsWith("desktop delivery fixture: ")) {
      const fixture = JSON.parse(text.slice("desktop delivery fixture: ".length)) as {
        filePath: string;
        title: string;
        description?: string;
      };
      yield { type: "tool_call", name: "present_file", input: fixture };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    if (text.includes("list agents through tool")) {
      yield { type: "tool_call", name: "agent_list", input: {} };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    if (text.includes("read package")) {
      yield { type: "tool_call", name: "read", input: { filePath: "package.json", maxBytes: 4000 } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    if (text.includes("delegate read")) {
      yield {
        type: "tool_call", name: "code_mode",
        input: { code: 'const child = (await tools.agent_spawn({name:"reader",prompt:"read package"})).structuredData; text(await tools.agent_wait({...child,timeoutMs:10000}));' },
      };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    yield { type: "text_delta", text: text ? `Echo: ${text}` : "Chili fake model is ready." };
    yield { type: "finish", reason: "stop" };
  }
}

function findLastUserMessageIndex(messages: ModelStreamInput["messages"]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}
