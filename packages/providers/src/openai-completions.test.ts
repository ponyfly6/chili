import { beforeEach, expect, test } from "bun:test";
import { sharedProviderBackpressureCoordinator } from "./provider-backpressure.js";
beforeEach(() => sharedProviderBackpressureCoordinator.clear());
import type { Message, MessageId, PartId, SessionId, TimestampMs, ToolCallId } from "@chili/protocol";
import {
  buildOpenAICompletionsRequestBody,
  OpenAICompletionsModel,
  ProviderError,
  resolveChatCompletionsUrl,
} from "./index.js";
import type { ModelStreamEvent, ModelStreamInput, ModelTool, ReasoningLevel } from "./types.js";

const sessionId = "session_openai" as SessionId;
const createdAt = 1 as TimestampMs;

test("converts Chili messages and tools into an OpenAI-compatible chat completions body", () => {
  const callId = "call_weather" as ToolCallId;
  const messages = [
    message("system", [{ type: "text", text: "stored system" }]),
    message("user", [{ type: "text", text: "hello" }]),
    message("assistant", [
      { type: "text", text: "I will check." },
      { type: "tool_call", callId, toolName: "weather", input: { city: "Shanghai" }, status: "pending" },
    ]),
    message("user", [{ type: "tool_result", callId, output: "sunny" }]),
  ];
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

  const body = buildOpenAICompletionsRequestBody(
    {
      messages,
      tools,
      system: ["runtime system"],
    },
    {
      provider: "openai",
      model: "gpt-test",
      baseUrl: "https://api.openai.com/v1",
      maxTokens: 123,
      temperature: 0.2,
      stream: true,
    },
  );

  expect(body).toEqual({
    model: "gpt-test",
    max_completion_tokens: 123,
    stream: true,
    store: false,
    stream_options: { include_usage: true },
    temperature: 0.2,
    messages: [
      { role: "system", content: "runtime system\n\nstored system" },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "I will check.",
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: { name: "weather", arguments: "{\"city\":\"Shanghai\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: callId, content: "sunny" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "weather",
          description: "Read weather.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
  });
});

test("adds controlled execution context to OpenAI tool result content", () => {
  const callId = "call_sandboxed" as ToolCallId;
  const body = buildOpenAICompletionsRequestBody(
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
            timedOut: false,
          },
        }]),
      ],
      tools: [],
      system: [],
    },
    {
      provider: "openai",
      model: "gpt-test",
    },
  );

  expect((body.messages as unknown[]).at(-1)).toEqual({
    role: "tool",
    tool_call_id: callId,
    content: [
      "command failed",
      "",
      "[tool execution context]",
      "sandbox: macos-seatbelt",
      "execution_mode: sandboxed",
      "exit_code: 1",
      "timed_out: false",
    ].join("\n"),
  });
});

test("uses compatibility settings when shaping OpenAI-compatible requests", () => {
  const body = buildOpenAICompletionsRequestBody(
    {
      messages: [message("system", [{ type: "text", text: "system" }])],
      tools: [],
      system: ["runtime"],
    },
    {
      provider: "deepseek",
      model: "deepseek-reasoner",
      baseUrl: "https://api.deepseek.com",
      maxTokens: 64,
      stream: true,
      reasoning: true,
      compatibility: {
        maxTokensField: "max_tokens",
        supportsStore: false,
        supportsDeveloperRole: true,
        supportsUsageInStreaming: false,
      },
    },
  );

  expect(body).toMatchObject({
    model: "deepseek-reasoner",
    max_tokens: 64,
    stream: true,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    messages: [{ role: "developer", content: "runtime\n\nsystem" }],
  });
  expect(body).not.toHaveProperty("store");
  expect(body).not.toHaveProperty("stream_options");
  expect(body).not.toHaveProperty("max_completion_tokens");
});

test("maps product-level ultra reasoning to max for compatible APIs", () => {
  const body = buildOpenAICompletionsRequestBody(
    { messages: [], tools: [], system: [] },
    {
      provider: "zai",
      model: "glm-5.3",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
      reasoningEffort: "ultra",
    },
  );

  expect(body).toMatchObject({
    thinking: { type: "enabled" },
    reasoning_effort: "max",
  });
});

