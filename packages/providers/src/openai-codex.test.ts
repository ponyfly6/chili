import { beforeEach, expect, test } from "bun:test";
import { ProviderBackpressureCoordinator, sharedProviderBackpressureCoordinator } from "./provider-backpressure.js";
beforeEach(() => sharedProviderBackpressureCoordinator.clear());
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import {
  buildOpenAICodexResponsesRequestBody,
  CODEX_API_MODELS,
  CodexApiResponsesModel,
  clampOpenAICodexReasoningEffort,
  createCodexApiModel,
  createCodexApiProvider,
  createOpenAICodexModel,
  createOpenAICodexProvider,
  exchangeOpenAICodexAuthorizationCode,
  FileAuthStorage,
  OPENAI_CODEX_MODELS,
  OPENAI_CODEX_PROVIDER_ID,
  OpenAICodexResponsesModel,
  OPENAI_CODEX_TOKEN_URL,
  PROVIDER_RETRY_AFTER_MAX_MS,
  ProviderError,
  refreshOpenAICodexToken,
  resolveCodexApiResponsesUrl,
  resolveCodexApiStreamRequestOptions,
  resolveOpenAICodexStreamRequestOptions,
  resolveOpenAICodexResponsesUrl,
} from "./index.js";
import type { OAuthCredential, OAuthCredentials } from "./auth.js";
import type { ModelStreamEvent, ModelTool } from "./types.js";

const sessionId = "session_codex" as SessionId;
const createdAt = 1 as TimestampMs;

test("new Codex sessions default to GPT-6.1 Sol in both authentication modes", () => {
  expect(createOpenAICodexModel().model).toBe("gpt-6.1-sol");
  expect(createCodexApiModel({
    env: {},
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
  }).model).toBe("gpt-6.1-sol");
});

test("GPT-6 requests respect each model's reasoning and sampling limits", () => {
  for (const model of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
    const requiresReasoning = model === "gpt-6.1-sol" || model === "gpt-6-astra";
    const offBody = buildOpenAICodexResponsesRequestBody({ messages: [] }, {
      model,
      reasoningEffort: "off",
      temperature: 0.7,
    });
    expect(offBody).toMatchObject({
      model,
      reasoning: { effort: requiresReasoning ? "low" : "none" },
    });
    if (requiresReasoning) expect(offBody).not.toHaveProperty("temperature");
    else expect(offBody.temperature).toBe(0.7);

    expect(clampOpenAICodexReasoningEffort(model, "minimal")).toBe("low");
    expect(clampOpenAICodexReasoningEffort(model, "xhigh")).toBe("xhigh");
    expect(clampOpenAICodexReasoningEffort(model, "ultra")).toBe("max");
    const defaultBody = buildOpenAICodexResponsesRequestBody({ messages: [] }, { model, temperature: 0.7 });
    expect(defaultBody).not.toHaveProperty("temperature");
    expect(defaultBody).not.toHaveProperty("reasoning");
    const highBody = buildOpenAICodexResponsesRequestBody({ messages: [] }, {
      model,
      reasoningEffort: "high",
      temperature: 0.7,
    });
    expect(highBody).toMatchObject({ reasoning: { effort: "high" } });
    expect(highBody).not.toHaveProperty("temperature");
  }
});

test("accepts only cataloged OpenAI Codex models", () => {
  for (const model of OPENAI_CODEX_MODELS) {
    expect(() => createOpenAICodexModel({ model })).not.toThrow();
    expect(() => createOpenAICodexProvider({ model })).not.toThrow();
  }

  expect(createOpenAICodexModel({ model: "gpt-5.6" }).model).toBe("gpt-5.6-sol");
  expect(createOpenAICodexProvider({ model: "gpt-5.6" }).models().find((model) => model.default)?.model).toBe(
    "gpt-5.6-sol",
  );
  expect(() => createOpenAICodexModel({ model: "gpt-5.5" })).toThrow(
    'Unsupported OpenAI Codex model "gpt-5.5"',
  );
  expect(() => createOpenAICodexModel({ model: "gpt-5.4" })).toThrow(
    'Unsupported OpenAI Codex model "gpt-5.4"',
  );
  expect(() => createOpenAICodexModel({
    env: { OPENAI_CODEX_MODEL: "gpt-5.3-codex" },
  })).not.toThrow();
  expect(() => createOpenAICodexProvider({ model: "gpt-5.4" })).toThrow(
    'Unsupported OpenAI Codex model "gpt-5.4"',
  );
  expect(() => createOpenAICodexProvider({
    env: { OPENAI_CODEX_MODEL: "gpt-5.2" },
  })).not.toThrow();
  expect(() => resolveOpenAICodexStreamRequestOptions(
    { messages: [], model: "gpt-5.1" },
    { model: "gpt-5.6-sol" },
  )).toThrow('Unsupported OpenAI Codex model "gpt-5.1"');
});

test("accepts the same cataloged models for Codex API", () => {
  for (const model of CODEX_API_MODELS) {
    expect(() => createCodexApiModel({
      model,
      apiKey: "api-key",
      baseUrl: "https://gateway.test/v1",
    })).not.toThrow();
    expect(() => createCodexApiProvider({ model })).not.toThrow();
  }

  expect(createCodexApiModel({
    model: "gpt-5.6",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
  }).model).toBe("gpt-5.6-sol");
  expect(() => createCodexApiModel({
    model: "gpt-5.5",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
  })).toThrow('Unsupported Codex API model "gpt-5.5"');
  expect(() => createCodexApiModel({
    model: "gpt-5.4",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
  })).toThrow('Unsupported Codex API model "gpt-5.4"');
});

test("converts Chili messages and tools into a Codex Responses body", () => {
  const callId = "call_weather" as ToolCallId;
  const tools: ModelTool[] = [
    {
      name: "weather",
      description: "Read weather.",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ];

  const body = buildOpenAICodexResponsesRequestBody(
    {
      messages: [
        message("system", [{ type: "text", text: "stored system" }]),
        message("user", [{ type: "text", text: "hello" }]),
        message("assistant", [
          { type: "text", text: "I will check.", phase: "commentary" },
          { type: "tool_call", callId, toolName: "weather", input: { city: "Shanghai" }, status: "pending" },
          { type: "text", text: "It is sunny.", phase: "final_answer" },
        ]),
        message("user", [{ type: "tool_result", callId, output: "sunny" }]),
      ],
      tools,
      system: ["runtime system"],
      metadata: { sessionId: "session_codex" },
    },
    {
      model: "gpt-5.6-sol",
      maxTokens: 123,
      sessionId: "session_codex",
      reasoningEffort: "minimal",
    },
  );

  expect(body).toMatchObject({
    model: "gpt-5.6-sol",
    store: false,
    stream: true,
    instructions: "runtime system\n\nstored system",
    prompt_cache_key: "session_codex",
    text: { verbosity: "medium" },
    reasoning: { effort: "low", summary: "auto" },
    input: [
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "I will check." }] },
      { type: "function_call", call_id: callId, name: "weather", arguments: "{\"city\":\"Shanghai\"}" },
      { role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "It is sunny." }] },
      { type: "function_call_output", call_id: callId, output: "sunny" },
    ],
    tools: [
      {
        type: "function",
        name: "weather",
        description: "Read weather.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
        strict: null,
      },
    ],
  });
  expect(body).not.toHaveProperty("max_output_tokens");
});

test("adds controlled execution context to Codex function outputs", () => {
  const callId = "call_sandboxed" as ToolCallId;
  const body = buildOpenAICodexResponsesRequestBody(
    {
      messages: [
        message("assistant", [
          { type: "tool_call", callId, toolName: "bash", input: {}, status: "completed" },
        ]),
        message("user", [{
          type: "tool_result",
          callId,
          output: "command failed",
          executionContext: {
            sandbox: "macos-seatbelt",
            executionMode: "sandboxed",
            exitCode: 1,
          },
        }]),
      ],
      tools: [],
      system: [],
    },
    { model: "gpt-5.6-sol" },
  );

  expect((body.input as unknown[]).at(-1)).toEqual({
    type: "function_call_output",
    call_id: callId,
    output: [
      "command failed",
      "",
      "[tool execution context]",
      "sandbox: macos-seatbelt",
      "execution_mode: sandboxed",
      "exit_code: 1",
    ].join("\n"),
  });
});

