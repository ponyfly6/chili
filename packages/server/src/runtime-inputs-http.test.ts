import { afterEach, expect, test } from "bun:test";
import { RuntimeService, type AgentRunner, type RunTurnInput, type RunTurnResult } from "@chili/core";
import type { RuntimeCommandNode, SessionId, TimestampMs } from "@chili/protocol";
import { HttpRuntimeClient } from "@chili/sdk";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { createRuntimeHttpHandler, type RuntimeHttpHandlerOptions } from "./runtime-http.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const sessionId = "http_durable" as SessionId;
async function fixture(commands?: RuntimeHttpHandlerOptions["commands"]) {
  const sqlite = new SqliteEventStore(":memory:");
  const store = new ObservableEventStore(sqlite);
  const turns: RunTurnInput[] = [];
  const runner: AgentRunner = {
    createSession: async () => sessionId,
    appendUserMessage: async () => { throw new Error("Expected durable promotion"); },
    runTurn: async (input) => {
      turns.push(input);
      return new Promise<RunTurnResult>((resolve) => {
        const stopped = () => resolve({ status: "cancelled", turnId: input.turnId!, error: new Error("stopped") });
        if (input.signal?.aborted) stopped();
        else input.signal?.addEventListener("abort", stopped, { once: true });
      });
    },
  };
  const service = new RuntimeService({ runtime: runner, store, cwd: process.cwd() });
  await store.append({ type: "session.created", id: crypto.randomUUID(), sessionId, time: Date.now() as TimestampMs, payload: { sessionId, cwd: process.cwd() } });
  const handler = createRuntimeHttpHandler({ service, store, ...(commands ? { commands } : {}) });
  const client = new HttpRuntimeClient({ baseUrl: "http://test", fetch: ((input, init) => handler(new Request(input, init))) as typeof fetch });
  const post = (action: string, body: unknown) => handler(new Request(`http://test/sessions/${sessionId}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  cleanup.push(async () => { await service.shutdown(); await sqlite.flushInputMirrors(); sqlite.close(); });
  return { service, sqlite, client, post, turns };
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 500; index++) { if (predicate()) return; await Bun.sleep(2); }
  throw new Error("Runtime did not enter expected state");
}

test("HTTP acknowledges committed receipts, SDK retries deduplicate and changed content conflicts", async () => {
  const { client, sqlite } = await fixture();
  await client.interruptSession({ sessionId });
  const request = { sessionId, text: "saved before response", mode: "queue" as const, submissionId: "stable" };
  const receipt = await client.submitPromptAsync(request);
  expect(receipt.input?.state).toBe("pending");
  expect(sqlite.sessionInput(sessionId, "stable")?.payload).toContain(request.text);
  const retry = await client.submitPromptAsync(request);
  expect(retry.input?.inputId).toBe(receipt.input?.inputId);
  expect(await client.inputQueue({ sessionId })).toMatchObject({ paused: true, pendingCount: 1 });
  expect((await client.getInput({ sessionId, submissionId: "stable" }))?.inputId).toBe(receipt.input?.inputId);
  await expect(client.submitPromptAsync({ ...request, text: "changed" })).rejects.toMatchObject({ status: 409 });
});

test("invalid synchronous modes and submission IDs return 400 without accepting work", async () => {
  const { post, sqlite } = await fixture();
  expect((await post("prompt", { text: "no", mode: "queue", submissionId: "sync" })).status).toBe(400);
  expect((await post("prompt_async", { text: "no", submissionId: "has space" })).status).toBe(400);
  expect(sqlite.sessionInputQueue(sessionId).items).toHaveLength(0);
});

test("command retries return original accepted expansion and preserve command tool restrictions", async () => {
  let calls = 0;
  const command = { id: "prompt.review", path: "/review" } as RuntimeCommandNode;
  const { post, sqlite } = await fixture({
    list: async () => ({ roots: [], diagnostics: [] }),
    reload: async () => ({ roots: [], diagnostics: [] }),
    run: async () => ({ prompt: `expanded ${++calls}`, command, metadata: { commandId: "prompt.review", commandPath: "/review", source: "project", allowedTools: ["read_file"] } }),
  });
  const body = { commandId: "prompt.review", submissionId: "command-request", mode: "queue", args: "src" };
  expect((await post("command_async", body)).status).toBe(202);
  expect((await post("command_async", body)).status).toBe(202);
  expect(calls).toBe(1);
  expect(JSON.parse(sqlite.sessionInput(sessionId, "command-request")!.payload)).toMatchObject({ text: "expanded 1", toolPolicy: { allowedTools: ["read_file"] } });
  expect((await post("command_async", { ...body, args: "different" })).status).toBe(409);
  expect(calls).toBe(1);
});

test("HTTP Goal controls resume a stopped Goal and budget-limited resume remains explicit", async () => {
  const { client, service, turns } = await fixture();
  await client.interruptSession({ sessionId });
  await client.setGoal({ sessionId, objective: "finish", tokenBudget: 100 });
  await until(() => turns.length === 1);
  expect(service.inputQueue(sessionId).paused).toBe(false);
  await client.interruptSession({ sessionId });
  await until(() => !service.isRunning(sessionId));
  await client.updateGoal({ sessionId, status: "budgetLimited" });
  await expect(client.resumeInputs({ sessionId })).rejects.toMatchObject({ status: 409 });
  expect(service.inputQueue(sessionId).paused).toBe(true);
  await client.updateGoal({ sessionId, status: "active", tokenBudget: 200 });
  await until(() => turns.length === 2);
  expect(service.inputQueue(sessionId).paused).toBe(false);
});