test("uses Kimi K3 reasoning effort without the legacy thinking switch", () => {
  const enabled = buildOpenAICompletionsRequestBody(
    { messages: [], tools: [], system: [] },
    {
      provider: "kimi",
      model: "kimi-k3",
      baseUrl: "https://api.moonshot.cn/v1",
      maxTokens: 131072,
      reasoning: true,
      reasoningEffort: "medium",
    },
  );

  expect(enabled).toMatchObject({
    max_completion_tokens: 131072,
    reasoning_effort: "high",
  });
  expect(enabled).not.toHaveProperty("max_tokens");
  expect(enabled).not.toHaveProperty("thinking");

  const lowestEffort = buildOpenAICompletionsRequestBody(
    { messages: [], tools: [], system: [] },
    {
      provider: "kimi",
      model: "kimi-k3",
      baseUrl: "https://api.moonshot.cn/v1",
      reasoning: false,
    },
  );

  expect(lowestEffort).toMatchObject({ reasoning_effort: "low" });
  expect(lowestEffort).not.toHaveProperty("thinking");
});

test("uses Grok 4.6 reasoning effort without a thinking switch", () => {
  const enabled = buildOpenAICompletionsRequestBody(
    { messages: [], tools: [], system: [] },
    {
      provider: "xai",
      model: "grok-4.6",
      baseUrl: "https://api.x.ai/v1",
      reasoning: true,
      reasoningEffort: "xhigh",
    },
  );

  expect(enabled).toMatchObject({ reasoning_effort: "xhigh" });
  expect(enabled).not.toHaveProperty("thinking");

  const lowestEffort = buildOpenAICompletionsRequestBody(
    { messages: [], tools: [], system: [] },
    {
      provider: "xai",
      model: "grok-4.6",
      baseUrl: "https://api.x.ai/v1",
      reasoning: false,
    },
  );

  expect(lowestEffort).toMatchObject({ reasoning_effort: "low" });
  expect(lowestEffort).not.toHaveProperty("thinking");
});

test("forces GLM-5.3 thinking on and maps off to low effort", () => {
  const defaults = buildOpenAICompletionsRequestBody(
    { messages: [], tools: [], system: [] },
    {
      provider: "zai",
      model: "glm-5.3",
      baseUrl: "https://api.z.ai/api/paas/v4",
    },
  );

  expect(defaults).toMatchObject({ thinking: { type: "enabled", clear_thinking: false } });
  expect(defaults).not.toHaveProperty("reasoning_effort");

  const lowestEffort = buildOpenAICompletionsRequestBody(
    { messages: [], tools: [], system: [] },
    {
      provider: "zai",
      model: "glm-5.3",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: false,
    },
  );

  expect(lowestEffort).toMatchObject({
    thinking: { type: "enabled", clear_thinking: false },
    reasoning_effort: "low",
  });
});

test("maps DeepSeek reasoning levels and preserves its thinking switch", () => {
  const disabled = buildOpenAICompletionsRequestBody(
    { messages: [], tools: [], system: [] },
    {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com",
      reasoning: false,
    },
  );
  expect(disabled).toMatchObject({ thinking: { type: "disabled" } });
  expect(disabled).not.toHaveProperty("reasoning_effort");

  for (const [reasoningEffort, expected] of [
    ["low", "low"],
    ["medium", "high"],
    ["high", "high"],
    ["xhigh", "high"],
    ["max", "max"],
  ] as const) {
    const body = buildOpenAICompletionsRequestBody(
      { messages: [], tools: [], system: [] },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        baseUrl: "https://api.deepseek.com",
        reasoning: true,
        reasoningEffort,
      },
    );
    expect(body).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: expected,
    });
  }
});

