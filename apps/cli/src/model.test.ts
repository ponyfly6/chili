import { afterEach, expect, test } from "bun:test";
import type { ModelStreamInput } from "@chili/core";
import type { SessionId, TurnId } from "@chili/protocol";
import { FileAuthStorage, type OAuthCredential } from "@chili/providers";
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
  ZAI_API_KEY: process.env.ZAI_API_KEY,
  ZAI_BASE_URL: process.env.ZAI_BASE_URL,
  ZAI_MODEL: process.env.ZAI_MODEL,
  XAI_API_KEY: process.env.XAI_API_KEY,
  XAI_BASE_URL: process.env.XAI_BASE_URL,
  XAI_MODEL: process.env.XAI_MODEL,
  CODEX_API_KEY: process.env.CODEX_API_KEY,
  CODEX_API_BASE_URL: process.env.CODEX_API_BASE_URL,
  CODEX_API_MODEL: process.env.CODEX_API_MODEL,
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
  restoreEnv("ZAI_API_KEY", savedEnv.ZAI_API_KEY);
  restoreEnv("ZAI_BASE_URL", savedEnv.ZAI_BASE_URL);
  restoreEnv("ZAI_MODEL", savedEnv.ZAI_MODEL);
  restoreEnv("XAI_API_KEY", savedEnv.XAI_API_KEY);
  restoreEnv("XAI_BASE_URL", savedEnv.XAI_BASE_URL);
  restoreEnv("XAI_MODEL", savedEnv.XAI_MODEL);
  restoreEnv("CODEX_API_KEY", savedEnv.CODEX_API_KEY);
  restoreEnv("CODEX_API_BASE_URL", savedEnv.CODEX_API_BASE_URL);
  restoreEnv("CODEX_API_MODEL", savedEnv.CODEX_API_MODEL);
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
  const limits = await model.resolveRequestLimits?.({});
  const events = await collect(model.stream(emptyInput()));

  expect(url).toBe("https://api.deepseek.com/chat/completions");
  expect(body).toMatchObject({
    model: "deepseek-v4-flash",
    max_tokens: 131072,
    thinking: { type: "enabled" },
  });
  expect(limits).toEqual({ contextWindowTokens: 1048576, requestMaxOutputTokens: 131072 });
  expect(events).toContainEqual(expect.objectContaining({
    type: "metadata",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    contextWindowTokens: 1048576,
    maxOutputTokens: 384000,
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
        model: "kimi-k3",
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
    model: "kimi-k3",
    max_completion_tokens: 131072,
  });
  expect(body).not.toHaveProperty("thinking");
  expect(events).toContainEqual(expect.objectContaining({
    type: "metadata",
    provider: "kimi",
    model: "kimi-k3",
    contextWindowTokens: 1048576,
    maxOutputTokens: 1048576,
  }));
});

test("CLI Z.ai env resolution uses GLM-5.3 and maps xhigh to max effort", async () => {
  process.env.ZAI_API_KEY = "env-key";
  process.env.ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
  delete process.env.ZAI_MODEL;

  let url = "";
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_zai_cli",
        model: "glm-5.3",
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const model = await createCliModel("glm-5.3:xhigh", { fetch: fetchImpl });
  const limits = await model.resolveRequestLimits?.({});
  const events = await collect(model.stream(emptyInput()));

  expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
  expect(body).toMatchObject({
    model: "glm-5.3",
    max_tokens: 131072,
    thinking: { type: "enabled" },
    reasoning_effort: "max",
  });
  expect(limits).toEqual({ contextWindowTokens: 1000000, requestMaxOutputTokens: 131072 });
  expect(events).toContainEqual(expect.objectContaining({
    type: "metadata",
    provider: "zai",
    model: "glm-5.3",
    contextWindowTokens: 1000000,
    maxOutputTokens: 131072,
  }));
});

