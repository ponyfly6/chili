import { expect, test } from "bun:test";
import {
  parseChiliEvent,
  parseRuntimeModelDescriptor,
  parseRuntimeNonNegativeInteger,
  parseRuntimePositiveInteger,
  parseRuntimeStringRecord,
  rejectRuntimeUnknownFields,
  RuntimeValidationError,
} from "./runtime-validation.js";

test("runtime numeric contracts reject unsafe integers", () => {
  expect(() => parseRuntimeNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1, "tokens")).toThrow(
    "tokens must be a non-negative integer",
  );
  expect(() => parseRuntimePositiveInteger(Number.MAX_SAFE_INTEGER + 1, "limit")).toThrow(
    "limit must be a positive integer",
  );
});

test("model endpoints accept credential-free HTTP paths but reject URL credentials", () => {
  expect(parseRuntimeModelDescriptor({
    provider: "openai",
    model: "gpt",
    enabled: true,
    endpoint: "https://chatgpt.com/backend-api",
  }).endpoint).toBe("https://chatgpt.com/backend-api");
  expect(() => parseRuntimeModelDescriptor({
    provider: "openai",
    model: "gpt",
    endpoint: "https://user:secret@example.test/v1",
  })).toThrow("credential-free absolute HTTP(S) URL");
  expect(parseRuntimeModelDescriptor({
    provider: "openai",
    model: "gpt",
    endpoint: "HTTPS://EXAMPLE.TEST:443/v1/../v2",
  }).endpoint).toBe("https://example.test/v2");
  for (const endpoint of [
    "https://example.test/v1\nAuthorization: Bearer MODEL_CANARY",
    "https://example.test/\tMODEL_CANARY",
    "\rhttps://example.test/v1",
  ]) {
    expect(() => parseRuntimeModelDescriptor({ provider: "openai", model: "gpt", endpoint })).toThrow(
      "without control characters",
    );
  }
});

test("validation diagnostics never expose hostile object keys or an enumerable path", () => {
  let caught: unknown;
  try {
    parseRuntimeStringRecord({ ["authorization: Bearer CANARY_KEY\n".repeat(100)]: 42 }, "headers");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RuntimeValidationError);
  const error = caught as RuntimeValidationError;
  const message = error.message;
  expect(message.length).toBeLessThan(700);
  expect(message).not.toContain("\n");
  expect(message).not.toContain("\r");
  expect(message).not.toContain("CANARY_KEY");
  expect(error.path).toBe("headers[0]");
  expect(Object.keys(error)).not.toContain("path");
  expect(JSON.stringify(error)).not.toContain("CANARY_KEY");

  let unknownField: unknown;
  try {
    rejectRuntimeUnknownFields({ "Authorization: Bearer UNKNOWN_CANARY": true }, [], "body");
  } catch (error) {
    unknownField = error;
  }
  expect(unknownField).toBeInstanceOf(RuntimeValidationError);
  expect((unknownField as Error).message).toBe("body.* contains an unsupported field");
  expect((unknownField as RuntimeValidationError).path).toBe("body.*");
});

test("all event families reject a known type with a wrong-shaped payload", () => {
  for (const [type, sessionId] of [
    ["session.created", "session_1"],
    ["turn.started", undefined],
    ["message.created", undefined],
    ["tool.call_started", undefined],
    ["approval.requested", undefined],
    ["user_input.requested", "session_1"],
    ["snapshot.created", undefined],
    ["mcp.progress", undefined],
  ] as const) {
    expect(() => parseChiliEvent({
      id: `event_${type}`,
      type,
      time: 1,
      ...(sessionId ? { sessionId } : {}),
      payload: {},
    })).toThrow();
  }
});