const perRequestReasoningCases: Array<{
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  modelReasoning: boolean;
  modelEffort: ReasoningLevel;
  input: Partial<Pick<ModelStreamInput, "reasoningLevel" | "reasoning" | "thinking" | "selection">>;
  expectedEffort: string;
  expectedThinking?: unknown;
}> = [
  {
    name: "xAI reasoning",
    provider: "xai",
    model: "grok-4.6",
    baseUrl: "https://api.x.ai/v1",
    modelReasoning: true,
    modelEffort: "high",
    input: { reasoning: "low" },
    expectedEffort: "low",
  },
  {
    name: "GLM reasoningLevel",
    provider: "zai",
    model: "glm-5.3",
    baseUrl: "https://api.z.ai/api/paas/v4",
    modelReasoning: true,
    modelEffort: "low",
    input: { reasoningLevel: "max" },
    expectedEffort: "max",
    expectedThinking: { type: "enabled", clear_thinking: false },
  },
  {
    name: "Kimi thinking alias",
    provider: "kimi",
    model: "kimi-k3",
    baseUrl: "https://api.moonshot.cn/v1",
    modelReasoning: true,
    modelEffort: "low",
    input: { thinking: "max" },
    expectedEffort: "max",
  },
  {
    name: "DeepSeek selection reasoning",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com",
    modelReasoning: false,
    modelEffort: "low",
    input: { selection: { reasoning: "max" } },
    expectedEffort: "max",
    expectedThinking: { type: "enabled" },
  },
];

for (const scenario of perRequestReasoningCases) {
  test(`per-request ${scenario.name} overrides the model default on the wire`, async () => {
    let body: Record<string, unknown> | undefined;
    const model = new OpenAICompletionsModel({
      provider: scenario.provider,
      model: scenario.model,
      apiKey: "test-key",
      baseUrl: scenario.baseUrl,
      reasoning: scenario.modelReasoning,
      reasoningEffort: scenario.modelEffort,
      fetch: (async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          id: `chatcmpl_${scenario.provider}`,
          model: scenario.model,
          choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    await collect(model.stream({
      messages: [],
      tools: [],
      system: [],
      ...scenario.input,
    }));

    expect(body?.reasoning_effort).toBe(scenario.expectedEffort);
    if (scenario.expectedThinking === undefined) {
      expect(body).not.toHaveProperty("thinking");
    } else {
      expect(body?.thinking).toEqual(scenario.expectedThinking);
    }
  });
}

test("routes developer and contextual user prompt fragments with system fallback", () => {
  const supported = buildOpenAICompletionsRequestBody(
    {
      messages: [message("user", [{ type: "text", text: "hello" }])],
      tools: [],
      system: ["base instructions"],
      developer: ["skills catalog"],
      contextualUser: ["memory context"],
    },
    {
      provider: "openai",
      model: "gpt-test",
      baseUrl: "https://api.openai.com/v1",
      stream: true,
      compatibility: { supportsDeveloperRole: true },
    },
  );

  expect(supported.messages).toEqual([
    { role: "system", content: "base instructions" },
    { role: "developer", content: "skills catalog" },
    { role: "user", content: "memory context" },
    { role: "user", content: "hello" },
  ]);

  const fallback = buildOpenAICompletionsRequestBody(
    {
      messages: [message("user", [{ type: "text", text: "hello" }])],
      tools: [],
      system: ["base instructions"],
      developer: ["skills catalog"],
      contextualUser: ["memory context"],
    },
    {
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      stream: true,
      compatibility: { supportsDeveloperRole: false, supportsStore: false, supportsUsageInStreaming: false },
    },
  );

  expect(fallback.messages).toEqual([
    { role: "system", content: "base instructions\n\nskills catalog" },
    { role: "user", content: "memory context" },
    { role: "user", content: "hello" },
  ]);
});

test("converts assistant-attached tool results into OpenAI tool messages", () => {
  const callId = "call_attached" as ToolCallId;
  const body = buildOpenAICompletionsRequestBody(
    {
      messages: [
        message("user", [{ type: "text", text: "read file" }]),
        message("assistant", [
          { type: "reasoning", text: "I should " },
          { type: "reasoning", text: "inspect the file first." },
          { type: "tool_call", callId, toolName: "read", input: { filePath: "README.md" }, status: "pending" },
          { type: "tool_result", callId, output: "contents" },
        ]),
        message("assistant", [
          { type: "reasoning", text: "The file contents are sufficient." },
          { type: "text", text: "contents summarized" },
        ]),
      ],
      tools: [],
      system: [],
    },
    {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com",
      maxTokens: 64,
      stream: true,
    },
  );

  expect(body.messages).toEqual([
    { role: "user", content: "read file" },
    {
      role: "assistant",
      content: "",
      reasoning_content: "I should inspect the file first.",
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: "read", arguments: "{\"filePath\":\"README.md\"}" },
        },
      ],
    },
    { role: "tool", tool_call_id: callId, content: "contents" },
    {
      role: "assistant",
      content: "contents summarized",
      reasoning_content: "The file contents are sufficient.",
    },
  ]);
});

