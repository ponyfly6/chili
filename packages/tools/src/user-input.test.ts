import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  SessionId,
  ToolCallId,
  TurnId,
  UserInputId,
  UserInputQuestion,
} from "@chili/protocol";
import { PERSISTED_ERROR_LIMITS } from "@chili/protocol";
import type { ChiliToolExecutionContext } from "./types.js";
import { DeferredUserInputQueue, createRequestUserInputTool } from "./user-input.js";

const questions: UserInputQuestion[] = [
  {
    id: "theme",
    header: "Theme",
    question: "Which theme should Chili use?",
    options: [
      { label: "Light", description: "Use a light color scheme." },
      { label: "Dark", description: "Use a dark color scheme." },
    ],
  },
];

test("DeferredUserInputQueue lists, filters, resolves once, and returns defensive values", async () => {
  const queue = new DeferredUserInputQueue();
  const first = queue.ask(request("userinput_1", "session_1", "toolcall_1"));
  const second = queue.ask(request("userinput_2", "session_2", "toolcall_2"));

  const listed = queue.list({ sessionId: "session_1" as SessionId });
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ id: "userinput_1", sessionId: "session_1", callId: "toolcall_1" });
  listed[0]!.questions[0]!.question = "mutated";
  expect(queue.list({ sessionId: "session_1" as SessionId })[0]!.questions[0]!.question).toBe(questions[0]!.question);

  expect(queue.resolve({ inputId: "userinput_1" as UserInputId, answers: { theme: ["Dark"] } })).toBe(true);
  expect(queue.resolve({ inputId: "userinput_1" as UserInputId, answers: { theme: ["Light"] } })).toBe(false);
  expect(await first).toEqual({ theme: ["Dark"] });
  expect(queue.list()).toHaveLength(1);

  queue.denyAll("runtime closed");
  await expect(second).rejects.toThrow("runtime closed");
  expect(queue.list()).toEqual([]);
});

test("DeferredUserInputQueue aborts pending requests and enforces input and queue limits", async () => {
  const controller = new AbortController();
  const queue = new DeferredUserInputQueue({ maxPending: 1 });
  const pending = queue.ask(request("userinput_abort", "session_1", "toolcall_abort"), controller.signal);

  expect(() => queue.ask(request("userinput_full", "session_1", "toolcall_full"))).toThrow("capacity exceeded");
  expect(() => queue.resolve({
    inputId: "userinput_abort" as UserInputId,
    answers: { theme: ["Light", "Dark"] },
  })).toThrow("between 1 and 1");
  expect(queue.list()).toHaveLength(1);

  const reason = new DOMException("stop waiting", "AbortError");
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(queue.list()).toEqual([]);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort(reason);
  await expect(queue.ask(request("userinput_late", "session_1", "toolcall_late"), alreadyAborted.signal)).rejects.toBe(reason);
});

test("request_user_input publishes lifecycle events and returns structured answers", async () => {
  const queue = new DeferredUserInputQueue();
  const events: ChiliEvent[] = [];
  let sequence = 0;
  const tool = createRequestUserInputTool(
    queue,
    { publish: async (event) => { events.push(event); } },
    (prefix) => `${prefix}_${++sequence}`,
  );

  expect(tool.risk).toBe("read");
  expect(tool.isConcurrencySafe).toBe(false);
  const validation = await tool.validate?.({ questions });
  expect(validation).toEqual({ ok: true, value: { questions } });
  expect((await tool.validate?.({ questions: [] }))).toMatchObject({ ok: false });

  const execution = tool.execute({ questions }, executionContext());
  const [pending] = queue.list();
  expect(pending).toMatchObject({
    id: "userinput_1",
    sessionId: "session_tool",
    callId: "toolcall_tool",
    questions,
  });
  expect(events).toMatchObject([{
    id: "event_2",
    type: "user_input.requested",
    sessionId: "session_tool",
    payload: { inputId: "userinput_1", callId: "toolcall_tool", questions },
  }]);

  expect(queue.resolve({ inputId: pending!.id, answers: { theme: ["Dark"] } })).toBe(true);
  const result = await execution;
  expect(JSON.parse(result.output)).toEqual({ inputId: "userinput_1", answers: { theme: ["Dark"] } });
  expect(events.map((event) => event.type)).toEqual(["user_input.requested", "user_input.resolved"]);
  expect(events[1]).toMatchObject({
    sessionId: "session_tool",
    payload: { inputId: "userinput_1", answers: { theme: ["Dark"] } },
  });
});

