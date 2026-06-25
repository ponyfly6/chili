import { afterEach, expect, test } from "bun:test";
import type { ModelStreamInput } from "@chili/core";
import type { SessionId, ThreadId, TurnId } from "@chili/protocol";
import { createCliModel, resolveCliRuntimeModelSelection } from "./model.js";

const savedEnv = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  MOONSHOT_BASE_URL: process.env.MOONSHOT_BASE_URL,
  MOONSHOT_MODEL: process.env.MOONSHOT_MODEL,
  KIMI_API_KEY: process.env.KIMI_API_KEY,
  KIMI_BASE_URL: process.env.KIMI_BASE_URL,
  KIMI_MODEL: process.env.KIMI_MODEL,
  OPENAI_CODEX_ACCESS_TOKEN: process.env.OPENAI_CODEX_ACCESS_TOKEN,
  OPENAI_CODEX_BASE_URL: process.env.OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_MODEL: process.env.OPENAI_CODEX_MODEL,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  MINIMAX_BASE_URL: process.env.MINIMAX_BASE_URL,
  MINIMAX_ANTHROPIC_BASE_URL: process.env.MINIMAX_ANTHROPIC_BASE_URL,
  MINIMAX_MODEL: process.env.MINIMAX_MODEL,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
};

afterEach(() => {
  restoreEnv("DEEPSEEK_API_KEY", savedEnv.DEEPSEEK_API_KEY);
  restoreEnv("DEEPSEEK_BASE_URL", savedEnv.DEEPSEEK_BASE_URL);
  restoreEnv("DEEPSEEK_MODEL", savedEnv.DEEPSEEK_MODEL);
  restoreEnv("MOONSHOT_API_KEY", savedEnv.MOONSHOT_API_KEY);
  restoreEnv("MOONSHOT_BASE_URL", savedEnv.MOONSHOT_BASE_URL);
  restoreEnv("MOONSHOT_MODEL", savedEnv.MOONSHOT_MODEL);
  restoreEnv("KIMI_API_KEY", savedEnv.KIMI_API_KEY);
  restoreEnv("KIMI_BASE_URL", savedEnv.KIMI_BASE_URL);
  restoreEnv("KIMI_MODEL", savedEnv.KIMI_MODEL);
  restoreEnv("OPENAI_CODEX_ACCESS_TOKEN", savedEnv.OPENAI_CODEX_ACCESS_TOKEN);
  restoreEnv("OPENAI_CODEX_BASE_URL", savedEnv.OPENAI_CODEX_BASE_URL);
  restoreEnv("OPENAI_CODEX_MODEL", savedEnv.OPENAI_CODEX_MODEL);
  restoreEnv("MINIMAX_API_KEY", savedEnv.MINIMAX_API_KEY);
  restoreEnv("MINIMAX_BASE_URL", savedEnv.MINIMAX_BASE_URL);
  restoreEnv("MINIMAX_ANTHROPIC_BASE_URL", savedEnv.MINIMAX_ANTHROPIC_BASE_URL);
  restoreEnv("MINIMAX_MODEL", savedEnv.MINIMAX_MODEL);
  restoreEnv("ANTHROPIC_BASE_URL", savedEnv.ANTHROPIC_BASE_URL);
  restoreEnv("ANTHROPIC_MODEL", savedEnv.ANTHROPIC_MODEL);
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
    max_tokens: 131072,
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

test("CLI Kimi env resolution uses latest Moonshot OpenAI-compatible endpoint and model", async () => {
  process.env.MOONSHOT_API_KEY = "env-key";
  process.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";
  delete process.env.MOONSHOT_MODEL;

  let url = "";
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_kimi_cli",
        model: "kimi-k2.6",
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const model = await createCliModel("kimi", { fetch: fetchImpl });
  const events = await collect(model.stream(emptyInput()));

  expect(url).toBe("https://api.moonshot.cn/v1/chat/completions");
  expect(body).toMatchObject({
    model: "kimi-k2.6",
    max_tokens: 32768,
  });
  expect(body).not.toHaveProperty("thinking");
  expect(events).toContainEqual(expect.objectContaining({
    type: "metadata",
    provider: "kimi",
    model: "kimi-k2.6",
    contextWindowTokens: 256000,
    maxOutputTokens: 32768,
  }));
});

test("CLI MiniMax env resolution prefers Anthropic-compatible base URL over generic MiniMax base URL", async () => {
  process.env.MINIMAX_API_KEY = "env-key";
  process.env.MINIMAX_BASE_URL = "https://api.minimaxi.com/v1";
  process.env.MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
  delete process.env.ANTHROPIC_BASE_URL;

  let url = "";
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [], stop_reason: "end_turn" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const model = await createCliModel("minimax", { fetch: fetchImpl });
  await collect(model.stream(emptyInput()));

  expect(url).toBe("https://api.minimaxi.com/anthropic/v1/messages");
  expect(body).toMatchObject({ max_tokens: 32768 });
});

test("CLI runtime model selection resolves explicit provider aliases to concrete defaults", () => {
  delete process.env.MINIMAX_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";

  expect(resolveCliRuntimeModelSelection({ model: "minimax" })).toEqual({
    provider: "minimax",
    model: "MiniMax-M3[1m]",
  });
  expect(resolveCliRuntimeModelSelection({ provider: "deepseek" })).toEqual({
    provider: "deepseek",
    model: "deepseek-v4-flash",
  });
  expect(resolveCliRuntimeModelSelection({ model: "kimi" })).toEqual({
    provider: "kimi",
    model: "kimi-k2.6",
  });
  expect(resolveCliRuntimeModelSelection({ model: "fake" })).toBeUndefined();
});

test("CLI Codex env resolution uses ChatGPT Codex endpoint and session metadata", async () => {
  process.env.OPENAI_CODEX_ACCESS_TOKEN = jwtWithAccount("acct_cli");
  process.env.OPENAI_CODEX_BASE_URL = "https://chatgpt.test/backend-api";
  process.env.OPENAI_CODEX_MODEL = "gpt-5.3-codex";

  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      streamText([
        data({ type: "response.created", response: { id: "resp_cli", model: "gpt-5.3-codex" } }),
        data({
          type: "response.completed",
          response: {
            id: "resp_cli",
            model: "gpt-5.3-codex",
            status: "completed",
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
          },
        }),
      ].join("")),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
  }) as typeof fetch;

  const model = await createCliModel("codex", { fetch: fetchImpl });
  const events = await collect(model.stream(emptyInput()));

  expect(url).toBe("https://chatgpt.test/backend-api/codex/responses");
  expect(headers.get("chatgpt-account-id")).toBe("acct_cli");
  expect(headers.get("session_id")).toBe("session_cli_model");
  expect(body).toMatchObject({
    model: "gpt-5.3-codex",
    prompt_cache_key: "session_cli_model",
  });
  expect(body).not.toHaveProperty("max_output_tokens");
  expect(events).toContainEqual(expect.objectContaining({
    type: "metadata",
    provider: "openai-codex",
    model: "gpt-5.3-codex",
    contextWindowTokens: 272000,
    maxOutputTokens: 128000,
  }));
});

