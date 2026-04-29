import { afterEach, expect, test } from "bun:test";
import type { ModelStreamInput } from "@chili/core";
import type { SessionId, ThreadId, TurnId } from "@chili/protocol";
import { createCliModel } from "./model.js";

const savedEnv = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  MINIMAX_BASE_URL: process.env.MINIMAX_BASE_URL,
  MINIMAX_ANTHROPIC_BASE_URL: process.env.MINIMAX_ANTHROPIC_BASE_URL,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
};

afterEach(() => {
  restoreEnv("DEEPSEEK_API_KEY", savedEnv.DEEPSEEK_API_KEY);
  restoreEnv("DEEPSEEK_BASE_URL", savedEnv.DEEPSEEK_BASE_URL);
  restoreEnv("DEEPSEEK_MODEL", savedEnv.DEEPSEEK_MODEL);
  restoreEnv("MINIMAX_API_KEY", savedEnv.MINIMAX_API_KEY);
  restoreEnv("MINIMAX_BASE_URL", savedEnv.MINIMAX_BASE_URL);
  restoreEnv("MINIMAX_ANTHROPIC_BASE_URL", savedEnv.MINIMAX_ANTHROPIC_BASE_URL);
  restoreEnv("ANTHROPIC_BASE_URL", savedEnv.ANTHROPIC_BASE_URL);
});

test("CLI DeepSeek env resolution uses official V4 OpenAI-compatible endpoint and model", async () => {
  process.env.DEEPSEEK_API_KEY = "env-key";
  process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";

  let url = "";
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_cli",
        model: "deepseek-v4-flash",
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const model = await createCliModel("deepseek", { fetch: fetchImpl });
  const events = await collect(model.stream(emptyInput()));

  expect(url).toBe("https://api.deepseek.com/chat/completions");
  expect(body).toMatchObject({
    model: "deepseek-v4-flash",
    max_tokens: 4096,
    thinking: { type: "enabled" },
  });
  expect(events).toContainEqual(expect.objectContaining({
    type: "metadata",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    contextWindowTokens: 1048576,
    maxOutputTokens: 393216,
  }));
});

test("CLI MiniMax env resolution prefers Anthropic-compatible base URL over generic MiniMax base URL", async () => {
  process.env.MINIMAX_API_KEY = "env-key";
  process.env.MINIMAX_BASE_URL = "https://api.minimaxi.com/v1";
  process.env.MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
  delete process.env.ANTHROPIC_BASE_URL;

  let url = "";
  const fetchImpl = (async (input) => {
    url = String(input);
    return new Response(JSON.stringify({ content: [], stop_reason: "end_turn" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const model = await createCliModel("minimax", { fetch: fetchImpl });
  await collect(model.stream(emptyInput()));

  expect(url).toBe("https://api.minimaxi.com/anthropic/v1/messages");
});

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const _event of stream) {
    events.push(_event);
  }
  return events;
}

function emptyInput(): ModelStreamInput {
  return {
    sessionId: "session_cli_model" as SessionId,
    threadId: "thread_cli_model" as ThreadId,
    turnId: "turn_cli_model" as TurnId,
    messages: [],
    tools: [],
    system: [],
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