test("request_user_input publishes a terminal cancellation after abort and deny", async () => {
  for (const mode of ["abort", "deny"] as const) {
    const queue = new DeferredUserInputQueue();
    const events: ChiliEvent[] = [];
    const controller = new AbortController();
    let sequence = 0;
    const tool = createRequestUserInputTool(
      queue,
      { publish: async (event) => { events.push(event); } },
      (prefix) => `${prefix}_${mode}_${++sequence}`,
    );
    const execution = tool.execute({ questions }, executionContext(controller.signal));
    const pending = queue.list()[0]!;

    if (mode === "abort") {
      controller.abort(new DOMException("desktop stopped the session", "AbortError"));
    } else {
      queue.denyAll("runtime shutting down");
    }

    await expect(execution).rejects.toThrow(mode === "abort" ? "desktop stopped the session" : "runtime shutting down");
    expect(queue.list()).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["user_input.requested", "user_input.cancelled"]);
    expect(events[1]).toMatchObject({
      sessionId: "session_tool",
      payload: {
        inputId: pending.id,
        reason: mode === "abort" ? "desktop stopped the session" : "runtime shutting down",
      },
    });
  }
});

test("request_user_input redacts and byte-bounds hostile abort and rejection reasons end to end", async () => {
  const bearer = "user-input-bearer-secret-123456";
  const clientSecret = "user-input-client-secret-123456";
  const password = "user-input-password-secret-123456";
  const loopbackUrl = `http://localhost:43123/input?access_token=${bearer}`;
  const rawMessage = [
    `Authorization: Bearer ${bearer}`,
    `client_secret=${clientSecret}`,
    `password=${password}`,
    `endpoint ${loopbackUrl}`,
    "\u0000\u001f\"\\😀".repeat(700_000),
  ].join("\n");
  expect(Buffer.byteLength(rawMessage, "utf8")).toBeGreaterThan(5 * 1024 * 1024);

  for (const mode of ["abort", "deny"] as const) {
    const queue = new DeferredUserInputQueue();
    const events: ChiliEvent[] = [];
    const controller = new AbortController();
    let sequence = 0;
    const tool = createRequestUserInputTool(
      queue,
      { publish: async (event) => { events.push(event); } },
      (prefix) => `${prefix}_${mode}_hostile_${++sequence}`,
    );
    const sourceError = Object.assign(new Error(rawMessage), {
      name: mode === "abort" ? "AbortError" : "UserInputDeniedError",
      code: "E_USER_INPUT_CANCELLED",
    });
    const execution = tool.execute({ questions }, executionContext(controller.signal));
    const pending = queue.list()[0]!;

    if (mode === "abort") controller.abort(sourceError);
    else queue.denyAll(sourceError);

    let rejection: unknown;
    try {
      await execution;
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBe(sourceError);
    const persistedError = rejection as Error & {
      code?: string;
      persistedErrorDetails?: { originalMessageBytes?: number; truncated?: true };
    };
    const event = events.find((candidate): candidate is Extract<ChiliEvent, { type: "user_input.cancelled" }> => (
      candidate.type === "user_input.cancelled"
    ));
    expect(events.map((candidate) => candidate.type)).toEqual(["user_input.requested", "user_input.cancelled"]);
    expect(event?.payload.inputId).toBe(pending.id);
    const reason = event?.payload.reason ?? "";
    expect(persistedError.message).toBe(reason);
    expect(persistedError.name).toBe(mode === "abort" ? "AbortError" : "UserInputDeniedError");
    expect(persistedError.code).toBe("E_USER_INPUT_CANCELLED");
    expect(persistedError.persistedErrorDetails).toMatchObject({
      truncated: true,
      originalMessageBytes: Buffer.byteLength(rawMessage, "utf8"),
    });
    expect(reason).toContain("Authorization: [REDACTED]");
    expect(reason).toContain("client_secret=[REDACTED]");
    expect(reason).toContain("password=[REDACTED]");
    expect(reason).toContain("[loopback URL redacted]");
    for (const secret of [bearer, clientSecret, password, loopbackUrl]) {
      expect(reason).not.toContain(secret);
      expect(JSON.stringify(event)).not.toContain(secret);
    }
    expect(Buffer.byteLength(reason, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    expect(Buffer.byteLength(JSON.stringify(event), "utf8"))
      .toBeLessThanOrEqual((PERSISTED_ERROR_LIMITS.messageBytes * 6) + 4_096);
  }
});

function request(id: string, sessionId: string, callId: string) {
  return {
    id: id as UserInputId,
    sessionId: sessionId as SessionId,
    callId: callId as ToolCallId,
    questions,
    createdAt: 123,
  };
}

function executionContext(signal = new AbortController().signal): ChiliToolExecutionContext {
  return {
    sessionId: "session_tool" as SessionId,
    turnId: "turn_tool" as TurnId,
    callId: "toolcall_tool" as ToolCallId,
    outputArtifactId: "tooloutput_tool" as ToolCallId,
    signal,
    cwd: "/repo",
    metadata: async () => undefined,
    streamOutput: async () => undefined,
    requestApproval: async () => ({ action: "deny" }),
    registerPersistedOutput: async () => undefined,
  };
}
