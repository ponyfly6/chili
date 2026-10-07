import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ModelStreamInput } from "@chili/core";
import type { PreparedModelIdentity, SessionId, TurnId } from "@chili/protocol";
import { createHostModel } from "./model.js";

const input: ModelStreamInput = {
  sessionId: "session_identity" as SessionId,
  turnId: "turn_identity" as TurnId,
  messages: [],
  tools: [],
  system: [],
};

test("Host records resolved provider credentials and profile before allowing network dispatch", async () => {
  let identity: PreparedModelIdentity | undefined;
  let fetchCalls = 0;
  let recorded = false;
  const apiKey = "host-audit-fake-credential";
  const model = await createHostModel({ provider: "deepseek", model: "deepseek-v4-flash" }, {
    apiKey, profileId: "profile-test", baseUrl: "https://provider.invalid",
    fetch: (async () => {
      fetchCalls++;
      expect(recorded).toBe(true);
      return new Response(JSON.stringify({
        id: "completion_1", model: "deepseek-v4-flash",
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  for await (const _ of model.stream({
    ...input,
    onRequestIdentity: async (resolved) => {
      expect(fetchCalls).toBe(0);
      await Promise.resolve();
      identity = resolved;
      recorded = true;
    },
  })) { /* consume */ }
  expect(identity).toEqual({
    provider: "deepseek", model: "deepseek-v4-flash", profileId: "profile-test",
    credentialVersion: `sha256:${createHash("sha256").update(`Bearer ${apiKey}`).digest("hex")}`,
  });
  expect(JSON.stringify(identity)).not.toContain(apiKey);
  expect(fetchCalls).toBe(1);
});

test("Host forwards the total request deadline even when a transport ignores abort", async () => {
  const model = await createHostModel({ provider: "deepseek", model: "deepseek-v4-flash" }, {
    apiKey: "timeout-fake-key", baseUrl: "https://provider.invalid",
    fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
  });
  const consume = async () => { for await (const _ of model.stream({ ...input, requestTimeoutMs: 20 })) { /* consume */ } };
  await expect(consume()).rejects.toMatchObject({ name: "TimeoutError" });
});

test("a failed identity audit prevents Host model network side effects", async () => {
  let calls = 0;
  const model = await createHostModel({ provider: "deepseek", model: "deepseek-v4-flash" }, {
    apiKey: "blocked-fake-key", baseUrl: "https://provider.invalid",
    fetch: (async () => { calls++; throw new Error("unexpected fetch"); }) as unknown as typeof fetch,
  });
  const consume = async () => {
    for await (const _ of model.stream({ ...input, onRequestIdentity: async () => { throw new Error("audit failed"); } })) { /* consume */ }
  };
  await expect(consume()).rejects.toThrow("audit failed");
  expect(calls).toBe(0);
});

test("Host forwards completed reasoning and text boundaries from a provider", async () => {
  const model = await createHostModel({ provider: "deepseek", model: "deepseek-v4-flash" }, {
    apiKey: "completion-fake-key", baseUrl: "https://provider.invalid",
    fetch: (async () => new Response(JSON.stringify({
      id: "completion_blocks", model: "deepseek-v4-flash",
      choices: [{ index: 0, finish_reason: "stop", message: { reasoning_content: "Consider this", content: "The answer" } }],
    }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  });
  const events = [];
  for await (const event of model.stream(input)) events.push(event);
  expect(events.filter((event) => event.type === "reasoning_end" || event.type === "text_end")).toEqual([
    { type: "reasoning_end", index: 0 },
    { type: "text_end", index: 0 },
  ]);
});
