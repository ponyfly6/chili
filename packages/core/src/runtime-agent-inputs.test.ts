import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageId, PartId, PersistedToolPolicy, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { AgentRunner, RunTurnInput, RunTurnResult } from "./runner.js";
import { AgentControlService } from "./agent-control.js";
import { RuntimeService, type RuntimeServiceOptions, type RuntimeSessionOperation } from "./runtime-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const rootId = "root_input_owner" as SessionId;
const childId = "child_input_owner" as SessionId;

async function fixture(options: {
  policy?: PersistedToolPolicy;
  runInput?: RuntimeServiceOptions["runInput"];
  run?: (input: RunTurnInput, index: number, store: SqliteEventStore) => Promise<RunTurnResult>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chili-runtime-agent-inputs-"));
  const database = join(directory, "events.sqlite");
  let store = new SqliteEventStore(database);
  const turns: RunTurnInput[] = [];
  const runner: AgentRunner = {
    createSession: async () => { throw new Error("Agent creation must be atomic in the store"); },
    appendUserMessage: async () => { throw new Error("Input promotion must use the durable queue"); },
    runTurn: async (input) => {
      turns.push(input);
      return options.run ? options.run(input, turns.length, store) : complete(store, input);
    },
  };
  await store.append({ id: crypto.randomUUID(), type: "session.created", sessionId: rootId,
    time: Date.now() as TimestampMs, payload: { sessionId: rootId, cwd: directory } });
  const root = new RuntimeService({ store, runtime: runner, cwd: directory });
  await root.withSessionOperation(rootId, async (operation) => {
    await store.createChildSession({
      sessionId: childId, parentSessionId: rootId, name: "worker", cwd: directory,
      policy: options.policy ?? {}, runClaim: operation.runClaim!,
      initialInput: { inputId: "initial_input", submissionId: "initial", mode: "queue",
        payload: JSON.stringify({ sessionId: childId, text: "Inspect the implementation" }),
        text: "Inspect the implementation", source: "agent", identity: "initial" },
    });
  });
  const create = () => new RuntimeService({ store, runtime: runner, cwd: directory, sessionAccess: "child",
    ...(options.runInput ? { runInput: options.runInput } : {}) });
  let service = create();
  cleanups.push(async () => { await service.shutdown(); await root.shutdown(); await store.flushInputMirrors(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get store() { return store; },
    get service() { return service; },
    root, turns,
    start: () => service.submitPromptAsync({ sessionId: childId, text: "Inspect the implementation",
      submissionId: "initial", mode: "queue", inputSource: "agent", requestIdentity: "initial" }),
    restart: async () => { await service.shutdown(); await store.flushInputMirrors(); store.close(); store = new SqliteEventStore(database); service = create(); },
  };
}

async function complete(store: SqliteEventStore, input: RunTurnInput, text = "I will inspect this next."): Promise<RunTurnResult> {
  const messageId = `answer_${crypto.randomUUID()}` as MessageId;
  const turnId = input.turnId ?? `turn_${crypto.randomUUID()}` as TurnId;
  const time = Date.now() as TimestampMs;
  await store.appendMany([
    { id: crypto.randomUUID(), type: "message.created", sessionId: input.sessionId, time,
      payload: { messageId, turnId, role: "assistant" } },
    { id: crypto.randomUUID(), type: "message.part_added", sessionId: input.sessionId, time,
      payload: { messageId, part: { id: crypto.randomUUID() as PartId, messageId, sessionId: input.sessionId, type: "text", text, phase: "final_answer" } } },
  ]);
  return { status: "completed", turnId, assistantMessageId: messageId, finishReason: "stop" };
}

async function until(predicate: () => boolean) {
  for (let index = 0; index < 500; index++) { if (predicate()) return; await Bun.sleep(2); }
  throw new Error("Timed out waiting for Agent input");
}

function aborted(input: RunTurnInput): Promise<RunTurnResult> {
  return new Promise((resolve) => {
    const finish = () => resolve({ status: "cancelled", turnId: input.turnId!, error: new Error("stopped") });
    if (input.signal?.aborted) finish();
    else input.signal?.addEventListener("abort", finish, { once: true });
  });
}

test("initial and later Agent inputs share admission, execution hook and durable final result", async () => {
  const wrapped: SessionId[] = [];
  const f = await fixture({ runInput: async (sessionId, _signal, run) => { wrapped.push(sessionId); return run(); } });
  expect(() => f.root.submitPromptAsync({ sessionId: childId, text: "Bypass child authority" })).toThrow();
  expect(() => f.service.requireActiveSessionOperation(childId)).toThrow();
  const receipt = f.start();
  f.start();
  expect(receipt.input?.inputId).toBe("initial_input");
  await f.service.waitForIdle();
  const initial = f.service.getInput(childId, "initial")!;
  expect(initial.outcome).toBe("completed");
  expect(initial.resultMessageId).toBeDefined();
  expect(initial).not.toHaveProperty("resumed");
  expect(f.turns).toHaveLength(1); // Natural final responses do not trigger Task completion repairs.
  f.service.submitPromptAsync({ sessionId: childId, text: "Inspect one more file", submissionId: "later", mode: "queue" });
  await f.service.waitForIdle();
  const later = f.service.getInput(childId, "later")!;
  expect(later.outcome).toBe("completed");
  expect(later.resultMessageId).not.toBe(initial.resultMessageId);
  expect(wrapped).toEqual([childId, childId]);
  expect((await f.store.messages(childId)).filter((message) => message.role === "user")).toHaveLength(2);
});

test("root and child runtimes admit only their persisted identity class", async () => {
  const f = await fixture();
  await expect(f.root.assertSessionTurnAllowed(childId)).rejects.toThrow();
  await expect(f.service.assertSessionTurnAllowed(rootId)).rejects.toThrow();
  await expect(f.root.assertSessionReadAllowed(childId)).rejects.toThrow();
  await expect(f.service.assertSessionReadAllowed(rootId)).rejects.toThrow();
  expect(() => f.root.submitPromptAsync({ sessionId: childId, text: "wrong runtime" })).toThrow();
  expect(() => f.service.submitPromptAsync({ sessionId: rootId, text: "wrong runtime" })).toThrow();
  await expect(f.root.interrupt(childId)).rejects.toThrow();
  await expect(f.service.interrupt(rootId)).rejects.toThrow();
  await expect(f.service.createSession({ sessionId: "unparented_child" as SessionId })).rejects.toThrow("atomically");
  expect((await f.store.sessions()).map((session) => session.id).sort()).toEqual([rootId, childId].sort());
  expect(f.turns).toHaveLength(0);
});

test("Stop survives restart and Resume reuses the interrupted input and conversation", async () => {
  const f = await fixture({ run: (input, index, store) => index === 1 ? aborted(input) : complete(store, input) });
  f.start();
  await until(() => f.turns.length === 1);
  await f.service.interrupt(childId);
  await f.service.waitForIdle();
  const initial = f.service.getInput(childId, "initial")!;
  expect(initial.outcome).toBe("cancelled");
  expect(f.service.inputQueue(childId).paused).toBe(true);
  await f.restart();
  await f.service.recoverInputs();
  expect(f.service.inputQueue(childId).paused).toBe(true);
  expect(f.turns).toHaveLength(1);
  await f.service.resumeInputs(childId);
  await f.service.waitForIdle();
  expect(f.service.getInput(childId, "initial")).toMatchObject({ inputId: initial.inputId, outcome: "completed" });
  expect(f.service.getInput(childId, `resume_${initial.inputId}`)).toBeUndefined();
  expect(f.turns[1]?.contextualUser?.join("\n")).toContain("Never blindly replay");
  expect((await f.store.messages(childId)).filter((message) => message.role === "user")).toHaveLength(1);
});

test("restart recovery pauses an orphaned child claim without dispatch and keeps its input identity", async () => {
  const f = await fixture();
  const trusted = { sessionAccess: "child" as const };
  f.store.mutateSessionInputs({ kind: "claim", sessionId: childId, claimId: "lost_child_owner",
    executionRef: "lost_execution", leaseDurationMs: 60_000 }, trusted);
  f.store.mutateSessionInputs({ kind: "promote", sessionId: childId, inputId: "initial_input", claimId: "lost_child_owner", text: "Inspect the implementation" }, trusted);
  f.store.releaseSessionRun({ sessionId: childId, claimId: "lost_child_owner" });
  await f.service.recoverInputs();
  expect(f.service.inputQueue(childId).paused).toBe(true);
  expect(f.service.getInput(childId, "initial")?.outcome).toBe("interrupted");
  expect(f.turns).toHaveLength(0);
  await f.service.resumeInputs(childId);
  await f.service.waitForIdle();
  expect(f.service.getInput(childId, "initial")).toMatchObject({ inputId: "initial_input", outcome: "completed" });
  expect((await f.store.messages(childId)).filter((message) => message.role === "user")).toHaveLength(1);
});

test("persisted Agent policy cannot be widened by a later request, including after restart", async () => {
  const f = await fixture({ policy: { allowedTools: ["read", "write", "code_mode"], deniedTools: ["bash"], writeScope: ["src"], executeScope: [] } });
  f.start();
  await f.service.waitForIdle();
  await f.restart();
  f.service.submitPromptAsync({ sessionId: childId, text: "Try broader permissions", submissionId: "broad", mode: "queue",
    toolPolicy: { allowedTools: ["*"], deniedTools: ["write"], writeScope: ["*"], executeScope: ["*"] } });
  await f.service.waitForIdle();
  expect(f.turns.at(-1)?.toolPolicy).toMatchObject({
    allowedTools: ["read", "write", "code_mode"], deniedTools: ["bash", "write"], executeScope: [],
  });
  expect(f.turns.at(-1)?.toolPolicy?.writeScope).toEqual(["src"]);
});

test("tool allowlists do not invent resource scopes when neither policy supplied them", async () => {
  const f = await fixture({ policy: { allowedTools: ["read", "write", "code_mode"] } });
  f.start();
  await f.service.waitForIdle();
  f.service.submitPromptAsync({ sessionId: childId, text: "Write the result", submissionId: "write", mode: "queue",
    toolPolicy: { allowedTools: ["write", "code_mode"] } });
  await f.service.waitForIdle();
  expect(f.turns.at(-1)?.toolPolicy).toEqual({ allowedTools: ["write", "code_mode"] });
});

test("queued permit cancellation settles the accepted input before any model execution", async () => {
  const f = await fixture({ runInput: async (_sessionId, signal) => new Promise((_resolve, reject) => {
    const stop = () => reject(Object.assign(new Error("permit cancelled"), { name: "AbortError" }));
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  }) });
  f.start();
  await f.service.interrupt(childId);
  await f.service.waitForIdle();
  expect(f.turns).toHaveLength(0);
  expect(f.service.getInput(childId, "initial")).toMatchObject({ outcome: "cancelled" });
  expect(f.service.inputQueue(childId).paused).toBe(true);
});

test("trusted local control can join a busy Agent without granting authority to an unrelated tool context", async () => {
  const f = await fixture({ run: (input) => aborted(input) });
  f.start();
  await until(() => f.turns.length === 1);
  const originalClaim = f.store.sessionRunClaim(childId)!.claimId;
  expect(() => f.service.requireActiveSessionOperation(childId)).toThrow();
  let operation!: RuntimeSessionOperation;
  await f.service.withSessionControl(childId, async (current) => {
    operation = current;
    expect(f.service.requireActiveSessionOperation(childId)).toBe(current);
    expect(() => f.service.requireActiveSessionOperation(rootId)).toThrow();
    expect(current.runClaim?.claimId).toBe(originalClaim);
    await Promise.resolve();
    expect(f.service.requireActiveSessionOperation(childId)).toBe(current);
  });
  expect(() => f.service.requireActiveSessionOperation(childId)).toThrow();
  expect(f.store.sessionRunClaim(childId)?.claimId).toBe(originalClaim);

  const peer = new RuntimeService({ store: f.store, runtime: {} as AgentRunner,
    cwd: "/unused", sessionAccess: "child" });
  try {
    expect(() => peer.withSessionControl(childId, () => undefined)).toThrow();
    expect(() => peer.requireActiveSessionOperation(childId)).toThrow();
  } finally {
    await peer.shutdown();
  }
  await f.service.interrupt(childId);
  await f.service.waitForIdle();
  expect(() => operation.assertCurrent()).toThrow();
});

test("failed external spawn drains under the root claim without failing the root response", async () => {
  let releaseModel!: () => void;
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
  let modelFinished = false;
  const f = await fixture({ run: async (input, _index, store) => {
    await modelGate;
    const result = await complete(store, input, "root complete");
    modelFinished = true;
    return result;
  } });
  f.root.submitPromptAsync({ sessionId: rootId, text: "Continue root work", submissionId: "root_work" });
  await until(() => f.turns.length === 1);
  let releaseControl!: () => void;
  const controlGate = new Promise<void>((resolve) => { releaseControl = resolve; });
  cleanups.push(async () => { releaseModel(); releaseControl(); });
  let controlEntered = false;
  const agents = new AgentControlService({ store: f.store, runtime: f.service, rootRuntime: f.root, maxChildren: 1,
    resolvePolicy: async () => { controlEntered = true; await controlGate; return undefined; } });
  const control = agents.forSession(rootId).spawnAgent({ name: "over_limit", prompt: "Extra work" });
  const rejected = control.then(() => undefined, (error: unknown) => error);
  await until(() => controlEntered);
  releaseModel();
  await until(() => modelFinished);
  expect(f.store.sessionInput(rootId, "root_work")).toMatchObject({ state: "claimed" });
  expect(f.store.sessionRunClaim(rootId)).toBeDefined();
  releaseControl();
  expect(await rejected).toBeInstanceOf(Error);
  await f.root.waitForIdle();
  expect(f.root.getInput(rootId, "root_work")).toMatchObject({ outcome: "completed" });
  expect(await f.store.childSessions(rootId)).toHaveLength(1);
});

test("root recovery leaves child queues to their trusted runtime", async () => {
  const f = await fixture();
  await f.root.recoverInputs();
  expect(f.service.getInput(childId, "initial")?.state).toBe("pending");
  expect(f.service.inputQueue(childId).paused).toBe(false);
  await f.service.recoverInputs();
  expect(f.service.inputQueue(childId).paused).toBe(true);
  expect(f.service.getInput(childId, "initial")?.state).toBe("pending");
});

test("periodic recovery does not pause fresh accepted work before dispatch", async () => {
  const f = await fixture();
  await f.service.recoverInputs({ includePending: false });
  expect(f.service.inputQueue(childId)).toMatchObject({ paused: false, pendingCount: 1 });
  f.start();
  await f.service.waitForIdle();
  expect(f.service.getInput(childId, "initial")?.outcome).toBe("completed");
});