test("CLI Z.ai 1M alias selects the Anthropic endpoint from the model catalog", async () => {
  process.env.ZAI_API_KEY = "env-key";
  delete process.env.ZAI_BASE_URL;
  delete process.env.ZAI_MODEL;

  let url = "";
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "msg_zai_cli",
        model: "glm-5.3[1m]",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const model = await createCliModel("glm-5.3[1m]", { fetch: fetchImpl });
  const limits = await model.resolveRequestLimits?.({});
  const events = await collect(model.stream(emptyInput()));

  expect(url).toBe("https://api.z.ai/api/anthropic/v1/messages");
  expect(body).toMatchObject({
    model: "glm-5.3[1m]",
    max_tokens: 131072,
    stream: true,
  });
  expect(limits).toEqual({ contextWindowTokens: 1000000, requestMaxOutputTokens: 131072 });
  expect(events).toContainEqual(expect.objectContaining({
    type: "metadata",
    provider: "zai",
    model: "glm-5.3[1m]",
    contextWindowTokens: 1000000,
    maxOutputTokens: 131072,
  }));
});

test("CLI grok alias routes to xAI Grok 4.6 with documented reasoning parameters", async () => {
  process.env.XAI_API_KEY = "env-key";
  process.env.XAI_BASE_URL = "https://api.x.ai/v1";
  delete process.env.XAI_MODEL;

  let url = "";
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_grok_cli",
        model: "grok-4.6",
        choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const model = await createCliModel("grok:xhigh", { fetch: fetchImpl });
  const limits = await model.resolveRequestLimits?.({});
  const events = await collect(model.stream(emptyInput()));

  expect(url).toBe("https://api.x.ai/v1/chat/completions");
  expect(body).toMatchObject({
    model: "grok-4.6",
    max_completion_tokens: 128000,
    reasoning_effort: "xhigh",
  });
  expect(body).not.toHaveProperty("thinking");
  expect(limits).toEqual({ contextWindowTokens: 500000, requestMaxOutputTokens: 128000 });
  expect(events).toContainEqual(expect.objectContaining({
    type: "metadata",
    provider: "xai",
    model: "grok-4.6",
    contextWindowTokens: 500000,
  }));
});

test("CLI MiniMax env resolution prefers Anthropic-compatible base URL over generic MiniMax base URL", async () => {
  process.env.MINIMAX_API_KEY = "env-key";
  process.env.MINIMAX_BASE_URL = "https://api.minimaxi.com/v1";
  process.env.MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.MINIMAX_MODEL;
  delete process.env.ANTHROPIC_MODEL;

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
  expect(body).toMatchObject({
    model: "MiniMax-M3",
    max_tokens: 131072,
    thinking: { type: "adaptive" },
  });
});

test("CLI runtime model selection resolves explicit provider aliases to concrete defaults", () => {
  delete process.env.MINIMAX_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.MOONSHOT_MODEL;
  delete process.env.KIMI_MODEL;
  delete process.env.ZAI_MODEL;
  delete process.env.XAI_MODEL;
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";
  process.env.CODEX_API_MODEL = "gpt-5.6-terra";
  process.env.OPENAI_CODEX_MODEL = "gpt-5.6-luna";

  expect(resolveCliRuntimeModelSelection({ model: "minimax" })).toEqual({
    provider: "minimax",
    model: "MiniMax-M3",
  });
  expect(resolveCliRuntimeModelSelection({ provider: "deepseek" })).toEqual({
    provider: "deepseek",
    model: "deepseek-v4-flash",
  });
  expect(resolveCliRuntimeModelSelection({ model: "kimi" })).toEqual({
    provider: "kimi",
    model: "kimi-k3",
  });
  expect(resolveCliRuntimeModelSelection({ model: "glm" })).toEqual({
    provider: "zai",
    model: "glm-5.3",
  });
  expect(resolveCliRuntimeModelSelection({ model: "grok" })).toEqual({
    provider: "xai",
    model: "grok-4.6",
  });
  expect(resolveCliRuntimeModelSelection({ model: "xai/grok-4.6" })).toEqual({
    provider: "xai",
    model: "grok-4.6",
  });
  expect(resolveCliRuntimeModelSelection({ model: "grok-4.6" })).toEqual({
    provider: "xai",
    model: "grok-4.6",
  });
  expect(resolveCliRuntimeModelSelection({ model: "codex" })).toEqual({
    provider: "openai-codex",
    model: "gpt-6.1-sol",
  });
  expect(resolveCliRuntimeModelSelection({ model: "codex-api" })).toEqual({
    provider: "codex-api",
    model: "gpt-5.6-terra",
  });
  expect(resolveCliRuntimeModelSelection({ model: "codex-api/gpt-5.6" })).toEqual({
    provider: "codex-api",
    model: "gpt-5.6-sol",
  });
  expect(resolveCliRuntimeModelSelection({ model: "gpt-5.6" })).toEqual({
    provider: "openai-codex",
    model: "gpt-5.6-sol",
  });
  expect(resolveCliRuntimeModelSelection({ model: "fake" })).toBeUndefined();
});

