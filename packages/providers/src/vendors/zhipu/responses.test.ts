import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, PersistedModelOutput, SessionId, TimestampMs } from "@chili/protocol";
import { findKnownModel } from "../../models.js";
import type { ModelStreamEvent } from "../../types.js";
import { createZhipuModel, createZhipuProvider } from "./domestic-provider.js";
import { createZaiModel, createZaiProvider } from "./provider.js";
import { isGlmResponsesEndpoint, resolveGlmResponsesUrl, ZAI_RESPONSES_BASE_URL, ZHIPU_RESPONSES_BASE_URL } from "./responses.js";

const completed = { type: "response.completed", response: { id: "resp_glm", status: "completed", usage: { input_tokens: 12, output_tokens: 4 } } };

for (const region of [
  { provider: "zhipu", endpoint: ZHIPU_RESPONSES_BASE_URL, create: createZhipuModel, catalog: createZhipuProvider },
  { provider: "zai", endpoint: ZAI_RESPONSES_BASE_URL, create: createZaiModel, catalog: createZaiProvider },
] as const) {
  test(`${region.provider} explicitly selected Responses endpoint uses GLM fields and reports matching catalog`, async () => {
    const transport = capture();
    const model = region.create({ apiKey: "region-key", baseUrl: `${region.endpoint}/`, env: {}, fetch: transport.fetch });
    const events = await collect(model.stream({
      messages: [message("user", [{ type: "text", text: "Inspect this project." }]), message("assistant", [{ type: "text", text: "Checking.", phase: "commentary" }])],
      system: ["System instructions"], developer: ["Developer instructions"],
      reasoning: "off", maxTokens: 4096,
      tools: [{ name: "read", description: "Read file", inputSchema: { type: "object" } }],
    }));
    expect(transport.requests[0]?.url).toBe(`${region.endpoint}/responses`);
    expect(transport.requests[0]?.headers.get("authorization")).toBe("Bearer region-key");
    expect(transport.requests[0]?.body).toMatchObject({
      model: "glm-5.3", store: false, stream: true, max_output_tokens: 4096,
      reasoning: { effort: "low" }, instructions: "System instructions\n\nDeveloper instructions",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect this project." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking." }] },
      ],
      tools: [{ type: "function", name: "read", description: "Read file", parameters: { type: "object" } }],
    });
    for (const field of ["messages", "max_tokens", "reasoning_effort", "thinking", "include", "parallel_tool_calls", "text"]) {
      expect(transport.requests[0]?.body).not.toHaveProperty(field);
    }
    expect(JSON.stringify(transport.requests[0]?.body)).not.toContain('"phase"');
    expect(JSON.stringify(transport.requests[0]?.body)).not.toContain('"strict"');
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    const configuredModels = region.catalog({ baseUrl: region.endpoint, env: {} }).models();
    const catalog = configuredModels.find((entry) => entry.default);
    expect(catalog).toMatchObject({ apiFamily: "openai-responses", baseUrl: region.endpoint });
    expect(configuredModels.find((entry) => entry.model === "glm-5.3-flash")).toMatchObject({ apiFamily: "openai-responses", baseUrl: region.endpoint });
    expect(findKnownModel(region.provider, "glm-5.3")?.apiFamily).toBe("openai-completions");
  });

  test(`${region.provider} Responses preserves plain reasoning and tool continuation only on the same connection`, async () => {
    const reasoningItem = { id: "reason_glm", type: "reasoning", status: "completed", content: { type: "reasoning_text", text: "Inspect the source." } };
    const first = capture([
      { type: "response.reasoning_text.delta", output_index: 0, item_id: "reason_glm", delta: "Inspect " },
      { type: "response.reasoning_text.done", output_index: 0, item_id: "reason_glm", text: "Inspect the source." },
      { type: "response.output_item.done", output_index: 0, item: reasoningItem },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_glm", call_id: rawCallId, name: "read", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_glm", delta: '{"path":"README.md"}' },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_glm", call_id: rawCallId, name: "read", arguments: '{"path":"README.md"}' } },
      completed,
    ]);
    const initial = await collect(region.create({ apiKey: "private-key", baseUrl: region.endpoint, env: {}, fetch: first.fetch }).stream({ messages: [] }));
    const reasoningOutput = initial.find((event) => event.type === "reasoning_item");
    expect(reasoningOutput?.type).toBe("reasoning_item");
    if (reasoningOutput?.type !== "reasoning_item") throw new Error("Missing GLM reasoning item");
    expect(reasoningOutput.output.item).toEqual(reasoningItem);
    expect(JSON.stringify(reasoningOutput.output.source)).not.toContain("private-key");
    expect(initial.filter((event) => event.type === "reasoning_delta").map((event) => event.text).join("")).toBe("Inspect the source.");
    expect(initial).toContainEqual({ type: "tool_call_end", toolCallId: rawCallId, name: "read", input: { path: "README.md" }, index: 1 });
    for (const [key, replay] of [["private-key", true], ["another-key", false]] as const) {
      const next = capture();
      const history = toolHistory(reasoningOutput.output);
      await collect(region.create({ apiKey: key, baseUrl: region.endpoint, env: {}, fetch: next.fetch }).stream({ messages: history }));
      const input = next.requests[0]?.body.input as Array<Record<string, unknown>>;
      expect(input.filter((item) => item.type === "reasoning")).toEqual(replay ? [reasoningItem] : []);
      expect(input).toContainEqual({ type: "function_call", call_id: rawCallId, name: "read", arguments: '{"path":"README.md"}' });
      expect(input).toContainEqual({ type: "function_call_output", call_id: rawCallId, output: "source contents" });
      expect(history[0]?.parts[0]).toMatchObject({ modelOutput: reasoningOutput.output });
    }
  });
}

