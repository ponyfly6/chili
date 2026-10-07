import { expect, test } from "bun:test";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import type { SessionId, ToolCallId, TurnId } from "@chili/protocol";
import type { ToolReviewRequest } from "@chili/tools";
import { createHostExecutionGate, DEFAULT_REVIEW_INSTRUCTIONS, type ReviewSettings } from "./approval.js";

const request: ToolReviewRequest = {
  sessionId: "session" as SessionId, turnId: "turn" as TurnId, callId: "call" as ToolCallId,
  toolName: "write", toolDescription: "Write a file", risk: "write", cwd: "/workspace",
  input: Object.freeze({ filePath: "/workspace/result.txt", content: "complete payload" }),
};
const defaults = (): ReviewSettings => ({ profile: "auto-review", reviewInstructions: DEFAULT_REVIEW_INSTRUCTIONS, revision: 0 });
const answer = (value: string): ModelRouter => ({ async *stream() { yield { type: "text_delta", text: value }; yield { type: "finish", reason: "stop" }; } });
const context = async () => ({ evidence: { humanInstructions: [{ source: "human_user", content: "Write result.txt" }] } });

test("Full Access does not invoke the reviewer or gather model evidence", async () => {
  const gate = createHostExecutionGate({ settings: () => ({ ...defaults(), profile: "full-access" }),
    model: { async *stream() { throw new Error("must not request a model"); } },
    contextForRequest: async () => { throw new Error("must not gather evidence"); },
  });
  expect((await gate.review(request)).decision).toBe("allow");
});

test("automatic review receives exact action and editable instructions without any tools", async () => {
  const inputs: ModelStreamInput[] = [];
  const instructions = "Allow autonomous changes; protect my private documents.";
  const gate = createHostExecutionGate({ settings: () => ({ ...defaults(), reviewInstructions: instructions, reviewerModel: { provider: "fixture", model: "reviewer" } }),
    contextForRequest: context,
    model: { async *stream(input) { inputs.push(input); yield* answer('{"decision":"allow","reason":"Within the requested task."}').stream(input); } },
  });
  const permit = await gate.review(request);
  expect(permit.decision).toBe("allow");
  await permit.assertCurrent?.();
  expect(inputs).toHaveLength(1);
  expect(inputs[0]?.tools).toEqual([]);
  expect(inputs[0]?.modelSelection).toEqual({ provider: "fixture", model: "reviewer" });
  expect(inputs[0]?.developer?.join("\n")).toContain(instructions);
  const part = inputs[0]?.messages[0]?.parts[0];
  expect(part?.type).toBe("text");
  if (part?.type !== "text") throw new Error("Missing review payload");
  expect(JSON.parse(part.text).action).toEqual(request);
  expect(JSON.parse(part.text).evidence.humanInstructions[0].source).toBe("human_user");
});

test("each action is reviewed independently and denial has its own reason", async () => {
  let calls = 0;
  const gate = createHostExecutionGate({ settings: defaults, contextForRequest: context,
    model: { async *stream(input) { calls++; yield* answer(JSON.stringify({ decision: calls === 1 ? "allow" : "deny", reason: "A separate decision for this exact call." })).stream(input); } },
  });
  expect((await gate.review(request)).decision).toBe("allow");
  expect(await gate.review(request)).toMatchObject({ decision: "deny", reason: "A separate decision for this exact call." });
  expect(calls).toBe(2);
});

for (const malformed of ['allow', '```json\n{"decision":"allow","reason":"ok"}\n```', '{"decision":"allow"}', '{"decision":"allow_always","reason":"ok"}', '{"decision":"allow","reason":"ok","scope":"session"}']) {
  test(`malformed reviewer output fails without becoming a decision: ${malformed}`, async () => {
    const gate = createHostExecutionGate({ settings: defaults, contextForRequest: context, model: answer(malformed) });
    await expect(gate.review(request)).rejects.toThrow(/invalid/i);
  });
}

test("review errors and timeouts never authorize execution", async () => {
  const failing = createHostExecutionGate({ settings: defaults, contextForRequest: context,
    model: { async *stream() { yield { type: "error", error: new Error("Provider unavailable") }; } },
  });
  await expect(failing.review(request)).rejects.toThrow("Provider unavailable");
  const hanging = createHostExecutionGate({ settings: defaults, contextForRequest: context, timeoutMs: 10,
    model: { async *stream(): AsyncIterable<ModelStreamEvent> { await new Promise(() => {}); } },
  });
  await expect(hanging.review(request)).rejects.toThrow("timed out");
});

test("cancellation returns promptly even when reviewer ignores cancellation", async () => {
  const controller = new AbortController();
  const gate = createHostExecutionGate({ settings: defaults, contextForRequest: context,
    model: { async *stream(): AsyncIterable<ModelStreamEvent> { await new Promise(() => {}); } },
  });
  const pending = gate.review(request, controller.signal);
  controller.abort(new Error("User interrupted"));
  await expect(pending).rejects.toThrow("User interrupted");
});

test("changing review settings invalidates both pending review and an issued permit", async () => {
  let settings = defaults();
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  const gate = createHostExecutionGate({ settings: () => settings, contextForRequest: context,
    model: { async *stream(input) { entered(); await wait; yield* answer('{"decision":"allow","reason":"ok"}').stream(input); } },
  });
  const pending = gate.review(request);
  await started;
  settings = { ...settings, revision: 1 };
  finish();
  await expect(pending).rejects.toThrow("settings changed");
  const permit = await gate.review(request);
  settings = { ...settings, revision: 2 };
  await expect(permit.assertCurrent?.()).rejects.toThrow("settings changed");
});

test("new human intent invalidates a permit through captured evidence", async () => {
  let humanVersion = 1;
  const gate = createHostExecutionGate({ settings: defaults, model: answer('{"decision":"allow","reason":"ok"}'),
    contextForRequest: async () => { const captured = humanVersion; return { evidence: "current intent", assertCurrent: async () => { if (captured !== humanVersion) throw new Error("Human intent changed"); } }; },
  });
  const permit = await gate.review(request);
  humanVersion++;
  await expect(permit.assertCurrent?.()).rejects.toThrow("Human intent changed");
});

test("oversized exact payload is rejected before a model request, never truncated", async () => {
  let calls = 0;
  const gate = createHostExecutionGate({ settings: defaults, contextForRequest: context, maxInputBytes: 10,
    model: { async *stream() { calls++; } },
  });
  await expect(gate.review(request)).rejects.toThrow("too large");
  expect(calls).toBe(0);
});

test("settings changing during an awaited freshness check invalidate the permit", async () => {
  let settings: ReviewSettings = { ...defaults(), profile: "full-access" };
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  const gate = createHostExecutionGate({ settings: () => settings, contextForRequest: context,
    model: answer('{"decision":"allow","reason":"ok"}'),
    assertRequestCurrent: async () => { entered(); await wait; },
  });
  const pending = gate.review(request);
  await started;
  settings = { ...settings, profile: "auto-review", revision: 1 };
  finish();
  await expect(pending).rejects.toThrow("settings changed");
});

test("changing the active model invalidates a permit that used the task model fallback", async () => {
  let selection = { provider: "fixture", model: "first" };
  const gate = createHostExecutionGate({ settings: defaults, contextForRequest: context,
    model: answer('{"decision":"allow","reason":"ok"}'), modelSelectionForRequest: async () => selection,
  });
  const permit = await gate.review(request);
  selection = { provider: "fixture", model: "second" };
  await expect(permit.assertCurrent?.()).rejects.toThrow("active reviewer model changed");
});