test("rejects phase-less assistant text when building Codex history", () => {
  expect(() => buildOpenAICodexResponsesRequestBody(
    {
      messages: [message("assistant", [{ type: "text", text: "ambiguous" }])],
      tools: [],
      system: [],
    },
    { model: "gpt-5.6-sol" },
  )).toThrow("assistant text part is missing phase");

  expect(() => buildOpenAICodexResponsesRequestBody(
    {
      messages: [message("assistant", [
        { type: "tool_call", callId: "call_only", toolName: "lookup", input: {}, status: "completed" },
      ])],
      tools: [],
      system: [],
    },
    { model: "gpt-5.6-sol" },
  )).not.toThrow();
});

test("adds developer fragments to instructions and contextual fragments to input", () => {
  const body = buildOpenAICodexResponsesRequestBody(
    {
      messages: [message("user", [{ type: "text", text: "hello" }])],
      tools: [],
      system: ["base instructions"],
      developer: ["skills catalog"],
      contextualUser: ["memory context"],
    },
    {
      model: "gpt-5.6-sol",
    },
  );

  expect(body).toMatchObject({
    instructions: "base instructions\n\nskills catalog",
    input: [
      { role: "user", content: [{ type: "input_text", text: "memory context" }] },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ],
  });
});

test("sets Codex service tier only for fast mode", () => {
  const fastBody = buildOpenAICodexResponsesRequestBody(
    {
      messages: [message("user", [{ type: "text", text: "hello" }])],
      tools: [],
      system: [],
    },
    {
      model: "gpt-5.6-sol",
      serviceTier: "fast",
    },
  );
  expect(fastBody.service_tier).toBe("priority");

  const standardBody = buildOpenAICodexResponsesRequestBody(
    {
      messages: [message("user", [{ type: "text", text: "hello" }])],
      tools: [],
      system: [],
    },
    {
      model: "gpt-5.6-sol",
      serviceTier: "standard",
    },
  );
  expect(standardBody).not.toHaveProperty("service_tier");
});