const rawCallId = "call/glm:" + "x".repeat(100);

test("GLM Responses endpoint detection respects explicit protocols and preserves query parameters", () => {
  expect(resolveGlmResponsesUrl(`${ZHIPU_RESPONSES_BASE_URL}/`)).toBe(`${ZHIPU_RESPONSES_BASE_URL}/responses`);
  expect(resolveGlmResponsesUrl("https://gateway.example/glm/responses/?version=1")).toBe("https://gateway.example/glm/responses?version=1");
  expect(isGlmResponsesEndpoint("https://gateway.example/glm/responses")).toBe(true);
  expect(isGlmResponsesEndpoint("https://gateway.example/api/v1")).toBe(false);
  expect(isGlmResponsesEndpoint("https://open.bigmodel.cn/api/coding/paas/v4")).toBe(false);
  expect(isGlmResponsesEndpoint("https://api.z.ai/api/anthropic")).toBe(false);
  expect(isGlmResponsesEndpoint("file:///api/v1/responses")).toBe(false);
});

test("GLM Responses custom deployment keeps conservative metadata and request defaults", async () => {
  const transport = capture();
  await collect(createZhipuModel({ apiKey: "key", model: "custom-id", baseUrl: "https://gateway.example/responses", env: {}, fetch: transport.fetch })
    .stream({ messages: [], reasoning: "max" }));
  expect(transport.requests[0]?.body).toMatchObject({ model: "custom-id", max_output_tokens: 4096 });
  expect(transport.requests[0]?.body).not.toHaveProperty("reasoning");
  expect(createZhipuProvider({ model: "custom-id", baseUrl: ZHIPU_RESPONSES_BASE_URL, env: {} }).models()[0]).toMatchObject({ apiFamily: "openai-responses" });
});

test("Z.ai Responses catalog excludes its Messages-only 1M alias without changing Messages support", () => {
  expect(createZaiProvider({ baseUrl: ZAI_RESPONSES_BASE_URL, env: {} }).models().some((entry) => entry.model === "glm-5.3[1m]")).toBe(false);
  expect(() => createZaiModel({ apiKey: "key", model: "glm-5.3[1m]", baseUrl: ZAI_RESPONSES_BASE_URL, env: {} })).toThrow("Messages-only alias");
  expect(createZaiProvider({ env: {} }).models().some((entry) => entry.model === "glm-5.3[1m]")).toBe(true);
});

function capture(events: readonly Record<string, unknown>[] = [completed]) {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  return {
    requests,
    fetch: (async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  };
}

function message(role: Message["role"], parts: Array<Record<string, unknown>>): Message {
  const id = `msg_${role}` as MessageId;
  const sessionId = "session_glm" as SessionId;
  return { id, sessionId, role, createdAt: 0 as TimestampMs,
    parts: parts.map((part, index) => ({ id: `part_${role}_${index}` as PartId, messageId: id, sessionId, ...part })) as Message["parts"] };
}

function toolHistory(output: PersistedModelOutput): Message[] {
  return [message("assistant", [
    { type: "reasoning", text: "Inspect the source.", modelOutput: output },
    { type: "tool_call", callId: rawCallId, toolName: "read", input: { path: "README.md" }, status: "pending" },
    { type: "tool_result", callId: rawCallId, output: "source contents" },
  ])];
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