test("CLI Codex supports bare concrete model ids with thinking", async () => {
  process.env.OPENAI_CODEX_ACCESS_TOKEN = jwtWithAccount("acct_cli");
  process.env.OPENAI_CODEX_BASE_URL = "https://chatgpt.test/backend-api";
  delete process.env.OPENAI_CODEX_MODEL;

  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return codexResponse(String(body.model));
  }) as typeof fetch;

  const model = await createCliModel("gpt-5.3-codex:high", { fetch: fetchImpl });
  await collect(model.stream(emptyInput()));

  expect(body).toMatchObject({
    model: "gpt-5.3-codex",
    reasoning: { effort: "high", summary: "auto" },
  });
});

test("CLI Codex thinking off omits reasoning options", async () => {
  process.env.OPENAI_CODEX_ACCESS_TOKEN = jwtWithAccount("acct_cli");
  process.env.OPENAI_CODEX_BASE_URL = "https://chatgpt.test/backend-api";
  delete process.env.OPENAI_CODEX_MODEL;

  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return codexResponse(String(body.model));
  }) as typeof fetch;

  const model = await createCliModel("gpt-5.5:off", { fetch: fetchImpl });
  await collect(model.stream(emptyInput()));

  expect(body).toMatchObject({ model: "gpt-5.5" });
  expect(body).not.toHaveProperty("reasoning");
});

test("CLI router passes core modelSelection and reasoningLevel through to provider", async () => {
  process.env.OPENAI_CODEX_ACCESS_TOKEN = jwtWithAccount("acct_cli");
  process.env.OPENAI_CODEX_BASE_URL = "https://chatgpt.test/backend-api";
  delete process.env.OPENAI_CODEX_MODEL;

  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return codexResponse(String(body.model));
  }) as typeof fetch;

  const model = await createCliModel(
    { provider: "openai-codex", model: "gpt-5.5", reasoningLevel: "low" },
    { fetch: fetchImpl },
  );

  await collect(model.stream(emptyInput()));
  await collect(model.stream({
    ...emptyInput(),
    modelSelection: { provider: "openai-codex", model: "gpt-5.3-codex" },
    reasoningLevel: "high",
    serviceTier: "fast",
  } as ModelStreamInput & {
    modelSelection: { provider: string; model: string };
    reasoningLevel: string;
    serviceTier: "fast";
  }));

  expect(bodies).toHaveLength(2);
  expect(bodies.at(0)).toMatchObject({
    model: "gpt-5.5",
    reasoning: { effort: "low", summary: "auto" },
  });
  expect(bodies.at(1)).toMatchObject({
    model: "gpt-5.3-codex",
    reasoning: { effort: "high", summary: "auto" },
    service_tier: "priority",
  });
});

test("CLI DeepSeek reasoning off disables thinking", async () => {
  process.env.DEEPSEEK_API_KEY = "env-key";
  process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com";
  delete process.env.DEEPSEEK_MODEL;

  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_cli",
        model: "deepseek-v4-pro",
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const model = await createCliModel({ provider: "deepseek", reasoningLevel: "off" }, { fetch: fetchImpl });
  await collect(model.stream(emptyInput()));

  expect(body).toMatchObject({
    model: "deepseek-v4-pro",
    thinking: { type: "disabled" },
  });
  expect(body).not.toHaveProperty("reasoning_effort");
});

test("CLI Kimi thinking off disables thinking with Moonshot's documented switch", async () => {
  process.env.MOONSHOT_API_KEY = "env-key";
  process.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";
  delete process.env.MOONSHOT_MODEL;

  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_kimi_cli",
        model: "kimi-k2.6",
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const model = await createCliModel({ provider: "kimi", reasoningLevel: "off" }, { fetch: fetchImpl });
  await collect(model.stream(emptyInput()));

  expect(body).toMatchObject({
    model: "kimi-k2.6",
    thinking: { type: "disabled" },
  });
  expect(body).not.toHaveProperty("reasoning_effort");
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

function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function codexResponse(model: string): Response {
  return new Response(
    streamText([
      data({ type: "response.created", response: { id: "resp_cli", model } }),
      data({
        type: "response.completed",
        response: {
          id: "resp_cli",
          model,
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      }),
    ].join("")),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function jwtWithAccount(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `${header}.${payload}.sig`;
}