test("OpenAI-compatible chat completions sends image tool results as text-only tool output", async () => {
  const callId = "call_image" as ToolCallId;
  let fetchCalled = false;
  let body: Record<string, unknown> | undefined;
  const model = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    inputCapabilities: ["text", "image"],
    fetch: (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      fetchCalled = true;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "chatcmpl_image_tool",
        model: "gpt-test",
        choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });

  const events = await collect(model.stream({
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
  }));

  expect(fetchCalled).toBe(true);
  expect((body?.messages as unknown[]).at(-1)).toEqual({
    role: "tool",
    tool_call_id: callId,
    content: "Image read: pixel.png",
  });
  expect(JSON.stringify(body)).not.toContain("image_url");
  expect(JSON.stringify(body)).not.toContain("data:image/");
  expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
});

test("image-capable chat completions models serialize direct user images", async () => {
  let body: Record<string, unknown> | undefined;
  const model = new OpenAICompletionsModel({
    provider: "kimi",
    model: "kimi-k3",
    apiKey: "test-key",
    baseUrl: "https://api.moonshot.cn/v1",
    inputCapabilities: ["text", "image"],
    fetch: (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "chatcmpl_image_user",
        model: "kimi-k3",
        choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });

  await collect(model.stream({
    messages: [
      message("user", [
        { type: "text", text: "What is in this image?" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ]),
      message("user", [
        { type: "image", data: "c2Vjb25k", mimeType: "image/jpeg" },
      ]),
    ],
    tools: [],
    system: [],
  }));

  expect(body?.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,aW1hZ2U=" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,c2Vjb25k" },
        },
      ],
    },
  ]);
});

test("OpenAI-compatible chat completions rejects pasted user images before request", async () => {
  let fetchCalled = false;
  const model = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    fetch: (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as unknown as typeof fetch,
  });

  await expect(
    collect(
      model.stream({
        messages: [
          message("user", [
            { type: "text", text: "What is in this image? [Image #1]" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ]),
        ],
        tools: [],
        system: [],
      }),
    ),
  ).rejects.toThrow("does not support image input");
  expect(fetchCalled).toBe(false);
});

test("resolves chat completions URL variants", () => {
  expect(resolveChatCompletionsUrl("https://api.test")).toBe("https://api.test/v1/chat/completions");
  expect(resolveChatCompletionsUrl("https://api.test/v1")).toBe("https://api.test/v1/chat/completions");
  expect(resolveChatCompletionsUrl("https://api.test/v1/chat/completions")).toBe(
    "https://api.test/v1/chat/completions",
  );
});