test("event validation accepts multiline text and rejects nested projection poison", () => {
  expect(parseChiliEvent({
    id: "event_tool",
    type: "tool.output_delta",
    time: 1,
    payload: { callId: "call_1", stream: "stdout", delta: "line 1\nline 2" },
  }).type).toBe("tool.output_delta");

  expect(() => parseChiliEvent({
    id: "event_mcp",
    type: "mcp.progress",
    time: 1,
    payload: { serverName: "github", operation: "connect", status: 7 },
  })).toThrow("event.payload.status");
});

test("message part events reject malformed nested reasoning and tool result fields", () => {
  const eventWithPart = (part: Record<string, unknown>) => ({
    id: "event_message_part",
    type: "message.part_added",
    time: 1,
    payload: {
      messageId: "message_1",
      part: {
        id: "part_1",
        messageId: "message_1",
        sessionId: "session_1",
        ...part,
      },
    },
  });

  for (const [part, expectedPath] of [
    [
      { type: "reasoning", text: "", modelOutput: { apiFamily: 7, item: {} } },
      "event.payload.part.modelOutput.apiFamily",
    ],
    [
      { type: "reasoning", text: "", modelOutput: { apiFamily: "responses", outputIndex: -1, item: {} } },
      "event.payload.part.modelOutput.outputIndex",
    ],
    [
      { type: "reasoning", text: "", modelOutput: { apiFamily: "responses", outputIndex: 0.5, item: {} } },
      "event.payload.part.modelOutput.outputIndex",
    ],
    [
      {
        type: "reasoning",
        text: "",
        modelOutput: { apiFamily: "responses", outputIndex: Number.MAX_SAFE_INTEGER + 1, item: {} },
      },
      "event.payload.part.modelOutput.outputIndex",
    ],
    [
      { type: "reasoning", text: "", modelOutput: { apiFamily: "responses", item: [] } },
      "event.payload.part.modelOutput.item",
    ],
    [
      { type: "tool_result", callId: "call_1", output: "ok", content: "not-an-array" },
      "event.payload.part.content",
    ],
    [
      { type: "tool_result", callId: "call_1", output: "ok", content: [{ type: "text", text: 7 }] },
      "event.payload.part.content[0].text",
    ],
    [
      { type: "tool_result", callId: "call_1", output: "ok", executionContext: { timedOut: "yes" } },
      "event.payload.part.executionContext.timedOut",
    ],
    [
      { type: "tool_result", callId: "call_1", output: "ok", executionContext: { sandbox: "container" } },
      "event.payload.part.executionContext.sandbox",
    ],
    [
      { type: "tool_result", callId: "call_1", output: "ok", executionContext: { exitCode: 0.5 } },
      "event.payload.part.executionContext.exitCode",
    ],
    [
      {
        type: "tool_result",
        callId: "call_1",
        output: "ok",
        executionContext: { exitCode: Number.MAX_SAFE_INTEGER + 1 },
      },
      "event.payload.part.executionContext.exitCode",
    ],
    [
      { type: "tool_result", callId: "call_1", output: "ok", artifactIds: [7] },
      "event.payload.part.artifactIds[0]",
    ],
  ] as const) {
    expect(() => parseChiliEvent(eventWithPart(part))).toThrow(expectedPath);
  }

  expect(parseChiliEvent(eventWithPart({
    type: "reasoning",
    text: "",
    modelOutput: { apiFamily: "responses", outputIndex: 0, item: { type: "reasoning" } },
  })).type).toBe("message.part_added");
  expect(parseChiliEvent(eventWithPart({
    type: "tool_result",
    callId: "call_1",
    output: "ok",
    content: [
      { type: "text", text: "" },
      { type: "image", data: "", mimeType: "image/png" },
    ],
    executionContext: {
      sandbox: "macos-seatbelt",
      executionMode: "sandboxed",
      exitCode: 0,
      timedOut: false,
      aborted: false,
      signal: null,
    },
    artifactIds: ["artifact_1"],
  })).type).toBe("message.part_added");
  expect(parseChiliEvent(eventWithPart({
    type: "tool_result",
    callId: "call_2",
    output: "",
    executionContext: { exitCode: null },
  })).type).toBe("message.part_added");
});
