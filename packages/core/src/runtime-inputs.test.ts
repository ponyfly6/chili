import { afterEach, expect, test } from "bun:test";
import type { MessageId, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { AgentRunner, RunTurnInput, RunTurnResult } from "./runner.js";
import { RuntimeService } from "./runtime-service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const sessionId = "durable_runtime" as SessionId;

async function fixture(run?: (input: RunTurnInput, index: number) => Promise<RunTurnResult>) {
  const store = new SqliteEventStore(":memory:");
  const turns: RunTurnInput[] = [];
  const runner: AgentRunner = {
    createSession: async () => sessionId,
    appendUserMessage: async () => { throw new Error("Durable promotion must be atomic in the store"); },
    runTurn: async (input) => {
      turns.push(input);
      return run ? run(input, turns.length) : completed(input);
    },
  };
  await store.append({ id: crypto.randomUUID(), type: "session.created", sessionId, time: Date.now() as TimestampMs, payload: { sessionId, cwd: "/repo" } });
  const service = new RuntimeService({ store, runtime: runner, cwd: "/repo" });
  cleanup.push(async () => { await service.shutdown(); await store.flushInputMirrors(); store.close(); });
  return { service, store, turns };
}

function completed(input: RunTurnInput): RunTurnResult {
  return { status: "completed", turnId: input.turnId ?? "turn" as TurnId, assistantMessageId: "answer" as MessageId, finishReason: "stop" };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await Bun.sleep(2); }
  throw new Error("Timed out waiting for input execution");
}
function waitForAbort(input: RunTurnInput): Promise<RunTurnResult> {
  return new Promise((resolve) => {
    const finish = () => resolve({ status: "cancelled", turnId: input.turnId!, error: new Error("stopped") });
    if (input.signal?.aborted) finish();
    else input.signal?.addEventListener("abort", finish, { once: true });
  });
}

test("admission commits before execution and retry never duplicates history", async () => {
  const { service, store, turns } = await fixture();
  const request = { sessionId, text: "build the report", submissionId: "one" };
  const receipt = service.submitPromptAsync(request);
  expect(store.sessionInput(sessionId, "one")?.payload).toContain("build the report");
  expect(turns).toHaveLength(0);
  expect(service.submitPromptAsync(request).input?.inputId).toBe(receipt.input!.inputId);
  expect(() => service.submitPromptAsync({ ...request, text: "different" })).toThrow("different input");
  await until(() => service.getInput(sessionId, "one")?.state === "settled");
  service.submitPromptAsync(request);
  expect(turns).toHaveLength(1);
  expect((await store.messages(sessionId)).filter((message) => message.role === "user")).toHaveLength(1);
});

test("Stop preserves pending work and Resume continues the original input before queued work", async () => {
  const { service, store, turns } = await fixture(async (input, index) => index === 1 ? waitForAbort(input) : completed(input));
  const first = service.submitPromptAsync({ sessionId, text: "first", submissionId: "first" });
  await until(() => turns.length === 1);
  service.submitPromptAsync({ sessionId, text: "next", submissionId: "next", mode: "queue" });
  await service.interrupt(sessionId);
  await until(() => !service.isRunning(sessionId));
  expect(service.inputQueue(sessionId)).toMatchObject({ paused: true, pendingCount: 1 });
  expect(turns).toHaveLength(1);
  expect((await store.messages(sessionId)).filter((message) => message.role === "user")).toHaveLength(1);
  service.submitPromptAsync({ sessionId, text: "next", submissionId: "next", mode: "queue" });
  expect(turns).toHaveLength(1);
  await service.resumeInputs(sessionId);
  await until(() => service.getInput(sessionId, "next")?.outcome === "completed");
  expect(turns).toHaveLength(3);
  expect(turns.map((turn) => turn.turnId)).toEqual([
    first.input!.turnId,
    service.getInput(sessionId, "first")!.turnId,
    service.getInput(sessionId, "next")!.turnId,
  ]);
  expect(turns[1]!.turnId).not.toBe(turns[0]!.turnId);
  expect(service.getInput(sessionId, "first")).toMatchObject({ inputId: first.input!.inputId, outcome: "completed" });
  expect((await store.messages(sessionId)).filter((message) => message.role === "user")).toHaveLength(2);
});

test("stale controls and synchronous queue requests cannot mutate admission", async () => {
  const { service, turns } = await fixture(waitForAbort);
  service.submitPromptAsync({ sessionId, text: "first", submissionId: "first" });
  await until(() => turns.length === 1);
  await expect(service.interrupt(sessionId, "stop", "obsolete")).rejects.toThrow("Execution changed");
  expect(service.inputQueue(sessionId).paused).toBe(false);
  await expect(service.submitPrompt({ sessionId, text: "invisible", submissionId: "bad", mode: "queue" })).rejects.toThrow("Synchronous prompts");
  expect(service.getInput(sessionId, "bad")).toBeUndefined();
});

