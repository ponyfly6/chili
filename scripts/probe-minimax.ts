import { strict as assert } from "node:assert";
import { ProviderError } from "../packages/providers/src/index.js";
import { createCliModel } from "../apps/cli/src/model.js";

const model = "minimax/MiniMax-M3";

export async function runMiniMaxProbe(mock = false): Promise<void> {
  const router = await createCliModel(model, {
    maxTokens: 128,
    reasoningLevel: "off",
    ...(mock ? mockOptions() : {}),
  });
  const events = [];
  for await (const event of router.stream({
    sessionId: "session_probe" as never,
    turnId: "turn_probe" as never,
    system: ["Reply with exactly: ok"],
    tools: [],
    messages: [{
      id: "msg_probe" as never, sessionId: "session_probe" as never, role: "user",
      createdAt: Date.now() as never,
      parts: [{ id: "part_probe" as never, messageId: "msg_probe" as never,
        sessionId: "session_probe" as never, type: "text", text: "ping" }],
    }],
  })) events.push(event);
  const text = events.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
  assert.equal(text.trim(), "ok");
  assert(events.some((event) => event.type === "finish"));
  console.log(`minimax/MiniMax-M3${mock ? " mock" : ""} Responses probe ok`);
}

/** Do not print provider messages, request bodies, headers, or credentials. */
export function probeFailureCategory(error: unknown): string {
  if (error instanceof ProviderError) {
    return `${error.category}${error.status === undefined ? "" : ` (HTTP ${error.status})`}`;
  }
  const message = error instanceof Error ? error.message : "";
  const status = /HTTP\s+(\d{3})\b/.exec(message)?.[1];
  if (status === "401" || status === "403") return `authentication-or-access (HTTP ${status})`;
  if (status === "400" || status === "404" || status === "422") return `request-or-model-configuration (HTTP ${status})`;
  if (status === "429") return "quota-or-rate-limit (HTTP 429)";
  if (status) return `provider-http (HTTP ${status})`;
  if (/requires an API key/i.test(message)) return "missing-api-key";
  if (/migrate|absolute HTTP|invalid.*URL/i.test(message)) return "endpoint-configuration";
  if (/timeout|deadline|abort/i.test(message)) return "timeout-or-cancelled";
  if (error instanceof assert.AssertionError) return "unexpected-protocol-or-output";
  return "network-or-provider-response";
}

function mockOptions(): Parameters<typeof createCliModel>[1] {
  return {
    apiKey: "probe-test-key",
    baseUrl: "https://provider-probe.test/v1",
    fetch: (async (url, init) => {
      assert.equal(String(url), "https://provider-probe.test/v1/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "MiniMax-M3");
      assert.equal(body.stream, true);
      assert.equal(body.max_output_tokens, 128);
      assert.deepEqual(body.reasoning, { effort: "none" });
      assert(Array.isArray(body.input));
      assert(!("messages" in body));
      assert(!("thinking" in body));
      assert(!("max_tokens" in body));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer probe-test-key");
      const output = [{ type: "message", id: "msg_probe_response", role: "assistant",
        status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }];
      const events = [
        { type: "response.created", response: { id: "resp_probe", status: "in_progress", model: "MiniMax-M3" } },
        { type: "response.output_item.added", output_index: 0, item: { ...output[0], status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: "msg_probe_response", output_index: 0, content_index: 0, delta: "ok" },
        { type: "response.completed", response: { id: "resp_probe", status: "completed", model: "MiniMax-M3", output,
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  };
}

if (import.meta.main) {
  try { await runMiniMaxProbe(process.argv.includes("--mock")); }
  catch (error) {
    console.error(`MiniMax Responses probe failed: ${probeFailureCategory(error)}`);
    process.exitCode = 1;
  }
}
