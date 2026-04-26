import { strict as assert } from "node:assert";
import { createCliModel } from "../apps/cli/src/model.js";

const model = process.argv.includes("--legacy") ? "legacy-minimax" : "minimax";
const mock = process.argv.includes("--mock");
const router = await createCliModel(model, mock ? mockOptions() : { maxTokens: 128 });
const events = [];

for await (const event of router.stream({
  sessionId: "session_probe" as never,
  threadId: "thread_probe" as never,
  turnId: "turn_probe" as never,
  system: ["Reply with exactly: ok"],
  tools: [],
  messages: [
    {
      id: "msg_probe" as never,
      sessionId: "session_probe" as never,
      role: "user",
      createdAt: Date.now() as never,
      parts: [
        {
          id: "part_probe" as never,
          messageId: "msg_probe" as never,
          sessionId: "session_probe" as never,
          type: "text",
          text: "ping",
        },
      ],
    },
  ],
})) {
  events.push(event);
}

const text = events
  .filter((event) => event.type === "text_delta")
  .map((event) => event.text)
  .join("");

assert.equal(text.trim(), "ok");
console.log(`${model}${mock ? " mock" : ""} probe ok`);

function mockOptions(): Parameters<typeof createCliModel>[1] {
  return {
    apiKey: "probe-test-key",
    baseUrl: "https://provider-probe.test/anthropic",
    maxTokens: 128,
    fetch: (async () =>
      new Response(
        JSON.stringify({
          id: "msg_probe_response",
          model: "probe-model",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "stop",
        }),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch,
  };
}