test("normalizes OpenAI-compatible HTML and plain-text HTTP failures", async () => {
  const scenarios: Array<{
    status: number;
    body: string;
    headers: Record<string, string>;
    message: string;
    secrets: string[];
  }> = [
    {
      status: 502,
      body: "<!DOCTYPE html><html><body>gateway 10.9.8.7 bearer-secret-123</body></html>",
      headers: { "content-type": "text/html", "x-request-id": "req_openai_http_1" },
      message: "Model request failed with HTTP 502 Bad Gateway (request id: req_openai_http_1)",
      secrets: ["10.9.8.7", "bearer-secret-123"],
    },
    {
      status: 503,
      body: "upstream private-token-456 at 10.8.7.6",
      headers: { "content-type": "text/plain" },
      message: "Model request failed with HTTP 503 Service Unavailable",
      secrets: ["private-token-456", "10.8.7.6"],
    },
  ];

  for (const scenario of scenarios) {
    const model = new OpenAICompletionsModel({
      provider: "openai",
      model: "gpt-test",
      apiKey: "test-key",
      baseUrl: "https://api.test",
      fetch: (async () => new Response(scenario.body, {
        status: scenario.status,
        headers: scenario.headers,
      })) as unknown as typeof fetch,
    });

    const error = await rejectedProviderError(() => collect(model.stream({ messages: [] })));
    expect(error).toMatchObject({
      name: "ProviderError",
      provider: "openai",
      status: scenario.status,
      category: "server_error",
      retryable: true,
      opensCircuit: false,
      message: scenario.message,
    });
    for (const secret of scenario.secrets) expect(error.message).not.toContain(secret);
  }
});

test("normalizes raw and structured OpenAI-compatible SSE errors", async () => {
  const rawHtml = "<!DOCTYPE html><html><body>gateway 10.9.8.7 bearer-secret-123</body></html>";
  const rawModel = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    fetch: sseFetch([`event: error\ndata: ${rawHtml}\n\n`]),
  });

  const rawEvents = await collect(rawModel.stream({ messages: [] }));
  expect(rawEvents).toHaveLength(1);
  expect(rawEvents[0]).toMatchObject({
    type: "error",
    error: {
      name: "ProviderError",
      provider: "openai",
      category: "unknown",
      retryable: false,
      opensCircuit: false,
      message: "Model stream failed",
    },
  });
  const rawError = eventProviderError(rawEvents[0]);
  expect(rawError.message).not.toContain("10.9.8.7");
  expect(rawError.message).not.toContain("bearer-secret-123");

  const structuredModel = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    fetch: sseFetch([data({
      error: {
        message: "Quota exhausted at 10.1.2.3 for api_key=private-stream-token",
        code: "rate_limit_exceeded",
        type: "rate_limit_error",
      },
    })], { "x-request-id": "req_openai_sse_1", "retry-after": "7" }),
  });

  const structuredEvents = await collect(structuredModel.stream({ messages: [] }));
  expect(structuredEvents).toHaveLength(1);
  expect(structuredEvents[0]).toMatchObject({
    type: "error",
    error: {
      name: "ProviderError",
      provider: "openai",
      code: "rate_limit_exceeded",
      type: "rate_limit_error",
      requestId: "req_openai_sse_1",
      retryAfterMs: 7_000,
      status: 200,
      category: "quota_exhausted",
      retryable: false,
      opensCircuit: true,
    },
  });
  const structuredError = eventProviderError(structuredEvents[0]);
  expect(structuredError.message).toBe("Model stream failed (request id: req_openai_sse_1)");
  expect(structuredError.message).not.toContain("Quota exhausted");
  expect(structuredError.message).not.toContain("10.1.2.3");
  expect(structuredError.message).not.toContain("private-stream-token");
});

test("normalizes OpenAI-compatible 2xx JSON error envelopes", async () => {
  const model = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    fetch: jsonFetch({
      id: "chatcmpl_error",
      error: {
        message: "Quota exhausted for Bearer bearer-secret-789",
        code: "insufficient_quota",
        type: "insufficient_quota",
      },
    }, { "x-request-id": "req_openai_json_1", "retry-after": "8" }),
  });

  const events = await collect(model.stream({ messages: [] }));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "error",
    responseId: "chatcmpl_error",
    error: {
      name: "ProviderError",
      provider: "openai",
      code: "insufficient_quota",
      type: "insufficient_quota",
      requestId: "req_openai_json_1",
      retryAfterMs: 8_000,
      status: 200,
      category: "quota_exhausted",
      retryable: false,
      opensCircuit: true,
    },
  });
  const error = eventProviderError(events[0]);
  expect(error.message).toBe("Model response failed (request id: req_openai_json_1)");
  expect(error.message).not.toContain("Quota exhausted");
  expect(error.message).not.toContain("bearer-secret-789");
});

