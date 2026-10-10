import { afterEach, expect, test } from "bun:test";
import type { MessageId, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { AgentRunner, RunTurnInput, RunTurnResult } from "./runner.js";
import { RuntimeService } from "./runtime-service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const sessionId = "followups" as SessionId;
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await Bun.sleep(2); }
  throw new Error("Follow-up did not advance");
}
function completed(turnId: TurnId, tools = false): RunTurnResult {
  return { status: "completed", turnId, assistantMessageId: "unused" as MessageId, finishReason: tools ? "tool_use" : "stop" };
}
async function fixture(run: (input: RunTurnInput, index: number) => Promise<RunTurnResult>) {
  const store = new SqliteEventStore(":memory:");
  await store.append({ id: "created", type: "session.created", sessionId, time: Date.now() as TimestampMs, payload: { sessionId, cwd: "/repo" } });
  let count = 0;
  const runner: AgentRunner = { createSession: async () => sessionId, appendUserMessage: async () => { throw new Error("Expected durable promotion"); },
    runTurn: (input) => run(input, ++count) };
  const service = new RuntimeService({ store, runtime: runner, cwd: "/repo" });
  cleanup.push(async () => { await service.shutdown(); await store.flushInputMirrors(); store.close(); });
  return { store, service, count: () => count };
}

test("supplements are saved immediately, read in order at the next request, and never abort active tools", async () => {
  const tools = gate();
  const requests: string[][] = [];
  const f = await fixture(async (input, index) => {
    const turnId = input.turnId ?? `turn_${index}` as TurnId;
    input.beforeModelRequest?.(turnId);
    input.onModelRequestPrepared?.();
    requests.push((await f.store.messages(sessionId)).filter((message) => message.role === "user")
      .flatMap((message) => message.parts.flatMap((part) => part.type === "text" ? [part.text] : [])));
    if (index === 1) { await tools.promise; expect(input.signal?.aborted).toBe(false); }
    return completed(turnId, index === 1);
  });
  f.service.submitPromptAsync({ sessionId, text: "Build the app", submissionId: "original", mode: "followup" });
  await until(() => requests.length === 1);
  const one = f.service.submitPromptAsync({ sessionId, text: "Use Chinese", submissionId: "one", mode: "followup" });
  f.service.submitPromptAsync({ sessionId, text: "Keep keyboard access", submissionId: "two", mode: "followup" });
  expect(one.input).toMatchObject({ state: "pending" });
  expect(one.input?.readAt).toBeUndefined();
  expect(f.count()).toBe(1);
  tools.resolve();
  await f.service.waitForIdle();
  expect(requests).toEqual([["Build the app"], ["Build the app", "Use Chinese", "Keep keyboard access"]]);
  for (const id of ["original", "one", "two"]) {
    expect(f.service.getInput(sessionId, id)).toMatchObject({ state: "settled", outcome: "completed", readAt: expect.any(Number) });
  }
  expect(f.service.getInput(sessionId, "one")?.parentInputId).toBe(f.service.getInput(sessionId, "original")?.inputId);
});

test("a supplement arriving during a final response still gets a next model request", async () => {
  const response = gate();
  const f = await fixture(async (input, index) => {
    const turnId = input.turnId ?? `turn_${index}` as TurnId;
    input.beforeModelRequest?.(turnId); input.onModelRequestPrepared?.();
    if (index === 1) await response.promise;
    return completed(turnId);
  });
  f.service.submitPromptAsync({ sessionId, text: "Work", submissionId: "original" });
  await until(() => f.count() === 1);
  f.service.submitPromptAsync({ sessionId, text: "One more detail", submissionId: "extra", mode: "followup" });
  response.resolve(); await f.service.waitForIdle();
  expect(f.count()).toBe(2);
  expect(f.service.getInput(sessionId, "extra")?.outcome).toBe("completed");
});

test("sending after Stop resumes the original work with supplements before the first resumed request", async () => {
  const seen: string[][] = [];
  const f = await fixture(async (input, index) => {
    const turnId = input.turnId ?? `turn_${index}` as TurnId;
    input.beforeModelRequest?.(turnId); input.onModelRequestPrepared?.();
    seen.push((await f.store.messages(sessionId)).filter((m) => m.role === "user").map((m) => m.id));
    if (index === 1) return new Promise((resolve) => input.signal!.addEventListener("abort", () => resolve({ status: "cancelled", turnId, error: new Error("Stopped") }), { once: true }));
    return completed(turnId);
  });
  const original = f.service.submitPromptAsync({ sessionId, text: "Original work", submissionId: "original", mode: "followup" });
  await until(() => seen.length === 1);
  await f.service.interrupt(sessionId); await f.service.waitForIdle();
  expect(f.service.inputQueue(sessionId).paused).toBe(true);
  f.service.submitPromptAsync({ sessionId, text: "Continue with this correction", submissionId: "extra", mode: "followup" });
  await f.service.waitForIdle();
  expect(seen[1]).toHaveLength(2);
  expect(f.service.getInput(sessionId, "original")?.inputId).toBe(original.input?.inputId);
  expect(f.service.getInput(sessionId, "extra")?.parentInputId).toBe(original.input?.inputId);
  await f.service.interrupt(sessionId);
  f.service.submitPromptAsync({ sessionId, text: "Continue with this correction", submissionId: "extra", mode: "followup" });
  expect(f.service.inputQueue(sessionId).paused).toBe(true);
  expect(f.count()).toBe(2);
});

test("withdrawal wins only before intake; a saved receipt is not a read receipt", async () => {
  const boundary = gate();
  const f = await fixture(async (input, index) => {
    if (index === 1) await boundary.promise;
    const turnId = input.turnId ?? `turn_${index}` as TurnId;
    input.beforeModelRequest?.(turnId); input.onModelRequestPrepared?.();
    return completed(turnId);
  });
  f.service.submitPromptAsync({ sessionId, text: "Work", submissionId: "original" });
  await until(() => f.count() === 1);
  const extra = f.service.submitPromptAsync({ sessionId, text: "Withdraw me", submissionId: "extra", mode: "followup" }).input!;
  f.service.cancelInput({ sessionId, inputId: extra.inputId, expectedRevision: extra.revision });
  boundary.resolve(); await f.service.waitForIdle();
  expect(f.service.getInput(sessionId, "extra")).toMatchObject({ outcome: "cancelled" });
  expect(f.service.getInput(sessionId, "extra")?.readAt).toBeUndefined();
  expect((await f.store.messages(sessionId)).filter((m) => m.role === "user")).toHaveLength(1);
  expect(() => f.service.cancelInput({ sessionId, inputId: extra.inputId, expectedRevision: extra.revision })).toThrow();
});