test("steer interrupts the current turn and runs before pending FIFO inputs", async () => {
  const { service, store, turns } = await fixture(async (input, index) => index === 1 ? waitForAbort(input) : completed(input));
  service.submitPromptAsync({ sessionId, text: "first", submissionId: "first" });
  await until(() => turns.length === 1);
  service.submitPromptAsync({ sessionId, text: "later", submissionId: "later", mode: "queue" });
  service.submitPromptAsync({ sessionId, text: "correction", submissionId: "steer", mode: "steer", expectedExecutionRef: service.inputQueue(sessionId).executionRef! });
  await until(() => service.getInput(sessionId, "later")?.outcome === "completed");
  expect(service.inputQueue(sessionId).paused).toBe(false);
  const messages = await store.messages(sessionId);
  expect(messages.flatMap((message) => message.parts.flatMap((part) => part.type === "text" ? [part.text] : []))).toEqual(["first", "correction", "later"]);
});

test("a cancelled pending input is never resurrected by Resume", async () => {
  const { service, turns } = await fixture();
  await service.interrupt(sessionId);
  const accepted = service.submitPromptAsync({ sessionId, text: "do not do this", mode: "queue", submissionId: "cancelled" });
  service.cancelInput({ sessionId, inputId: accepted.input!.inputId, expectedRevision: accepted.input!.revision });
  await service.resumeInputs(sessionId);
  expect(service.inputQueue(sessionId).items).toHaveLength(0);
  expect(turns).toHaveLength(0);
});

test("a newer idle Stop invalidates an in-flight Resume even when already paused", async () => {
  const { service, store, turns } = await fixture();
  await service.interrupt(sessionId);
  service.submitPromptAsync({ sessionId, text: "pending", mode: "queue", submissionId: "pending" });
  const original = store.sessions.bind(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  store.sessions = async () => { await gate; return original(); };
  const resume = service.resumeInputs(sessionId);
  const stopped = service.interrupt(sessionId);
  release();
  await stopped;
  await expect(resume).rejects.toThrow("queue changed");
  expect(service.inputQueue(sessionId).paused).toBe(true);
  expect(turns).toHaveLength(0);
});

test("repeated recovery preserves original request and tool policy without replaying the original message", async () => {
  const { service, store, turns } = await fixture(async (input) => ({ status: "failed", turnId: input.turnId!, error: new Error("provider unavailable") }));
  const original = { sessionId, text: "Create my original report", toolPolicy: { allowedTools: ["read_file"] }, maxTurns: 1 };
  store.mutateSessionInputs({ kind: "accept", sessionId, inputId: "crashed", submissionId: "original", mode: "start", payload: JSON.stringify(original), text: original.text, source: "local" });
  store.mutateSessionInputs({ kind: "claim", sessionId, claimId: "dead", executionRef: "old", leaseDurationMs: 60_000 });
  store.releaseSessionRun({ sessionId, claimId: "dead" });
  await service.recoverInputs();
  expect(await store.messages(sessionId)).toHaveLength(0);
  for (let index = 1; index <= 2; index++) {
    await service.resumeInputs(sessionId);
    await until(() => turns.length === index && !service.isRunning(sessionId));
    expect(turns.at(-1)?.toolPolicy).toEqual(original.toolPolicy);
    expect(turns.at(-1)?.contextualUser?.join("\n")).toContain(original.text);
    expect(turns.at(-1)?.contextualUser?.join("\n")).toContain("Never blindly replay");
    expect(service.getInput(sessionId, "original")).toMatchObject({ inputId: "crashed", outcome: "failed" });
    expect(service.getInput(sessionId, "resume_crashed")).toBeUndefined();
    expect((await store.messages(sessionId)).filter((message) => message.id === "msg_input_crashed")).toHaveLength(1);
  }
});

test("a later failure remains recoverable when a newer Steer submission completed first", async () => {
  const { service, turns } = await fixture(async (input, index) => {
    if (index === 1) return waitForAbort(input);
    if (index === 3) return { status: "failed", turnId: input.turnId!, error: new Error("later queue failed") };
    return completed(input);
  });
  service.submitPromptAsync({ sessionId, text: "initial", submissionId: "initial" });
  await until(() => turns.length === 1);
  service.submitPromptAsync({ sessionId, text: "older queued task", submissionId: "older", mode: "queue" });
  service.submitPromptAsync({ sessionId, text: "newer steer", submissionId: "newer", mode: "steer" });
  await until(() => service.getInput(sessionId, "older")?.outcome === "failed");
  expect(service.inputQueue(sessionId).items).toContainEqual(expect.objectContaining({ submissionId: "older", outcome: "failed" }));
  await service.resumeInputs(sessionId);
  await until(() => turns.length === 4 && !service.isRunning(sessionId));
  expect(turns[3]!.contextualUser?.join("\n")).toContain("older queued task");
  expect(service.inputQueue(sessionId).items).toHaveLength(0);
});