test("parses OpenAI-compatible SSE text, reasoning, tool deltas, and usage", async () => {
  const model = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    fetch: sseFetch([
      data({
        id: "chatcmpl_1",
        model: "gpt-test",
        choices: [{ index: 0, delta: { reasoning_content: "think " } }],
      }),
      data({
        id: "chatcmpl_1",
        model: "gpt-test",
        choices: [{ index: 0, delta: { content: "hello " } }],
      }),
      data({
        id: "chatcmpl_1",
        model: "gpt-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: "{\"query\"" },
                },
              ],
            },
          },
        ],
      }),
      data({
        id: "chatcmpl_1",
        model: "gpt-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ":\"chili\"}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      data({
        id: "chatcmpl_1",
        model: "gpt-test",
        choices: [],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 4,
          total_tokens: 7,
          prompt_tokens_details: { cached_tokens: 1, cache_write_tokens: 1 },
        },
      }),
      "data: [DONE]\n\n",
    ]),
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events.map((event) => event.type)).toEqual([
    "metadata",
    "reasoning_delta",
    "text_delta",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_delta",
    "reasoning_end",
    "text_end",
    "metadata",
    "tool_call_end",
    "finish",
  ]);
  expect(events[1]).toEqual({ type: "reasoning_delta", text: "think ", index: 0 });
  expect(events[2]).toEqual({ type: "text_delta", text: "hello ", index: 0 });
  expect(events[6]).toEqual({ type: "reasoning_end", index: 0 });
  expect(events[7]).toEqual({ type: "text_end", index: 0 });
  expect(events[3]).toEqual({ type: "tool_call_start", toolCallId: "call_1", name: "lookup", index: 0 });
  expect(events[5]).toEqual({
    type: "tool_call_delta",
    toolCallId: "call_1",
    name: "lookup",
    delta: ":\"chili\"}",
    index: 0,
    partialInput: { query: "chili" },
  });
  expect(events.at(-2)).toEqual({
    type: "tool_call_end",
    toolCallId: "call_1",
    name: "lookup",
    input: { query: "chili" },
    index: 0,
  });
  expect(events.at(-1)).toMatchObject({
    type: "finish",
    reason: "tool_use",
    responseId: "chatcmpl_1",
    usage: {
      inputTokens: 1,
      outputTokens: 4,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 1,
      totalTokens: 7,
    },
  });
});

test("normalizes hostile OpenAI stream tool call ids consistently", async () => {
  const model = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    fetch: sseFetch([
      data({
        id: "chatcmpl_hostile_id",
        model: "gpt-test",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "__proto__", function: { name: "lookup", arguments: "{\"query\"" } }] },
        }],
      }),
      data({
        id: "chatcmpl_hostile_id",
        model: "gpt-test",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: ":\"chili\"}" } }] },
          finish_reason: "tool_calls",
        }],
      }),
      "data: [DONE]\n\n",
    ]),
  });

  const events = (await collect(model.stream({ messages: [], tools: [], system: [] })))
    .filter((event) => event.type.startsWith("tool_call_"));
  const ids = events.flatMap((event) => "toolCallId" in event ? [event.toolCallId] : []);
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(1);
  expect(ids[0]).toMatch(/^toolcall_invalid_[a-f0-9]{16}$/u);
});