test("CLI runtime model selection rejects pre-5.6 Codex models", () => {
  delete process.env.OPENAI_CODEX_MODEL;
  expect(() => resolveCliRuntimeModelSelection({ model: "gpt-5.5" })).toThrow(
    'Unsupported OpenAI Codex model "gpt-5.5"',
  );
  expect(() => resolveCliRuntimeModelSelection({ model: "codex-api/gpt-5.5" })).toThrow(
    'Unsupported Codex API model "gpt-5.5"',
  );
  expect(() => resolveCliRuntimeModelSelection({ model: "gpt-5.4" })).toThrow(
    'Unsupported OpenAI Codex model "gpt-5.4"',
  );

  process.env.OPENAI_CODEX_MODEL = "gpt-5.3-codex";
  expect(resolveCliRuntimeModelSelection({ model: "codex" })).toEqual({
    provider: "openai-codex",
    model: "gpt-6.1-sol",
  });
  expect(() => resolveCliRuntimeModelSelection({ model: "codex-api" })).toThrow(
    'Unsupported Codex API model "gpt-5.3-codex"',
  );
});

test("CLI ChatGPT Codex ignores API env and uses OAuth endpoint and headers", async () => {
  process.env.CODEX_API_KEY = "third-party-key";
  process.env.CODEX_API_BASE_URL = "https://gateway.test/v1";
  process.env.CODEX_API_MODEL = "gpt-5.6-terra";
  process.env.OPENAI_CODEX_ACCESS_TOKEN = "legacy-third-party-key";
  process.env.OPENAI_CODEX_BASE_URL = "https://legacy-gateway.test/v1";
  process.env.OPENAI_CODEX_MODEL = "gpt-5.6-luna";

  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      streamText([
        data({ type: "response.created", response: { id: "resp_cli", model: "gpt-6.1-sol" } }),
        data({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: "reasoning_cli",
            type: "reasoning",
            summary: [],
            status: "completed",
            encrypted_content: "cli-ciphertext",
          },
        }),
        data({
          type: "response.completed",
          response: {
            id: "resp_cli",
            model: "gpt-6.1-sol",
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

  const model = await createCliModel("codex", { fetch: fetchImpl, authStorage: oauthStorage() });
  const limits = await model.resolveRequestLimits?.({});
  const events = await collect(model.stream(emptyInput()));

  expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(headers.get("authorization")).toBe(`Bearer ${jwtWithAccount("acct_cli")}`);
  expect(headers.get("chatgpt-account-id")).toBe("acct_cli");
  expect(headers.get("openai-beta")).toBe("responses=experimental");
  expect(headers.get("session_id")).toBe("session_cli_model");
  expect(body).toMatchObject({
    model: "gpt-6.1-sol",
    prompt_cache_key: "session_cli_model",
  });
  expect(body).not.toHaveProperty("max_output_tokens");
  expect(limits).toEqual({ contextWindowTokens: 1050000, requestMaxOutputTokens: 128000 });
  expect(events).toContainEqual(expect.objectContaining({
    type: "metadata",
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
  }));
  expect(events).toContainEqual({
    type: "reasoning_item",
    output: {
      apiFamily: "openai-responses",
      outputIndex: 0,
      item: {
        id: "reasoning_cli",
        type: "reasoning",
        summary: [],
        status: "completed",
        encrypted_content: "cli-ciphertext",
      },
    },
  });
});

test("CLI Codex API uses its key, endpoint, headers, and new env precedence", async () => {
  process.env.CODEX_API_KEY = "codex-api-key";
  process.env.CODEX_API_BASE_URL = "https://gateway.test/v1";
  process.env.CODEX_API_MODEL = "gpt-5.6-terra";
  process.env.OPENAI_CODEX_ACCESS_TOKEN = "legacy-key";
  process.env.OPENAI_CODEX_BASE_URL = "https://legacy-gateway.test/v1";
  process.env.OPENAI_CODEX_MODEL = "gpt-5.6-luna";

  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return codexResponse(String(body.model));
  }) as typeof fetch;

  const model = await createCliModel("codex-api", { fetch: fetchImpl });
  const events = await collect(model.stream(emptyInput()));

  expect(url).toBe("https://gateway.test/v1/responses");
  expect(headers.get("authorization")).toBe("Bearer codex-api-key");
  expect(headers.get("chatgpt-account-id")).toBeNull();
  expect(headers.get("openai-beta")).toBeNull();
  expect(body).toMatchObject({
    model: "gpt-5.6-terra",
    max_output_tokens: 128000,
  });
  expect(events).toContainEqual(expect.objectContaining({
    type: "metadata",
    provider: "codex-api",
    model: "gpt-5.6-terra",
  }));
});

test("CLI Codex API accepts legacy OPENAI_CODEX env only as a fallback", async () => {
  delete process.env.CODEX_API_KEY;
  delete process.env.CODEX_API_BASE_URL;
  delete process.env.CODEX_API_MODEL;
  process.env.OPENAI_CODEX_ACCESS_TOKEN = "legacy-key";
  process.env.OPENAI_CODEX_BASE_URL = "https://legacy-gateway.test/v1";
  process.env.OPENAI_CODEX_MODEL = "gpt-5.6-terra";

  let url = "";
  let authorization = "";
  const fetchImpl = (async (input, init) => {
    url = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return codexResponse("gpt-5.6-terra");
  }) as typeof fetch;

  const model = await createCliModel("codex-api", { fetch: fetchImpl });
  await collect(model.stream(emptyInput()));

  expect(url).toBe("https://legacy-gateway.test/v1/responses");
  expect(authorization).toBe("Bearer legacy-key");
});

test("CLI rejects API key and endpoint options for OAuth-only openai-codex", async () => {
  await expect(createCliModel("codex", { apiKey: "wrong-key" })).rejects.toThrow(
    "openai-codex is OAuth-only; use codex-api",
  );
  await expect(createCliModel("codex", { baseUrl: "https://gateway.test/v1" })).rejects.toThrow(
    "openai-codex is OAuth-only; use codex-api",
  );
});

test("CLI Codex request limits follow a per-request model override", async () => {
  process.env.OPENAI_CODEX_ACCESS_TOKEN = jwtWithAccount("acct_cli");
  process.env.OPENAI_CODEX_MODEL = "gpt-5.6-sol";

  const model = await createCliModel("codex");
  const limits = await model.resolveRequestLimits?.({
    modelSelection: { provider: "openai-codex", model: "gpt-5.6-luna" },
  });

  expect(limits).toEqual({ contextWindowTokens: 1050000, requestMaxOutputTokens: 128000 });
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

  const model = await createCliModel("gpt-5.6-terra:high", { fetch: fetchImpl, authStorage: oauthStorage() });
  await collect(model.stream(emptyInput()));

  expect(body).toMatchObject({
    model: "gpt-5.6-terra",
    reasoning: { effort: "high", summary: "auto" },
  });
});

test("CLI Codex maps ultra reasoning to max on the wire", async () => {
  process.env.OPENAI_CODEX_ACCESS_TOKEN = jwtWithAccount("acct_cli");
  process.env.OPENAI_CODEX_BASE_URL = "https://chatgpt.test/backend-api";
  delete process.env.OPENAI_CODEX_MODEL;

  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return codexResponse(String(body.model));
  }) as typeof fetch;

  const model = await createCliModel("gpt-5.6-sol:ultra", { fetch: fetchImpl, authStorage: oauthStorage() });
  await collect(model.stream(emptyInput()));

  expect(body).toMatchObject({
    model: "gpt-5.6-sol",
    reasoning: { effort: "max", summary: "auto" },
  });
});

