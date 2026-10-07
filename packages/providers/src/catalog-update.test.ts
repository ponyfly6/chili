import { expect, test } from "bun:test";
import type { Message, MessageId, PartId, SessionId, TimestampMs } from "@chili/protocol";
import { createKimiModel } from "./kimi.js";
import { createMiniMaxM3Model } from "./minimax.js";
import { findKnownModel, listKnownModels } from "./models.js";
import { resolveChatCompletionsCompatibility } from "./compat.js";
import { resolveModelSelectionPattern } from "./model-selection.js";
import type { BuiltinProviderId } from "./provider-definition.js";
import { createRegisteredProviderModel, resolveProviderModelOptions } from "./provider-registry.js";
import type { ChiliModel, ModelStreamInput, ReasoningLevel } from "./types.js";

function message(role: Message["role"], content: "image" | "reasoning"): Message {
  const base = { id: "part_catalog" as PartId, messageId: "msg_catalog" as MessageId, sessionId: "session_catalog" as SessionId };
  return {
    id: base.messageId, sessionId: base.sessionId, role, createdAt: 1 as TimestampMs,
    parts: content === "image"
      ? [{ ...base, type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]
      : [{ ...base, type: "reasoning", text: "prior reasoning" }],
  };
}

function transport(capture: (body: Record<string, unknown>) => void): typeof fetch {
  return (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    capture(body);
    return String(body.model).startsWith("MiniMax-")
      ? Response.json({ id: "msg_catalog", content: [], stop_reason: "end_turn" })
      : Response.json({ id: "chat_catalog", choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }] });
  }) as typeof fetch;
}

async function consume(model: ChiliModel, input: ModelStreamInput): Promise<void> {
  const events = [];
  for await (const event of model.stream(input)) events.push(event);
  expect(events.at(-1)?.type).toBe("finish");
}

const visionModels: readonly [BuiltinProviderId, string][] = [
  ["deepseek", "deepseek-flash"], ["deepseek", "deepseek-v4-flash"],
  ["kimi", "kimi-k2.7-code"], ["kimi", "kimi-k2.7-code-highspeed"],
  ["zai", "glm-5.3-flash"], ["zai", "glm-5.3-flashx"],
  ["xai", "grok-4.7"], ["minimax", "MiniMax-M3.1-Flash-Preview"],
];

for (const [provider, model] of visionModels) {
  test(`${model} is selectable and sends images through its registered adapter`, async () => {
    let sent: Record<string, unknown> = {};
    const selection = resolveModelSelectionPattern(`${provider}/${model}`, listKnownModels());
    expect(selection?.selection).toMatchObject({ provider, model });
    const options = resolveProviderModelOptions(provider, {
      env: {}, model, apiKey: "fake-catalog-key", fetch: transport((body) => { sent = body; }),
    }, { reasoningLevel: "ultra" });
    await consume(createRegisteredProviderModel(provider, options), {
      messages: [message("user", "image")],
      tools: [{ name: "inspect", description: "Inspect", inputSchema: { type: "object" } }],
    });
    expect(sent.model).toBe(model);
    expect(sent.messages).toEqual([{ role: "user", content: provider === "minimax"
      ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }]
      : [{ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }],
    }]);
    if (provider === "zai") {
      expect(sent).toMatchObject({ thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "max", tool_stream: true });
    }
    if (provider === "deepseek") expect(sent).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    if (provider === "xai") expect(sent.reasoning_effort).toBe("xhigh");
    if (provider === "minimax") expect(sent.output_config).toEqual({ effort: "max" });
  });
}

test("text-only DeepSeek Pro and GLM flagship still reject image input before dispatch", async () => {
  for (const [provider, model] of [["deepseek", "deepseek-v4-pro"], ["zai", "glm-5.3"]] as const) {
    let calls = 0;
    const options = resolveProviderModelOptions(provider, { env: {}, model, apiKey: "fake-key", fetch: transport(() => { calls += 1; }) });
    await expect(consume(createRegisteredProviderModel(provider, options), { messages: [message("user", "image")] })).rejects.toThrow("does not support image input");
    expect(calls).toBe(0);
  }
});

for (const model of ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"]) {
  test(`${model} preserves reasoning and cannot send disabled thinking or configurable effort`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const kimi = createKimiModel({ env: {}, model, apiKey: "fake-key", reasoning: false, reasoningEffort: "max", temperature: 0.2, fetch: transport((body) => bodies.push(body)) });
    await consume(kimi, { messages: [message("assistant", "reasoning")], reasoning: "off" });
    expect(bodies[0]).toMatchObject({
      thinking: { type: "enabled", keep: "all" }, temperature: 1, max_completion_tokens: 131072,
      messages: [{ role: "assistant", content: null, reasoning_content: "prior reasoning" }],
    });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(bodies[0]).not.toHaveProperty("max_tokens");
  });
}

test("MiniMax preview maps per-request effort and keeps omitted effort at the server default", async () => {
  const bodies: Record<string, unknown>[] = [];
  const model = createMiniMaxM3Model({ env: {}, model: "MiniMax-M3.1-Flash-Preview", apiKey: "fake-key", fetch: transport((body) => bodies.push(body)) });
  await consume(model, { messages: [] });
  expect(bodies[0]).not.toHaveProperty("output_config");
  const levels: readonly [ReasoningLevel, string][] = [["off", "low"], ["medium", "medium"], ["xhigh", "xhigh"], ["ultra", "max"]];
  for (const [reasoning, expected] of levels) {
    await consume(model, { messages: [], reasoning });
    expect(bodies.at(-1)).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: expected } });
  }
  const legacy = createMiniMaxM3Model({ env: {}, apiKey: "fake-key", reasoningEffort: "max", fetch: transport((body) => bodies.push(body)) });
  await consume(legacy, { messages: [], reasoning: "off" });
  expect(bodies.at(-1)).toMatchObject({ thinking: { type: "disabled" } });
  expect(bodies.at(-1)).not.toHaveProperty("output_config");
});

test("generic Chat Completions detection agrees with the new model contracts", () => {
  expect(resolveChatCompletionsCompatibility({ provider: "xai", model: "grok-4.7" })).toMatchObject({ supportsReasoningEffort: true, reasoningEffortMap: { ultra: "xhigh" } });
  expect(resolveChatCompletionsCompatibility({ provider: "kimi", model: "kimi-k2.7-code-highspeed" })).toMatchObject({ supportsReasoningEffort: false, reasoningParameterStyle: "moonshot-k2.7", maxTokensField: "max_completion_tokens" });
});

test("reference prices distinguish currencies and do not invent preview pricing or output limits", () => {
  expect(findKnownModel("kimi", "kimi-k3")?.cost).toMatchObject({ currency: "CNY", input: 20, cacheWrite: 20 });
  expect(findKnownModel("minimax", "MiniMax-M3")?.cost).toMatchObject({ currency: "CNY", input: 2.1 });
  expect(findKnownModel("deepseek", "deepseek-flash")?.cost?.notes).toContain("peak");
  expect(findKnownModel("xai", "grok-4.7")?.cost?.notes).toContain("200K");
  expect(findKnownModel("minimax", "MiniMax-M3.1-Flash-Preview")).not.toHaveProperty("cost");
  for (const [provider, model] of [["minimax", "MiniMax-M3.1-Flash-Preview"], ["kimi", "kimi-k2.7-code"], ["kimi", "kimi-k2.7-code-highspeed"], ["xai", "grok-4.7"]] as const) {
    expect(findKnownModel(provider, model)).not.toHaveProperty("maxOutputTokens");
  }
});
