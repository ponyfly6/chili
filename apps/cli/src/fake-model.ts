import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";

export class FakeModelRouter implements ModelRouter {
  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    const lastUserIndex = findLastUserMessageIndex(input.messages);
    const lastUser = lastUserIndex >= 0 ? input.messages[lastUserIndex] : undefined;
    const lastUserText = lastUser?.parts.find((part) => part.type === "text");
    const text = lastUserText?.type === "text" ? lastUserText.text : "";

    if (text.includes("team parallel tool loop")) {
      const toolCalls = toolCallsAfterLatestUser(input.messages, lastUserIndex);
      if (!hasToolCall(toolCalls, "team_create")) {
        yield {
          type: "tool_call",
          name: "team_create",
          input: { team_id: "team_fake_parallel", name: "Fake parallel team", lead_path: "/root" },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (!hasToolCall(toolCalls, "team_member_add", (call) => call.input.path === "/root/core")) {
        yield {
          type: "tool_call",
          name: "team_member_add",
          input: {
            team_id: "team_fake_parallel",
            path: "/root/core",
            name: "core",
            role: "implementation",
            tool_scope: ["read"],
            write_scope: ["packages/core"],
          },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (!hasToolCall(toolCalls, "team_member_add", (call) => call.input.path === "/root/docs")) {
        yield {
          type: "tool_call",
          name: "team_member_add",
          input: {
            team_id: "team_fake_parallel",
            path: "/root/docs",
            name: "docs",
            role: "documentation",
            tool_scope: ["read"],
            write_scope: ["docs"],
          },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (!hasToolCall(toolCalls, "team_task_create_batch")) {
        yield {
          type: "tool_call",
          name: "team_task_create_batch",
          input: {
            team_id: "team_fake_parallel",
            created_by: "/root",
            tasks: [
              {
                task_id: "task_core",
                title: "Core model path",
                required_tools: ["read"],
              },
              {
                task_id: "task_docs",
                title: "Docs model path",
                required_tools: ["read"],
              },
            ],
          },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (!hasToolCall(toolCalls, "team_run_loop")) {
        yield {
          type: "tool_call",
          name: "team_run_loop",
          input: {
            team_id: "team_fake_parallel",
            once: true,
            timeout_ms: 10_000,
            max_concurrent_dispatches: 2,
          },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text: "Team parallel tool loop works." };
      yield { type: "finish", reason: "stop" };
      return;
    }

    const hasToolResultAfterLatestUser =
      lastUserIndex >= 0 &&
      input.messages.slice(lastUserIndex + 1).some((message) => message.parts.some((part) => part.type === "tool_result"));
    if (hasToolResultAfterLatestUser) {
      yield { type: "text_delta", text: "I read the file and the tool loop works." };
      yield { type: "finish", reason: "stop" };
      return;
    }

    if (text.includes("list tasks through tool")) {
      yield { type: "tool_call", name: "task_list", input: { all: true, limit: 20 } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    const waitTask = /wait task\s+(task_[^\s]+)/.exec(text);
    if (waitTask?.[1]) {
      yield { type: "tool_call", name: "task_wait", input: { task_id: waitTask[1], timeout_ms: 5000 } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    const followupTask = /followup task\s+(task_[^\s]+)/.exec(text);
    if (followupTask?.[1]) {
      yield {
        type: "tool_call",
        name: "task_followup",
        input: { task_id: followupTask[1], text: "continue the task from fake model", max_turns: 3 },
      };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    if (text.includes("list mailbox through tool")) {
      yield { type: "tool_call", name: "mailbox_list", input: { all: true, status: "queued", limit: 20 } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    if (text.includes("read package")) {
      yield { type: "tool_call", name: "read", input: { filePath: "package.json", maxBytes: 4000 } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }

    if (text.includes("delegate background read")) {
      yield {
        type: "tool_call",
        name: "task",
        input: {
          description: "Read package through a background subagent",
          prompt: "read package",
          mode: "background",
        },
      };
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

function findLastUserMessageIndex(messages: ModelStreamInput["messages"]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

type ObservedToolCall = {
  name: string;
  input: Record<string, unknown>;
};

function toolCallsAfterLatestUser(messages: ModelStreamInput["messages"], lastUserIndex: number): ObservedToolCall[] {
  if (lastUserIndex < 0) return [];
  const calls: ObservedToolCall[] = [];
  for (const message of messages.slice(lastUserIndex + 1)) {
    for (const part of message.parts) {
      if (part.type !== "tool_call") continue;
      calls.push({
        name: part.toolName,
        input: isRecord(part.input) ? part.input : {},
      });
    }
  }
  return calls;
}

function hasToolCall(
  calls: readonly ObservedToolCall[],
  name: string,
  predicate: (call: ObservedToolCall) => boolean = () => true,
): boolean {
  return calls.some((call) => call.name === name && predicate(call));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