test("marks invalid OpenAI-compatible streaming tool arguments", async () => {
  const model = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    fetch: sseFetch([
      data({
        id: "chatcmpl_invalid_args",
        model: "gpt-test",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_invalid",
              type: "function",
              function: { name: "lookup", arguments: "{\"query\":" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }),
      "data: [DONE]\n\n",
    ]),
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

test("marks invalid non-streaming OpenAI-compatible tool arguments", async () => {
  const model = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    fetch: jsonFetch({
      id: "chatcmpl_invalid_json",
      model: "gpt-test",
      choices: [{
        index: 0,
        message: {
          tool_calls: [{
            id: "call_invalid_json",
            type: "function",
            function: { name: "edit", arguments: "{\"filePath\":" },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }),
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events.at(-2)).toMatchObject({
    type: "tool_call_end",
    toolCallId: "call_invalid_json",
    name: "edit",
    input: {},
    inputParseError: expect.stringContaining("not valid JSON"),
    index: 0,
  });
});

test("keeps empty OpenAI-compatible tool arguments as empty input", async () => {
  const model = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    fetch: jsonFetch({
      id: "chatcmpl_empty_json",
      model: "gpt-test",
      choices: [{
        index: 0,
        message: {
          tool_calls: [{
            id: "call_empty_json",
            type: "function",
            function: { name: "noop", arguments: "" },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }),
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events.at(-2)).toEqual({
    type: "tool_call_end",
    toolCallId: "call_empty_json",
    name: "noop",
    input: {},
    index: 0,
  });
});

test("falls back to non-streaming OpenAI-compatible JSON responses", async () => {
  const model = new OpenAICompletionsModel({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: "https://api.test",
    fetch: jsonFetch({
      id: "chatcmpl_json",
      model: "gpt-test",
      choices: [
        {
          index: 0,
          message: {
            content: "done",
            tool_calls: [
              {
                id: "call_2",
                type: "function",
                function: { name: "edit", arguments: "{\"filePath\":\"README.md\"}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    }),
  });

  const events = await collect(model.stream({ messages: [], tools: [], system: [] }));

  expect(events.map((event) => event.type)).toEqual([
    "metadata",
    "text_delta",
    "text_end",
    "tool_call_start",
    "tool_call_end",
    "finish",
  ]);
  expect(events[0]).toMatchObject({
    type: "metadata",
    responseId: "chatcmpl_json",
    usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
  });
  expect(events[1]).toEqual({ type: "text_delta", text: "done", index: 0 });
  expect(events[2]).toEqual({ type: "text_end", index: 0 });
  expect(events[4]).toEqual({
    type: "tool_call_end",
    toolCallId: "call_2",
    name: "edit",
    input: { filePath: "README.md" },
    index: 0,
  });
  expect(events[5]).toMatchObject({ type: "finish", reason: "tool_use", responseId: "chatcmpl_json" });
});

test("leaves truncated or filtered Chat Completions content unfinished", async () => {
  for (const finishReason of ["length", "max_tokens", "max_output_tokens", "content_filter"]) {
    for (const stream of [true, false]) {
      const content = { reasoning_content: "Partial thinking", content: "Partial answer" };
      const model = new OpenAICompletionsModel({
        provider: "test-provider",
        model: "test-model",
        apiKey: "test-key",
        baseUrl: "https://model.test",
        fetch: stream
          ? sseFetch([
            data({ choices: [{ index: 0, delta: content }] }),
            data({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
          ])
          : jsonFetch({ choices: [{ index: 0, message: content, finish_reason: finishReason }] }),
      });
      const events = await collect(model.stream({ messages: [] }));
      expect(events.filter((streamEvent) => streamEvent.type === "text_end" || streamEvent.type === "reasoning_end")).toEqual([]);
      expect(events.filter((streamEvent) => streamEvent.type === "text_delta" || streamEvent.type === "reasoning_delta")).toHaveLength(2);
      expect(events.at(-1)?.type).toBe("finish");
    }
  }
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const streamEvent of stream) events.push(streamEvent);
  return events;
}

async function rejectedProviderError(run: () => Promise<unknown>): Promise<ProviderError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error("Expected operation to reject with ProviderError");
}

function eventProviderError(event: ModelStreamEvent | undefined): ProviderError {
  const error = event?.type === "error" ? event.error : undefined;
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
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

function sseFetch(events: string[], extraHeaders: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(streamText(events.join("")), {
      status: 200,
      headers: { "content-type": "text/event-stream", ...extraHeaders },
    })) as unknown as typeof fetch;
}

function jsonFetch(data: unknown, extraHeaders: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json", ...extraHeaders },
    })) as unknown as typeof fetch;
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