test("CLI Codex canonicalizes the gpt-5.6 alias and maps off to none", async () => {
  process.env.OPENAI_CODEX_ACCESS_TOKEN = jwtWithAccount("acct_cli");
  process.env.OPENAI_CODEX_BASE_URL = "https://chatgpt.test/backend-api";
  delete process.env.OPENAI_CODEX_MODEL;

  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return codexResponse(String(body.model));
  }) as typeof fetch;

  const model = await createCliModel("gpt-5.6:off", { fetch: fetchImpl, authStorage: oauthStorage() });
  await collect(model.stream(emptyInput()));

  expect(body).toMatchObject({
    model: "gpt-5.6-sol",
    reasoning: { effort: "none", summary: "auto" },
  });
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
    { provider: "openai-codex", model: "gpt-5.6", reasoningLevel: "low" },
    { fetch: fetchImpl, authStorage: oauthStorage() },
  );

  await collect(model.stream(emptyInput()));
  await collect(model.stream({
    ...emptyInput(),
    modelSelection: { provider: "openai-codex", model: "gpt-5.6-luna" },
    reasoningLevel: "high",
    serviceTier: "fast",
  } as ModelStreamInput & {
    modelSelection: { provider: string; model: string };
    reasoningLevel: string;
    serviceTier: "fast";
  }));

  expect(bodies).toHaveLength(2);
  expect(bodies.at(0)).toMatchObject({
    model: "gpt-5.6-sol",
    reasoning: { effort: "low", summary: "auto" },
  });
  expect(bodies.at(1)).toMatchObject({
    model: "gpt-5.6-luna",
    reasoning: { effort: "high", summary: "auto" },
    service_tier: "priority",
  });
});