test("adds image tool results as Codex input images", () => {
  const callId = "call_image" as ToolCallId;
  const body = buildOpenAICodexResponsesRequestBody(
    {
      messages: [
        message("assistant", [
          { type: "tool_call", callId, toolName: "read_image", input: { filePath: "pixel.png" }, status: "completed" },
        ]),
        message("user", [
          {
            type: "tool_result",
            callId,
            output: "Image read: pixel.png",
            content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          },
        ]),
      ],
      tools: [],
      system: [],
    },
    {
      model: "gpt-5.6-sol",
    },
  );

  expect(body.input).toContainEqual({
    type: "function_call_output",
    call_id: callId,
    output: "Image read: pixel.png",
  });
  expect(body.input).toContainEqual({
    role: "user",
    content: [
      { type: "input_text", text: `Image returned by tool call ${callId}.` },
      { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
    ],
  });
});

test("adds pasted user images as Codex input images", () => {
  const body = buildOpenAICodexResponsesRequestBody(
    {
      messages: [
        message("user", [
          { type: "text", text: "What is in this image? [Image #1]" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png", filename: "pixel.png" },
        ]),
      ],
      tools: [],
      system: [],
    },
    {
      model: "gpt-5.6-sol",
    },
  );

  expect(body.input).toEqual([
    {
      role: "user",
      content: [
        { type: "input_text", text: "What is in this image? [Image #1]" },
        { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
      ],
    },
  ]);
});

test("omits image tool result blocks for text-only Codex request bodies", () => {
  const callId = "call_image" as ToolCallId;
  const body = buildOpenAICodexResponsesRequestBody(
    {
      messages: [
        message("assistant", [
          { type: "tool_call", callId, toolName: "read_image", input: { filePath: "pixel.png" }, status: "completed" },
        ]),
        message("user", [
          {
            type: "tool_result",
            callId,
            output: "Image read: pixel.png",
            content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          },
        ]),
      ],
      tools: [],
      system: [],
    },
    {
      model: "text-only-codex-fixture",
      inputCapabilities: ["text"],
    },
  );

  expect(body.input).toContainEqual({
    type: "function_call_output",
    call_id: callId,
    output: "Image read: pixel.png",
  });
  expect(JSON.stringify(body.input)).not.toContain("input_image");
});

test("keeps ChatGPT fixed while resolving Codex API URL variants", () => {
  expect(resolveOpenAICodexResponsesUrl()).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(resolveOpenAICodexResponsesUrl("https://chatgpt.com/backend-api")).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(() => resolveOpenAICodexResponsesUrl("https://api.codexapi.space/v1")).toThrow(
    "ChatGPT Codex uses a fixed endpoint",
  );
  expect(resolveCodexApiResponsesUrl("https://api.codexapi.space/v1")).toBe(
    "https://api.codexapi.space/v1/responses",
  );
  expect(resolveCodexApiResponsesUrl("https://api.codexapi.space/v1/responses")).toBe(
    "https://api.codexapi.space/v1/responses",
  );
});

test("resolves per-stream Codex model and reasoning request options", () => {
  expect(
    resolveOpenAICodexStreamRequestOptions(
      {
        messages: [],
        model: "openai-codex/gpt-5.6-terra:xhigh",
        reasoning: "low",
        metadata: { sessionId: "session_2" },
      },
      { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    ),
  ).toMatchObject({
    model: "gpt-5.6-terra",
    reasoningEffort: "low",
    sessionId: "session_2",
  });

  expect(
    resolveOpenAICodexStreamRequestOptions(
      {
        messages: [],
        model: "openai-codex/gpt-5.6-terra:xhigh",
      },
      { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    ),
  ).toMatchObject({
    model: "gpt-5.6-terra",
    reasoningEffort: "xhigh",
  });

  expect(resolveCodexApiStreamRequestOptions({
    messages: [],
    model: "codex-api/gpt-5.6-luna:high",
  }, {
    model: "gpt-5.6-sol",
  })).toMatchObject({
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
  });

  expect(resolveOpenAICodexStreamRequestOptions({
    messages: [],
    model: "openai-codex/gpt-5.6:max",
  }, {
    model: "gpt-5.6-luna",
    reasoningMode: "pro",
    reasoningContext: "current_turn",
  })).toMatchObject({
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    reasoningMode: "pro",
    reasoningContext: "current_turn",
  });
});

test("maps GPT-5.6 reasoning levels and merges Responses reasoning options", () => {
  expect(clampOpenAICodexReasoningEffort("gpt-5.6-sol", "off")).toBe("none");
  expect(clampOpenAICodexReasoningEffort("gpt-5.6-sol", "minimal")).toBe("low");
  expect(clampOpenAICodexReasoningEffort("gpt-5.6-sol", "max")).toBe("max");
  expect(clampOpenAICodexReasoningEffort("gpt-5.6", "ultra")).toBe("max");
  expect(clampOpenAICodexReasoningEffort("gpt-5.6-luna", "ultra")).toBe("max");

  const omittedBody = buildOpenAICodexResponsesRequestBody(
    { messages: [] },
    { model: "gpt-5.6-sol" },
  );
  expect(omittedBody).not.toHaveProperty("reasoning");

  const body = buildOpenAICodexResponsesRequestBody(
    { messages: [] },
    {
      model: "gpt-5.6-sol",
      reasoningEffort: "off",
    },
  );

  expect(body).toMatchObject({ reasoning: { effort: "none", summary: "auto" } });

  const configuredBody = buildOpenAICodexResponsesRequestBody(
    { messages: [] },
    {
      model: "gpt-5.6",
      reasoningEffort: "ultra",
      reasoningMode: "pro",
      reasoningContext: "all_turns",
      reasoningSummary: "detailed",
    },
  );
  expect(configuredBody).toMatchObject({
    model: "gpt-5.6-sol",
    reasoning: {
      effort: "max",
      mode: "pro",
      context: "all_turns",
      summary: "detailed",
    },
  });
});

test("ChatGPT Codex rejects direct credentials and custom endpoints", () => {
  expect(() => createOpenAICodexModel({ apiKey: "direct-key" })).toThrow(
    "ChatGPT Codex is OAuth-only",
  );
  expect(() => createOpenAICodexModel({ baseUrl: "https://third-party.test/v1" })).toThrow(
    "ChatGPT Codex uses a fixed endpoint",
  );
});

test("Codex API requires a complete API key and base URL configuration", () => {
  expect(() => createCodexApiModel({ env: {} })).toThrow("requires CODEX_API_KEY");
  expect(() => createCodexApiModel({ apiKey: "api-key", env: {} })).toThrow("requires CODEX_API_BASE_URL");
  expect(() => createCodexApiModel({
    apiKey: "   ",
    baseUrl: "https://third-party.test/v1",
    env: {},
  })).toThrow("requires CODEX_API_KEY");
  expect(() => createCodexApiModel({
    apiKey: "api-key",
    baseUrl: "not-a-url",
    env: {},
  })).toThrow("absolute HTTP(S) URL");
  expect(() => createCodexApiModel({
    apiKey: "api-key",
    baseUrl: "ftp://third-party.test/v1",
    env: {},
  })).toThrow("absolute HTTP(S) URL");
  expect(() => createCodexApiModel({
    env: {
      CODEX_API_BASE_URL: "https://third-party.test/v1",
      OPENAI_CODEX_ACCESS_TOKEN: "legacy-key-must-not-cross-fill",
    },
  })).toThrow("requires CODEX_API_KEY");
});

test("Codex API refuses a legacy ChatGPT OAuth token before contacting a custom endpoint", async () => {
  let fetchCalls = 0;
  const modelOptions = {
    env: {
      OPENAI_CODEX_ACCESS_TOKEN: jwtWithAccount("acct_legacy_oauth"),
      OPENAI_CODEX_BASE_URL: "https://third-party.test/v1",
    },
    fetch: (async () => {
      fetchCalls += 1;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch,
  };

  expect(() => createCodexApiModel(modelOptions)).toThrow("looks like a ChatGPT OAuth token");
  expect(fetchCalls).toBe(0);

  expect(() => createCodexApiModel({
    apiKey: jwtWithAccount("acct_explicit_api_key"),
    baseUrl: "https://third-party.test/v1",
    env: modelOptions.env,
  })).not.toThrow();
});

test("ChatGPT OAuth ignores legacy API environment and always uses the fixed endpoint", async () => {
  let requestedUrl = "";
  let headers = new Headers();
  const fetchImpl = (async (input, init) => {
    requestedUrl = String(input);
    headers = new Headers(init?.headers);
    return new Response(streamText([
      data({ type: "response.created", response: { id: "resp_oauth_fixed", model: "gpt-5.6-sol" } }),
      data({ type: "response.completed", response: { id: "resp_oauth_fixed", model: "gpt-5.6-sol", status: "completed" } }),
    ].join("")), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const oauthAccess = jwtWithAccount("acct_oauth_fixed");
  const model = new OpenAICodexResponsesModel({
    model: "gpt-5.6-sol",
    authStorage: staticOAuthStorage(oauthAccess, "acct_oauth_fixed"),
    fetch: fetchImpl,
    env: {
      OPENAI_CODEX_ACCESS_TOKEN: "third-party-key",
      OPENAI_CODEX_BASE_URL: "https://third-party.test/v1",
    },
  });

  await collect(model.stream({ messages: [] }));

  expect(requestedUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(headers.get("authorization")).toBe(`Bearer ${oauthAccess}`);
  expect(headers.get("chatgpt-account-id")).toBe("acct_oauth_fixed");
});

test("ChatGPT OAuth keeps its request limit internal and omits max_output_tokens on the wire", async () => {
  let body: Record<string, unknown> = {};
  const model = new OpenAICodexResponsesModel({
    model: "gpt-5.6-sol",
    maxTokens: 123,
    authStorage: staticOAuthStorage(jwtWithAccount("acct_oauth_limit"), "acct_oauth_limit"),
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(streamText([
        data({ type: "response.created", response: { id: "resp_oauth_limit", model: "gpt-5.6-sol" } }),
        data({ type: "response.completed", response: { id: "resp_oauth_limit", model: "gpt-5.6-sol", status: "completed" } }),
      ].join("")), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch,
  });

  const requestOptions = resolveOpenAICodexStreamRequestOptions({ messages: [] }, {
    model: "gpt-5.6-sol",
    maxTokens: 123,
  });
  await collect(model.stream({ messages: [] }));

  expect(requestOptions.maxTokens).toBe(123);
  expect(body).not.toHaveProperty("max_output_tokens");
});

test("Codex API sends configured max_output_tokens on the wire", async () => {
  let body: Record<string, unknown> = {};
  const model = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    maxTokens: 456,
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(streamText([
        data({ type: "response.created", response: { id: "resp_api_limit", model: "gpt-5.6-sol" } }),
        data({ type: "response.completed", response: { id: "resp_api_limit", model: "gpt-5.6-sol", status: "completed" } }),
      ].join("")), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch,
  });

  await collect(model.stream({ messages: [] }));

  expect(body.max_output_tokens).toBe(456);
});

test("accepts OpenAI Codex token exchange fields from id_token", async () => {
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 7200;
  const idToken = jwtWithPayload({
    exp: expiresAtSeconds,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_from_id" },
  });
  const accessToken = jwtWithPayload({ sub: "access_without_account_claim" });
  let body = new URLSearchParams();
  const fetchImpl = (async (_input, init) => {
    body = new URLSearchParams(String(init?.body));
    return new Response(JSON.stringify({
      id_token: idToken,
      access_token: accessToken,
      refresh_token: "refresh_1",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const result = await exchangeOpenAICodexAuthorizationCode("code_1", "verifier_1", fetchImpl);

  expect(body.get("grant_type")).toBe("authorization_code");
  expect(body.get("code")).toBe("code_1");
  expect(body.get("code_verifier")).toBe("verifier_1");
  expect(result.type).toBe("success");
  if (result.type !== "success") throw new Error("expected token exchange to succeed");
  expect(result.credentials).toEqual({
    access: accessToken,
    refresh: "refresh_1",
    expires: expiresAtSeconds * 1000,
    accountId: "acct_from_id",
  });
});

test("types and sanitizes OAuth 2xx error envelopes", async () => {
  const error = await rejectedProviderError(() => refreshOpenAICodexToken("refresh_old", {
    fetch: (async () => new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "API key is SUPERSECRET12345 rejected at ::ffff:192.0.2.1",
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_oauth_2xx",
        "retry-after": String(10 * 24 * 60 * 60),
      },
    })) as unknown as typeof fetch,
  }));

  expect(error).toMatchObject({
    provider: OPENAI_CODEX_PROVIDER_ID,
    status: 200,
    code: "invalid_grant",
    requestId: "req_oauth_2xx",
    retryAfterMs: PROVIDER_RETRY_AFTER_MAX_MS,
    retryable: false,
    message: "OpenAI Codex token response failed (request id: req_oauth_2xx)",
  });
  expect(error.message).not.toContain("SUPERSECRET12345");
  expect(error.message).not.toContain("192.0.2.1");
});

test("refresh preserves existing token fields when Codex omits optional fields", async () => {
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;
  const accessToken = jwtWithPayload({ exp: expiresAtSeconds, sub: "new_access" });
  let headers = new Headers();
  let body: unknown;
  const fetchImpl = (async (_input, init) => {
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as unknown;
    return new Response(JSON.stringify({ access_token: accessToken }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const credentials = await refreshOpenAICodexToken("refresh_old", {
    fetch: fetchImpl,
    previous: {
      access: "old_access",
      refresh: "refresh_old",
      expires: Date.now() - 1000,
      accountId: "acct_existing",
    },
  });

  expect(headers.get("content-type")).toBe("application/json");
  expect(body).toMatchObject({
    grant_type: "refresh_token",
    refresh_token: "refresh_old",
  });
  expect(credentials).toEqual({
    access: accessToken,
    refresh: "refresh_old",
    expires: expiresAtSeconds * 1000,
    accountId: "acct_existing",
  });
});

test("ChatGPT Codex refreshes expiring OAuth credentials, persists them, and preserves the account identity", async () => {
  const oldCredential: OAuthCredential = {
    type: "oauth",
    access: jwtWithAccount("acct_old"),
    refresh: "refresh_old",
    expires: Date.now() + 30_000,
    accountId: "acct_old",
  };
  const refreshedAccess = jwtWithPayload({ sub: "refreshed_access" });
  const refreshedId = jwtWithPayload({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_old" },
  });
  const storage = new StaticOAuthStorage(oldCredential);
  let modelCalls = 0;
  let modelHeaders = new Headers();
  const fetchImpl = (async (input, init) => {
    if (String(input) === OPENAI_CODEX_TOKEN_URL) {
      return new Response(JSON.stringify({
        access_token: refreshedAccess,
        refresh_token: "refresh_new",
        id_token: refreshedId,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    modelCalls += 1;
    modelHeaders = new Headers(init?.headers);
    return new Response(streamText([
      data({ type: "response.created", response: { id: "resp_refreshed", model: "gpt-5.6-sol" } }),
      data({ type: "response.completed", response: { id: "resp_refreshed", model: "gpt-5.6-sol", status: "completed" } }),
    ].join("")), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const model = new OpenAICodexResponsesModel({
    model: "gpt-5.6-sol",
    authStorage: storage,
    fetch: fetchImpl,
  });
  await collect(model.stream({ messages: [] }));

  expect(modelCalls).toBe(1);
  expect(modelHeaders.get("authorization")).toBe(`Bearer ${refreshedAccess}`);
  expect(modelHeaders.get("chatgpt-account-id")).toBe("acct_old");
  expect(storage.writes).toHaveLength(1);
  expect(storage.writes[0]).toMatchObject({
    access: refreshedAccess,
    refresh: "refresh_new",
    accountId: "acct_old",
  });
});

test("ChatGPT Codex does not request a model or overwrite credentials when OAuth refresh fails", async () => {
  const oldCredential: OAuthCredential = {
    type: "oauth",
    access: jwtWithAccount("acct_old"),
    refresh: "refresh_old",
    expires: Date.now() - 1,
    accountId: "acct_old",
  };
  const storage = new StaticOAuthStorage(oldCredential);
  let modelCalls = 0;
  const fetchImpl = (async (input) => {
    if (String(input) === OPENAI_CODEX_TOKEN_URL) {
      return new Response(
        "<!DOCTYPE html><html><body>refresh denied at 10.9.8.7 with private-refresh-token</body></html>",
        { status: 401 },
      );
    }
    modelCalls += 1;
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  const model = new OpenAICodexResponsesModel({
    model: "gpt-5.6-sol",
    authStorage: storage,
    fetch: fetchImpl,
  });

  const error = await rejectedProviderError(() => collect(model.stream({ messages: [] })));
  expect(error).toMatchObject({
    provider: OPENAI_CODEX_PROVIDER_ID,
    status: 401,
    category: "authentication",
    retryable: false,
    message: "OpenAI Codex token request failed with HTTP 401 Unauthorized",
  });
  expect(error.message).not.toContain("10.9.8.7");
  expect(error.message).not.toContain("private-refresh-token");
  expect(modelCalls).toBe(0);
  expect(storage.writes).toHaveLength(0);
  expect(await storage.getOAuthCredentials(OPENAI_CODEX_PROVIDER_ID)).toEqual(oldCredential);
});

test("sends ChatGPT Codex headers and parses Responses SSE events", async () => {
  const token = jwtWithAccount("acct_test");
  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(streamText([
      data({ type: "response.created", response: { id: "resp_1", model: "gpt-5.6-sol" } }),
      data({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", phase: "final_answer" } }),
      data({ type: "response.output_text.delta", output_index: 0, delta: "hello" }),
      data({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
      }),
      data({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"q\"" }),
      data({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{\"q\":\"chili\"}" }),
      data({
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"chili\"}" },
      }),
      data({
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "gpt-5.6-sol",
          status: "completed",
          usage: {
            input_tokens: 5,
            output_tokens: 7,
            total_tokens: 12,
            input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
          },
        },
      }),
    ].join("")), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const model = new OpenAICodexResponsesModel({
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    reasoningMode: "pro",
    reasoningContext: "current_turn",
    authStorage: staticOAuthStorage(token, "acct_test"),
    fetch: fetchImpl,
    env: {},
  });
  const events = await collect(
    model.stream({
      messages: [],
      model: "openai-codex/gpt-5.6-terra:high",
      tools: [],
      system: [],
      metadata: { sessionId: "session_1" },
    }),
  );

  expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(headers.get("chatgpt-account-id")).toBe("acct_test");
  expect(headers.get("originator")).toBe("chili");
  expect(headers.get("openai-beta")).toBe("responses=experimental");
  expect(headers.get("session_id")).toBe("session_1");
  expect(body).toMatchObject({
    model: "gpt-5.6-terra",
    prompt_cache_key: "session_1",
    reasoning: {
      effort: "high",
      mode: "pro",
      context: "current_turn",
      summary: "auto",
    },
  });
  expect(events.map((event) => event.type)).toEqual([
    "metadata",
    "metadata",
    "text_delta",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call_end",
    "metadata",
    "finish",
  ]);
  expect(events[2]).toEqual({ type: "text_delta", text: "hello", index: 0, phase: "final_answer" });
  expect(events[6]).toEqual({
    type: "tool_call_end",
    toolCallId: "call_1",
    name: "lookup",
    input: { q: "chili" },
    index: 1,
  });
  expect(events.at(-1)).toMatchObject({
    type: "finish",
    reason: "tool_use",
    responseId: "resp_1",
    usage: {
      inputTokens: 2,
      outputTokens: 7,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
      totalTokens: 12,
    },
  });
});

test("preserves assistant phase for every Codex message output item", async () => {
  const model = codexStreamModel([
    data({ type: "response.created", response: { id: "resp_phases", model: "gpt-5.6-sol" } }),
    data({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_commentary", phase: "commentary" },
    }),
    data({ type: "response.output_text.delta", output_index: 0, delta: "Checking " }),
    data({ type: "response.output_text.delta", output_index: 0, delta: "files." }),
    data({
      type: "response.output_item.added",
      output_index: 2,
      item: { type: "message", id: "msg_final", phase: "final_answer" },
    }),
    data({ type: "response.output_text.delta", output_index: 2, delta: "Done." }),
    data({
      type: "response.completed",
      response: { id: "resp_phases", model: "gpt-5.6-sol", status: "completed" },
    }),
  ]);

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events.filter((event) => event.type === "text_delta")).toEqual([
    { type: "text_delta", text: "Checking ", index: 0, phase: "commentary" },
    { type: "text_delta", text: "files.", index: 0, phase: "commentary" },
    { type: "text_delta", text: "Done.", index: 1, phase: "final_answer" },
  ]);
  expect(events.filter((event) => event.type === "text_end")).toEqual([]);
});

for (const scenario of [
  {
    name: "rejects a Codex message output item with no phase",
    events: [
      data({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_missing" } }),
    ],
    error: "missing assistant phase",
  },
  {
    name: "rejects an unknown Codex message output phase",
    events: [
      data({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_unknown", phase: "analysis" },
      }),
    ],
    error: "invalid assistant phase",
  },
  {
    name: "rejects a Codex text delta without a declared message item",
    events: [
      data({ type: "response.output_text.delta", output_index: 3, delta: "orphan" }),
    ],
    error: "text delta for an undeclared message output",
  },
  {
    name: "rejects conflicting phases for one Codex output index",
    events: [
      data({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "msg_first", phase: "commentary" },
      }),
      data({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "msg_second", phase: "final_answer" },
      }),
    ],
    error: "conflicting assistant phase for output index 1",
  },
  {
    name: "rejects a completed Codex message output item with no phase",
    events: [
      data({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg_done_missing" },
      }),
    ],
    error: "missing assistant phase",
  },
  {
    name: "rejects a completed Codex message output item whose phase conflicts with its declaration",
    events: [
      data({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_done_conflict", phase: "commentary" },
      }),
      data({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg_done_conflict", phase: "final_answer" },
      }),
    ],
    error: "conflicting assistant phase for output index 0",
  },
] as const) {
  test(scenario.name, async () => {
    const model = codexStreamModel(scenario.events);
    const error = await rejectedProviderError(() => collect(model.stream({ messages: [], tools: [], system: [] })));
    expect(error).toMatchObject({ provider: "codex-api", category: "unknown", retryable: false });
    expect(error.message).toContain(scenario.error);
  });
}

test("sanitizes malformed Codex stream indexes and phases", async () => {
  const secrets = [
    `Bearer ${"secret".repeat(40)}`,
    `<script>${"private".repeat(100)}</script>`,
  ];
  const scenarios = [
    data({
      type: "response.output_item.added",
      output_index: secrets[0],
      item: { type: "message", id: "msg_bad_index", phase: "commentary" },
    }),
    data({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_bad_phase", phase: secrets[1] },
    }),
  ];

  for (const event of scenarios) {
    const error = await rejectedProviderError(() => collect(codexStreamModel([event]).stream({ messages: [] })));
    expect(error).toMatchObject({ provider: "codex-api", category: "unknown", retryable: false });
    expect(new TextEncoder().encode(error.message).byteLength).toBeLessThanOrEqual(1024);
    for (const secret of secrets) expect(error.message).not.toContain(secret);
  }
});

test("preserves reasoning summary sections from Codex Responses streams", async () => {
  const model = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: sseFetch([
      data({ type: "response.created", response: { id: "resp_reasoning", model: "gpt-5.6-sol" } }),
      data({ type: "response.reasoning_summary_text.delta", item_id: "reasoning_1", output_index: 0, summary_index: 0, delta: "**Inspecting " }),
      data({ type: "response.reasoning_summary_text.delta", item_id: "reasoning_1", output_index: 0, summary_index: 0, delta: "core**" }),
      data({ type: "response.reasoning_summary_text.delta", item_id: "reasoning_1", output_index: 0, summary_index: 1, delta: "**Checking " }),
      data({ type: "response.reasoning_summary_text.delta", item_id: "reasoning_1", output_index: 0, summary_index: 1, delta: "schema**" }),
      data({ type: "response.completed", response: { id: "resp_reasoning", model: "gpt-5.6-sol", status: "completed" } }),
    ]),
    env: {},
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));
  const reasoning = events.filter((event) => event.type === "reasoning_delta");

  expect(reasoning.map((event) => event.index)).toEqual([0, 0, 1, 1]);
  expect(reasoning.filter((event) => event.index === 0).map((event) => event.text).join("")).toBe("**Inspecting core**");
  expect(reasoning.filter((event) => event.index === 1).map((event) => event.text).join("")).toBe("**Checking schema**");
});

test("ends each Codex text content block once and preserves its message phase", async () => {
  const model = codexStreamModel([
    data({ type: "response.output_item.added", output_index: 2, item: { type: "message", id: "msg_blocks", phase: "commentary" } }),
    data({ type: "response.output_text.delta", output_index: 2, content_index: 0, delta: "First " }),
    data({ type: "response.output_text.delta", output_index: 2, content_index: 0, delta: "block." }),
    data({ type: "response.output_text.done", output_index: 2, content_index: 0, text: "First block." }),
    data({ type: "response.output_text.delta", output_index: 2, content_index: 1, delta: "Second block." }),
    data({ type: "response.output_text.done", output_index: 2, content_index: 1, text: "Second block." }),
    data({ type: "response.output_item.done", output_index: 2, item: { type: "message", id: "msg_blocks", phase: "commentary" } }),
    data({ type: "response.output_item.added", output_index: 3, item: { type: "message", id: "msg_final", phase: "final_answer" } }),
    data({ type: "response.refusal.delta", output_index: 3, content_index: 0, delta: "Refusal." }),
    data({ type: "response.refusal.done", output_index: 3, content_index: 0, refusal: "Refusal." }),
    data({ type: "response.output_item.done", output_index: 3, item: { type: "message", id: "msg_final", phase: "final_answer" } }),
    data({ type: "response.completed", response: { status: "completed" } }),
  ]);

  const events = await collect(model.stream({ messages: [] }));
  expect(events.filter((streamEvent) => streamEvent.type === "text_delta" || streamEvent.type === "text_end")).toEqual([
    { type: "text_delta", text: "First ", index: 0, phase: "commentary" },
    { type: "text_delta", text: "block.", index: 0, phase: "commentary" },
    { type: "text_end", index: 0, phase: "commentary" },
    { type: "text_delta", text: "Second block.", index: 1, phase: "commentary" },
    { type: "text_end", index: 1, phase: "commentary" },
    { type: "text_delta", text: "Refusal.", index: 2, phase: "final_answer" },
    { type: "text_end", index: 2, phase: "final_answer" },
  ]);
});

test("Codex item completion closes remaining blocks without ending on index changes", async () => {
  const model = codexStreamModel([
    data({ type: "response.reasoning_summary_text.delta", item_id: "r", output_index: 0, summary_index: 0, delta: "First thought." }),
    data({ type: "response.reasoning_summary_text.delta", item_id: "r", output_index: 0, summary_index: 1, delta: "Second thought." }),
    data({ type: "response.reasoning_summary_text.done", output_index: 0, summary_index: 0 }),
    data({ type: "response.reasoning_summary_part.done", item_id: "r", output_index: 0, summary_index: 0 }),
    data({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "r", summary: [] } }),
    data({ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg", phase: "final_answer" } }),
    data({ type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "First block." }),
    data({ type: "response.output_text.delta", output_index: 1, content_index: 1, delta: "Second block." }),
    data({ type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg", phase: "final_answer" } }),
    data({ type: "response.completed", response: { status: "completed" } }),
  ]);

  const events = await collect(model.stream({ messages: [] }));
  expect(events.filter((streamEvent) => streamEvent.type !== "metadata" && streamEvent.type !== "finish")).toEqual([
    { type: "reasoning_delta", text: "First thought.", index: 0 },
    { type: "reasoning_delta", text: "Second thought.", index: 1 },
    { type: "reasoning_end", index: 0 },
    { type: "reasoning_end", index: 1 },
    { type: "text_delta", text: "First block.", index: 0, phase: "final_answer" },
    { type: "text_delta", text: "Second block.", index: 1, phase: "final_answer" },
    { type: "text_end", index: 0, phase: "final_answer" },
    { type: "text_end", index: 1, phase: "final_answer" },
  ]);
});

test("recovers Codex content delivered only in completion events without duplicating streamed prefixes", async () => {
  const model = codexStreamModel([
    data({ type: "response.reasoning_summary_text.done", output_index: 0, summary_index: 0, text: "A full thought." }),
    data({ type: "response.reasoning_summary_part.done", output_index: 0, summary_index: 0, part: { text: "A full thought." } }),
    data({ type: "response.reasoning_summary_part.done", output_index: 0, summary_index: 1, part: { text: "A second thought." } }),
    data({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 2, delta: "A final " }),
    data({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", summary: [
      { text: "A full thought." }, { text: "A second thought." }, { text: "A final thought." }, { text: "Only in item." },
    ] } }),
    data({ type: "response.output_item.added", output_index: 1, item: { type: "message", phase: "commentary" } }),
    data({ type: "response.output_text.done", output_index: 1, content_index: 0, text: "Full text." }),
    data({ type: "response.output_text.delta", output_index: 1, content_index: 1, delta: "A streamed " }),
    data({ type: "response.output_text.done", output_index: 1, content_index: 1, text: "A streamed prefix." }),
    data({ type: "response.output_item.done", output_index: 1, item: { type: "message", phase: "commentary", content: [
      { type: "output_text", text: "Full text." }, { type: "output_text", text: "A streamed prefix." },
    ] } }),
    data({ type: "response.output_item.done", output_index: 2, item: { type: "message", phase: "final_answer", content: [
      { type: "output_text", text: "Only in item." }, { type: "refusal", refusal: "Full refusal." },
    ] } }),
    data({ type: "response.completed", response: { status: "completed" } }),
  ]);

  const events = await collect(model.stream({ messages: [] }));
  const reasoning = events.filter((streamEvent) => streamEvent.type === "reasoning_delta");
  expect(reasoning.map((streamEvent) => streamEvent.text).join("")).toBe("A full thought.A second thought.A final thought.Only in item.");
  const text = events.filter((streamEvent) => streamEvent.type === "text_delta");
  expect(text.map((streamEvent) => streamEvent.text).join("")).toBe("Full text.A streamed prefix.Only in item.Full refusal.");
  expect(events.filter((streamEvent) => streamEvent.type === "reasoning_end").map((streamEvent) => streamEvent.index)).toEqual([0, 1, 2, 3]);
  expect(events.filter((streamEvent) => streamEvent.type === "text_end").map((streamEvent) => streamEvent.index)).toEqual([0, 1, 2, 3]);
});

test("keeps explicitly incomplete Codex done content pending while preserving its final text", async () => {
  const scenarios = [
    {
      kind: "reasoning",
      done: { type: "response.reasoning_summary_part.done", status: "incomplete", part: { text: "Partial thought" } },
    },
    {
      kind: "reasoning",
      done: { type: "response.reasoning_summary_part.done", part: { status: "incomplete", text: "Partial thought" } },
    },
    {
      kind: "reasoning",
      done: { type: "response.reasoning_summary_text.done", status: "incomplete", text: "Partial thought" },
    },
    {
      kind: "reasoning",
      done: { type: "response.output_item.done", item: { type: "reasoning", status: "incomplete", summary: [{ text: "Partial thought" }] } },
    },
    {
      kind: "reasoning",
      done: { type: "response.output_item.done", item: { type: "reasoning", summary: [{ status: "incomplete", text: "Partial thought" }] } },
    },
    {
      kind: "text",
      done: { type: "response.output_text.done", status: "incomplete", text: "Partial thought" },
    },
    {
      kind: "text",
      done: { type: "response.refusal.done", status: "incomplete", refusal: "Partial thought" },
    },
    {
      kind: "text",
      done: { type: "response.output_item.done", item: { type: "message", phase: "final_answer", status: "incomplete", content: [{ type: "output_text", text: "Partial thought" }] } },
    },
    {
      kind: "text",
      done: { type: "response.output_item.done", item: { type: "message", phase: "final_answer", content: [{ type: "refusal", status: "incomplete", refusal: "Partial thought" }] } },
    },
  ];

  for (const scenario of scenarios) {
    for (const terminal of ["incomplete", "failed"] as const) {
      for (const prefix of ["", "Partial "]) {
        const reasoning = scenario.kind === "reasoning";
        const item = reasoning
          ? { type: "reasoning", summary: [{ text: "Partial thought" }] }
          : { type: "message", phase: "final_answer", content: [{ type: "output_text", text: "Partial thought" }] };
        const model = codexStreamModel([
          data({ type: "response.output_item.added", output_index: 0, item }),
          ...(prefix ? [data({ type: reasoning ? "response.reasoning_summary_text.delta" : "response.output_text.delta", output_index: 0, summary_index: 0, content_index: 0, delta: prefix })] : []),
          data({ ...scenario.done, output_index: 0, summary_index: 0, content_index: 0 }),
          // A subsequent item-level completion must not reclassify an explicitly incomplete part.
          data({ type: "response.output_item.done", output_index: 0, item }),
          data({ type: `response.${terminal}`, response: { status: terminal, ...(terminal === "failed" ? { error: { message: "Generation failed" } } : {}) } }),
        ]);
        const events: ModelStreamEvent[] = [];
        const consume = (async () => {
          for await (const streamEvent of model.stream({ messages: [] })) events.push(streamEvent);
        })();
        if (terminal === "failed") await expect(consume).rejects.toBeInstanceOf(ProviderError);
        else {
          await consume;
          expect(events.at(-1)).toMatchObject({ type: "finish", reason: "length" });
        }
        expect(events.filter((streamEvent) => streamEvent.type === "reasoning_end" || streamEvent.type === "text_end")).toEqual([]);
        expect(events.filter((streamEvent) => streamEvent.type === "reasoning_delta" || streamEvent.type === "text_delta").map((streamEvent) => streamEvent.text).join("")).toBe("Partial thought");
      }
    }
  }
});

test("incomplete Codex item completion keeps already streamed blocks pending", async () => {
  const model = codexStreamModel([
    data({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "Partial thought" }),
    data({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", status: "incomplete" } }),
    data({ type: "response.output_item.added", output_index: 1, item: { type: "message", phase: "final_answer" } }),
    data({ type: "response.output_text.delta", output_index: 1, delta: "Partial answer" }),
    data({ type: "response.output_item.done", output_index: 1, item: { type: "message", phase: "final_answer", status: "incomplete" } }),
    data({ type: "response.incomplete", response: { status: "incomplete" } }),
  ]);
  const events = await collect(model.stream({ messages: [] }));
  expect(events.filter((streamEvent) => streamEvent.type === "reasoning_end" || streamEvent.type === "text_end")).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "length" });
});

test("rejects completed Codex content that contradicts an already streamed prefix", async () => {
  const model = codexStreamModel([
    data({ type: "response.output_item.added", output_index: 0, item: { type: "message", phase: "final_answer" } }),
    data({ type: "response.output_text.delta", output_index: 0, delta: "Original " }),
    data({ type: "response.output_text.done", output_index: 0, text: "Different text." }),
    data({ type: "response.completed", response: { status: "completed" } }),
  ]);
  const events: ModelStreamEvent[] = [];
  await expect((async () => {
    for await (const streamEvent of model.stream({ messages: [] })) events.push(streamEvent);
  })()).rejects.toThrow("disagrees with its streamed prefix");
  expect(events.filter((streamEvent) => streamEvent.type === "text_end")).toEqual([]);
});

test("replays the completed encrypted reasoning item on the next stateless request", async () => {
  const addedItem = {
    id: "reasoning_round_trip",
    type: "reasoning",
    summary: [],
    encrypted_content: "partial-ciphertext",
  };
  const completedItem = {
    id: "reasoning_round_trip",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Checked the repository." }],
    status: "completed",
    encrypted_content: "complete-ciphertext",
    provider_extension: { retained: true },
  };
  const model = codexStreamModel([
    data({ type: "response.created", response: { id: "resp_round_trip", model: "gpt-5.6-sol" } }),
    data({ type: "response.output_item.added", output_index: 0, item: addedItem }),
    data({
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning_round_trip",
      output_index: 0,
      summary_index: 0,
      delta: "Checked the repository.",
    }),
    data({ type: "response.output_item.done", output_index: 0, item: completedItem }),
    data({
      type: "response.completed",
      response: { id: "resp_round_trip", model: "gpt-5.6-sol", status: "completed" },
    }),
  ]);

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));
  const reasoningItems = events.filter(
    (event): event is Extract<ModelStreamEvent, { type: "reasoning_item" }> => event.type === "reasoning_item",
  );

  expect(reasoningItems).toEqual([{
    type: "reasoning_item",
    output: {
      apiFamily: "openai-responses",
      outputIndex: 0,
      item: completedItem,
    },
  }]);

  const body = buildOpenAICodexResponsesRequestBody(
    {
      messages: [
        message("assistant", [{
          type: "reasoning",
          text: "",
          modelOutput: reasoningItems[0]?.output,
        }]),
        message("user", [{ type: "text", text: "Continue." }]),
      ],
      tools: [],
      system: [],
    },
    { model: "gpt-5.6-sol", reasoningContext: "all_turns" },
  );

  expect(body.reasoning).toEqual({ context: "all_turns", summary: "auto" });
  expect(body.input).toEqual([
    completedItem,
    { role: "user", content: [{ type: "input_text", text: "Continue." }] },
  ]);
});

test("maps incomplete Codex tool-call responses to length", async () => {
  const model = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: sseFetch([
      data({ type: "response.created", response: { id: "resp_incomplete", model: "gpt-5.6-sol" } }),
      data({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_incomplete", call_id: "call_incomplete", name: "write_file", arguments: "" },
      }),
      data({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", id: "fc_incomplete", call_id: "call_incomplete", name: "write_file", arguments: "{\"filePath\":\"a.txt\"" },
      }),
      data({
        type: "response.incomplete",
        response: { id: "resp_incomplete", model: "gpt-5.6-sol" },
      }),
    ]),
    env: {},
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events.map((event) => event.type)).toContain("tool_call_end");
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "length" });
});

test("marks invalid Codex tool arguments", async () => {
  const model = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: sseFetch([
      data({ type: "response.created", response: { id: "resp_invalid_args", model: "gpt-5.6-sol" } }),
      data({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_invalid", call_id: "call_invalid", name: "lookup", arguments: "" },
      }),
      data({
        type: "response.function_call_arguments.done",
        item_id: "fc_invalid",
        arguments: "{\"q\":" ,
      }),
      data({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", id: "fc_invalid", call_id: "call_invalid", name: "lookup", arguments: "{\"q\":" },
      }),
      data({
        type: "response.completed",
        response: { id: "resp_invalid_args", model: "gpt-5.6-sol", status: "completed" },
      }),
    ]),
    env: {},
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events.find((event) => event.type === "tool_call_end")).toMatchObject({
    type: "tool_call_end",
    toolCallId: "call_invalid",
    name: "lookup",
    input: {},
    inputParseError: expect.stringContaining("not valid JSON"),
  });
});

test("sends OpenAI-compatible Codex requests without ChatGPT account headers", async () => {
  let url = "";
  let headers = new Headers();
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (input, init) => {
    url = String(input);
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(streamText([
      data({ type: "response.created", response: { id: "resp_gateway", model: "gpt-5.6-sol" } }),
      data({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_gateway", phase: "final_answer" },
      }),
      data({ type: "response.output_text.delta", output_index: 0, delta: "ok" }),
      data({ type: "response.completed", response: { id: "resp_gateway", model: "gpt-5.6-sol", status: "completed" } }),
    ].join("")), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const apiKey = jwtWithAccount("must_not_be_inferred");
  const model = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey,
    baseUrl: "https://api.codexapi.space/v1",
    reasoningEffort: "xhigh",
    serviceTier: "fast",
    fetch: fetchImpl,
  });
  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(url).toBe("https://api.codexapi.space/v1/responses");
  expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`);
  expect(headers.get("chatgpt-account-id")).toBeNull();
  expect(headers.get("openai-beta")).toBeNull();
  expect(body).toMatchObject({
    model: "gpt-5.6-sol",
    reasoning: { effort: "xhigh", summary: "auto" },
    service_tier: "priority",
  });
  expect(events[0]).toMatchObject({ type: "metadata", provider: "codex-api", model: "gpt-5.6-sol" });
  expect(events).toContainEqual({ type: "text_delta", text: "ok", index: 0, phase: "final_answer" });
});

test("surfaces nested OpenAI Codex SSE error details", async () => {
  const model = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: sseFetch([
      data({ type: "response.created", response: { id: "resp_error", model: "gpt-5.6-sol" } }),
      data({
        type: "error",
        error: {
          message: "Request too large for model",
          code: "context_length_exceeded",
          type: "invalid_request_error",
          param: "input",
          request_id: "req_sse_1",
        },
      }),
    ]),
    env: {},
  });

  const error = await rejectedProviderError(() => collect(model.stream({ messages: [], tools: [], system: [] })));
  expect(error).toMatchObject({
    provider: "codex-api",
    code: "context_length_exceeded",
    type: "invalid_request_error",
    param: "input",
    requestId: "req_sse_1",
    message: "OpenAI Codex stream error (request id: req_sse_1)",
  });
});

test("surfaces OpenAI Codex response.failed error details", async () => {
  const model = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: sseFetch([
      data({
        type: "response.failed",
        response: {
          id: "resp_failed",
          model: "gpt-5.6-sol",
          status: "failed",
          error: {
            message: "Rate limit reached",
            code: "rate_limit_exceeded",
            request_id: "req_failed_1",
            retry_after_ms: 10 * 24 * 60 * 60 * 1_000,
          },
        },
      }),
    ]),
    env: {},
  });

  const error = await rejectedProviderError(() => collect(model.stream({ messages: [], tools: [], system: [] })));
  expect(error).toMatchObject({
    provider: "codex-api",
    category: "rate_limit",
    retryable: true,
    opensCircuit: false,
    code: "rate_limit_exceeded",
    requestId: "req_failed_1",
    retryAfterMs: PROVIDER_RETRY_AFTER_MAX_MS,
    message: "OpenAI Codex response failed (request id: req_failed_1)",
  });
});

test("types Codex string-form HTTP and SSE machine errors", async () => {
  const expectations = [
    { code: "rate_limit_exceeded", category: "rate_limit", retryable: true, opensCircuit: false },
    { code: "usage_limit_reached", category: "quota_exhausted", retryable: false, opensCircuit: true },
    { code: "usage_not_included", category: "quota_exhausted", retryable: false, opensCircuit: true },
  ] as const;

  for (const expected of expectations) {
    const sseError = await rejectedProviderError(() => collect(codexStreamModel([
      data({ type: "error", error: expected.code }),
    ]).stream({ messages: [] })));
    expect(sseError).toMatchObject({ provider: "codex-api", ...expected });
  }

  const httpModel = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: (async () => new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
    env: {},
  });
  const httpError = await rejectedProviderError(() => collect(httpModel.stream({ messages: [] })));
  expect(httpError).toMatchObject({
    provider: "codex-api",
    status: 429,
    code: "rate_limit_exceeded",
    category: "rate_limit",
    retryable: true,
  });
});

test("types missing-body and 2xx JSON Codex response failures", async () => {
  const missingBody = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: (async () => new Response(null, {
      status: 200,
      headers: { "x-request-id": "req_missing_body" },
    })) as unknown as typeof fetch,
    env: {},
  });
  const missingError = await rejectedProviderError(() => collect(missingBody.stream({ messages: [] })));
  expect(missingError).toMatchObject({
    provider: "codex-api",
    status: 200,
    requestId: "req_missing_body",
    message: "OpenAI Codex response did not include a body (request id: req_missing_body)",
  });

  const envelope = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: (async () => new Response(JSON.stringify({
      error: {
        message: "Quota exhausted for API key is SUPERSECRET12345 at 2001:db8::1234",
        code: "usage_limit_reached",
      },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_codex_2xx",
        "retry-after": String(10 * 24 * 60 * 60),
      },
    })) as unknown as typeof fetch,
    env: {},
  });
  const envelopeError = await rejectedProviderError(() => collect(envelope.stream({ messages: [] })));
  expect(envelopeError).toMatchObject({
    provider: "codex-api",
    status: 200,
    code: "usage_limit_reached",
    requestId: "req_codex_2xx",
    retryAfterMs: PROVIDER_RETRY_AFTER_MAX_MS,
    category: "quota_exhausted",
    retryable: false,
    opensCircuit: true,
    message: "OpenAI Codex response failed (request id: req_codex_2xx)",
  });
  expect(envelopeError.message).not.toContain("SUPERSECRET12345");
  expect(envelopeError.message).not.toContain("2001:db8::1234");
});

test("surfaces OpenAI Codex HTTP error details", async () => {
  const model = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: (async () =>
      new Response(JSON.stringify({
        error: {
          message: "Invalid token",
          code: "invalid_api_key",
          request_id: "req_http_1",
        },
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    env: {},
  });

  const error = await rejectedProviderError(() => collect(model.stream({ messages: [], tools: [], system: [] })));
  expect(error).toMatchObject({
    provider: "codex-api",
    status: 401,
    category: "authentication",
    retryable: false,
    requestId: "req_http_1",
    message: "Codex API request failed with HTTP 401 Unauthorized (request id: req_http_1)",
  });
  expect(error.code).toBeUndefined();
});

test("validates structured Codex error fields before selecting a public message", async () => {
  const model = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: (async () => new Response(JSON.stringify({
      error: {
        message: { nested: "private-message-10.9.8.7" },
        code: 1234,
        type: ["private-type"],
        request_id: { secret: "private-request-id" },
      },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch,
    env: {},
  });

  const error = await rejectedProviderError(() => collect(model.stream({ messages: [] })));
  expect(error).toMatchObject({
    provider: "codex-api",
    status: 400,
    category: "invalid_request",
    code: "1234",
    message: "Codex API request failed with HTTP 400 Bad Request",
  });
  expect(error.message).not.toContain("private-message");
  expect(error.message).not.toContain("private-type");
  expect(error.message).not.toContain("private-request-id");
  expect(error.message).not.toContain("10.9.8.7");
});

test("does not expose sensitive Codex machine fields", async () => {
  const model = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: (async () => new Response(JSON.stringify({
      error: {
        message: "credential=hunter2 password=swordfish",
        code: "credential",
        type: "client_secret",
        param: "session_cookie",
        request_id: "password:private-request-id",
      },
    }), {
      status: 400,
      headers: { "content-type": "application/json", "x-request-id": "req_safe_codex" },
    })) as unknown as typeof fetch,
    env: {},
  });

  const error = await rejectedProviderError(() => collect(model.stream({ messages: [] })));
  expect(error).toMatchObject({
    provider: "codex-api",
    status: 400,
    requestId: "req_safe_codex",
    message: "Codex API request failed with HTTP 400 Bad Request (request id: req_safe_codex)",
  });
  expect(error.code).toBeUndefined();
  expect(error.type).toBeUndefined();
  expect(error.param).toBeUndefined();
  for (const probe of ["hunter2", "swordfish", "credential", "client_secret", "session_cookie", "private-request-id"]) {
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(probe);
  }
});

test("normalizes Codex API HTTP and raw SSE failures without exposing provider bodies", async () => {
  const html = "<!DOCTYPE html><html><body>gateway 10.9.8.7 bearer-secret-123</body></html>";
  const httpModel = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: (async () => new Response(html, { status: 502 })) as unknown as typeof fetch,
    env: {},
  });

  const httpError = await rejectedProviderError(() => collect(httpModel.stream({ messages: [] })));
  expect(httpError).toMatchObject({
    provider: "codex-api",
    status: 502,
    category: "server_error",
    retryable: true,
    message: "Codex API request failed with HTTP 502 Bad Gateway",
  });
  expect(httpError.message).not.toContain("10.9.8.7");
  expect(httpError.message).not.toContain("bearer-secret-123");

  const sseModel = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: sseFetch([`event: error\ndata: ${html}\n\n`]),
    env: {},
  });
  const sseError = await rejectedProviderError(() => collect(sseModel.stream({ messages: [] })));
  expect(sseError).toMatchObject({
    provider: "codex-api",
    message: "OpenAI Codex stream error",
  });
  expect(sseError.message).not.toContain("10.9.8.7");
  expect(sseError.message).not.toContain("bearer-secret-123");
});

test("keeps transient ChatGPT 429 failures retryable", async () => {
  const rateLimitFetch = (): typeof fetch => (async () => new Response(JSON.stringify({
    error: {
      message: "Gateway rate limit reached",
      code: "rate_limit_exceeded",
      request_id: "req_rate_limit",
    },
  }), {
    status: 429,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

  const apiModel = new CodexApiResponsesModel({
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: rateLimitFetch(),
  });
  await expect(collect(apiModel.stream({ messages: [] }))).rejects.toThrow(
    "Codex API request failed with HTTP 429 Too Many Requests (request id: req_rate_limit)",
  );

  const oauthModel = new OpenAICodexResponsesModel({
    model: "gpt-5.6-sol",
    authStorage: staticOAuthStorage(jwtWithAccount("acct_limit"), "acct_limit"),
    fetch: rateLimitFetch(),
  });
  const error = await rejectedProviderError(() => collect(oauthModel.stream({ messages: [] })));
  expect(error).toMatchObject({
    provider: OPENAI_CODEX_PROVIDER_ID,
    status: 429,
    category: "rate_limit",
    retryable: true,
    opensCircuit: false,
    code: "rate_limit_exceeded",
  });
  expect(error.message).toBe("OpenAI Codex request failed with HTTP 429 Too Many Requests (request id: req_rate_limit)");
});

test.each(["usage_limit_reached", "usage_not_included"])(
  "opens the ChatGPT usage circuit for %s",
  async (code) => {
    const model = new OpenAICodexResponsesModel({
      model: "gpt-5.6-sol",
      authStorage: staticOAuthStorage(jwtWithAccount("acct_limit"), "acct_limit"),
      fetch: (async () => new Response(JSON.stringify({
        error: {
          message: "Provider-specific private quota detail",
          code,
          plan_type: "Plus",
          resets_at: Math.round((Date.now() + 120_000) / 1_000),
          request_id: "req_usage_limit",
        },
      }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    });

    const error = await rejectedProviderError(() => collect(model.stream({ messages: [] })));
    expect(error).toMatchObject({
      provider: OPENAI_CODEX_PROVIDER_ID,
      status: 429,
      category: "quota_exhausted",
      retryable: false,
      opensCircuit: true,
      code,
      requestId: "req_usage_limit",
    });
    expect(error.message).toContain("You have hit your ChatGPT usage limit.");
    expect(error.message).not.toContain("plus plan");
    expect(error.message).not.toContain("Provider-specific private quota detail");
  },
);

async function rejectedProviderError(run: () => Promise<unknown>): Promise<ProviderError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error("Expected operation to reject with ProviderError");
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function message(role: Message["role"], parts: Array<Record<string, unknown>>): Message {
  const messageId = `msg_${role}_${Math.random().toString(16).slice(2)}` as MessageId;
  return {
    id: messageId,
    sessionId,
    role,
    parts: parts.map((part, index) => ({
      id: `part_${index}` as PartId,
      messageId,
      sessionId,
      ...part,
    })) as Message["parts"],
    createdAt,
  };
}

function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseFetch(events: string[]): typeof fetch {
  return (async () =>
    new Response(streamText(events.join("")), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
}

function codexStreamModel(events: readonly string[]): CodexApiResponsesModel {
  return new CodexApiResponsesModel({
    backpressureCoordinator: new ProviderBackpressureCoordinator(),
    model: "gpt-5.6-sol",
    apiKey: "api-key",
    baseUrl: "https://gateway.test/v1",
    fetch: sseFetch([...events]),
    env: {},
  });
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

function jwtWithAccount(accountId: string): string {
  return jwtWithPayload({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
}

function staticOAuthStorage(access: string, accountId: string): FileAuthStorage {
  return new StaticOAuthStorage({
    type: "oauth",
    access,
    refresh: "refresh_test",
    expires: Date.now() + 60 * 60 * 1000,
    accountId,
  });
}

class StaticOAuthStorage extends FileAuthStorage {
  readonly writes: OAuthCredentials[] = [];

  constructor(private credential: OAuthCredential) {
    super("/tmp/chili-static-oauth-test.json");
  }

  override async getOAuthCredentials(provider: string): Promise<OAuthCredential | undefined> {
    return provider === OPENAI_CODEX_PROVIDER_ID ? this.credential : undefined;
  }

  override async claimOAuthRefresh(): Promise<"claimed"> { return "claimed"; }

  override async commitOAuthRefresh(provider: string, expected: OAuthCredential, credentials: OAuthCredentials): Promise<boolean> {
    if (this.credential !== expected) return false;
    await this.setOAuthCredentials(provider, credentials);
    return true;
  }

  override async releaseOAuthRefresh(): Promise<void> {}

  override async setOAuthCredentials(provider: string, credentials: OAuthCredentials): Promise<void> {
    if (provider !== OPENAI_CODEX_PROVIDER_ID) return;
    this.writes.push({ ...credentials });
    this.credential = { type: "oauth", ...credentials };
  }
}

function jwtWithPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}