test("CLI router switches between ChatGPT OAuth and Codex API without mixing credentials", async () => {
  process.env.CODEX_API_KEY = "codex-api-key";
  process.env.CODEX_API_BASE_URL = "https://gateway.test/v1";
  process.env.CODEX_API_MODEL = "gpt-5.6-terra";

  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), headers: new Headers(init?.headers), body });
    return codexResponse(String(body.model));
  }) as typeof fetch;
  const model = await createCliModel("codex", { fetch: fetchImpl, authStorage: oauthStorage() });

  await collect(model.stream(emptyInput()));
  await collect(model.stream({
    ...emptyInput(),
    modelSelection: { provider: "codex-api", model: "gpt-5.6-luna" },
  } as ModelStreamInput & { modelSelection: { provider: string; model: string } }));

  expect(requests).toHaveLength(2);
  expect(requests[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${jwtWithAccount("acct_cli")}`);
  expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("acct_cli");
  expect(requests[1]?.url).toBe("https://gateway.test/v1/responses");
  expect(requests[1]?.headers.get("authorization")).toBe("Bearer codex-api-key");
  expect(requests[1]?.headers.get("chatgpt-account-id")).toBeNull();
});

test("CLI binds explicit credentials and headers to their initial provider", async () => {
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";
  process.env.CODEX_API_KEY = "codex-api-key";
  process.env.CODEX_API_BASE_URL = "https://gateway.test/v1";
  process.env.CODEX_API_MODEL = "gpt-5.6-terra";

  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, headers: new Headers(init?.headers), body });
    if (url.startsWith("https://deepseek-private.test/")) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl_scoped",
          model: body.model,
          choices: [{ index: 0, finish_reason: "stop", message: { content: "ok" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return codexResponse(String(body.model));
  }) as typeof fetch;
  const model = await createCliModel("deepseek", {
    apiKey: "deepseek-private-key",
    baseUrl: "https://deepseek-private.test/v1",
    headers: { "x-provider-secret": "deepseek-private-header" },
    fetch: fetchImpl,
  });

  await collect(model.stream(emptyInput()));
  await collect(model.stream({
    ...emptyInput(),
    modelSelection: { provider: "codex-api", model: "gpt-5.6-luna" },
  } as ModelStreamInput & { modelSelection: { provider: string; model: string } }));

  expect(requests).toHaveLength(2);
  expect(requests[0]?.url).toBe("https://deepseek-private.test/v1/chat/completions");
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer deepseek-private-key");
  expect(requests[0]?.headers.get("x-provider-secret")).toBe("deepseek-private-header");
  expect(requests[1]?.url).toBe("https://gateway.test/v1/responses");
  expect(requests[1]?.headers.get("authorization")).toBe("Bearer codex-api-key");
  expect(requests[1]?.headers.get("x-provider-secret")).toBeNull();
});

test("CLI Codex API never falls back to stored ChatGPT OAuth", async () => {
  delete process.env.CODEX_API_KEY;
  process.env.CODEX_API_BASE_URL = "https://gateway.test/v1";
  delete process.env.OPENAI_CODEX_ACCESS_TOKEN;
  delete process.env.OPENAI_CODEX_BASE_URL;

  let fetchCalled = false;
  const model = await createCliModel("codex-api", {
    authStorage: oauthStorage(),
    fetch: (async () => {
      fetchCalled = true;
      return codexResponse("gpt-5.6-sol");
    }) as unknown as typeof fetch,
  });

  await expect(collect(model.stream(emptyInput()))).rejects.toThrow("Codex API provider requires CODEX_API_KEY");
  expect(fetchCalled).toBe(false);
});

test("CLI model catalog exposes GPT-6 and retained GPT-5.6 models for both Codex providers", async () => {
  process.env.CODEX_API_KEY = "secret-key";
  process.env.CODEX_API_BASE_URL = "https://user:password@gateway.example:8443/v1?api_key=hidden#fragment";
  process.env.CODEX_API_MODEL = "gpt-5.6-sol";

  const router = await createCliModel("codex-api", { authStorage: oauthStorage("acct_catalog") });
  const models = await router.listModels?.() ?? [];
  const chatGpt = models.find((model) => model.provider === "openai-codex" && model.model === "gpt-5.6-sol");
  const api = models.find((model) => model.provider === "codex-api" && model.model === "gpt-5.6-sol");

  expect(models.filter((model) => model.provider === "openai-codex").map((model) => model.model)).toEqual([
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
  expect(models.filter((model) => model.provider === "codex-api").map((model) => model.model)).toEqual([
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);

  expect(chatGpt).toMatchObject({
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    providerDisplayName: "ChatGPT",
    connectionLabel: "ChatGPT OAuth",
    authSource: "oauth",
    endpoint: "https://chatgpt.com",
    available: true,
  });
  expect(api).toMatchObject({
    provider: "codex-api",
    providerDisplayName: "Api",
    connectionLabel: "Third-party API",
    authSource: "environment",
    endpoint: "https://gateway.example:8443",
    available: true,
  });
  expect(JSON.stringify(api)).not.toContain("user");
  expect(JSON.stringify(api)).not.toContain("password");
  expect(JSON.stringify(api)).not.toContain("hidden");
  expect(JSON.stringify(api)).not.toContain("secret-key");
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

test("CLI Kimi K3 clamps reasoning off to low without sending a thinking switch", async () => {
  process.env.MOONSHOT_API_KEY = "env-key";
  process.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";
  delete process.env.MOONSHOT_MODEL;

  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "chatcmpl_kimi_cli",
        model: "kimi-k3",
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
    model: "kimi-k3",
    max_completion_tokens: 131072,
    reasoning_effort: "low",
  });
  expect(body).not.toHaveProperty("thinking");
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

class MemoryOAuthStorage extends FileAuthStorage {
  private readonly credential: OAuthCredential;

  constructor(access: string, accountId: string) {
    super("/tmp/chili-model-test-unused-auth.json");
    this.credential = {
      type: "oauth",
      access,
      refresh: "refresh_cli",
      expires: Date.now() + 60 * 60 * 1000,
      accountId,
    };
  }

  override async get(provider: string): Promise<OAuthCredential | undefined> {
    return provider === "openai-codex" ? this.credential : undefined;
  }
}

function oauthStorage(accountId = "acct_cli"): FileAuthStorage {
  return new MemoryOAuthStorage(jwtWithAccount(accountId), accountId);
}
