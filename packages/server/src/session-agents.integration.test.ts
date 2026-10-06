import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentControlService, RuntimeService, type AgentRunner } from "@chili/core";
import type { Message, MessageId, PartId, SessionId, TimestampMs } from "@chili/protocol";
import { HttpRuntimeClient } from "@chili/sdk";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { createRuntimeHttpHandler } from "./runtime-http.js";

test("HTTP Agent API uses real session receipts and lists the root separately from its children", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chili-http-agents-"));
  const store = new SqliteEventStore(":memory:");
  const rootId = "http_agent_root" as SessionId;
  const otherRootId = "http_other_root" as SessionId;
  const runner: AgentRunner = {
    createSession: async () => { throw new Error("Agent creation must use the persistent controller"); },
    appendUserMessage: async () => { throw new Error("Agent messages must use the session input queue"); },
    async runTurn(input) {
      const messageId = `answer_${crypto.randomUUID()}` as MessageId;
      const turnId = input.turnId!;
      const time = Date.now() as TimestampMs;
      await store.appendMany([
        { id: crypto.randomUUID(), type: "message.created", sessionId: input.sessionId, time,
          payload: { messageId, turnId, role: "assistant" } },
        { id: crypto.randomUUID(), type: "message.part_added", sessionId: input.sessionId, time,
          payload: { messageId, part: { id: crypto.randomUUID() as PartId, messageId,
            sessionId: input.sessionId, type: "text", text: `answer for ${input.sessionId}`, phase: "final_answer" } } },
      ]);
      return { status: "completed", turnId, assistantMessageId: messageId, finishReason: "stop" };
    },
  };
  const rootRuntime = new RuntimeService({ store, runtime: runner, cwd });
  const childRuntime = new RuntimeService({ store, runtime: runner, cwd, sessionAccess: "child" });
  const agents = new AgentControlService({ store, runtime: childRuntime, rootRuntime });
  try {
    for (const sessionId of [rootId, otherRootId]) {
      await store.append({ id: crypto.randomUUID(), type: "session.created", sessionId,
        time: Date.now() as TimestampMs, payload: { sessionId, cwd } });
    }
    const handler = createRuntimeHttpHandler({ service: rootRuntime, store: new ObservableEventStore(store), agents });
    const client = new HttpRuntimeClient({ baseUrl: "http://chili.test",
      fetch: ((input, init) => handler(new Request(input, init))) as typeof fetch });

    expect(await client.listAgents({ sessionId: rootId })).toEqual([
      { agentId: rootId, name: "root", path: "/root", state: "idle" },
    ]);
    const first = await client.spawnAgent({ sessionId: rootId, name: "first", prompt: "first job" });
    const second = await client.spawnAgent({ sessionId: rootId, name: "second", prompt: "second job" });
    await childRuntime.waitForIdle();
    const records = await client.listAgents({ sessionId: rootId });
    expect(records.filter((record) => record.agentId === rootId)).toHaveLength(1);
    expect(records.filter((record) => record.agentId !== rootId)).toHaveLength(2);
    expect(records.find((record) => record.agentId === first.agentId)?.parentAgentId).toBe(rootId);

    const followup = await client.sendAgent({ sessionId: rootId, agentId: first.agentId, text: "followup" });
    await childRuntime.waitForIdle();
    const original = await client.waitAgent({ sessionId: rootId, ...first, timeoutMs: 0 });
    const latest = await client.waitAgent({ sessionId: rootId, ...followup, timeoutMs: 0 });
    expect(original.input.inputId).toBe(first.inputId);
    expect(original.input.outcome).toBe("completed");
    expect(latest.input.inputId).toBe(followup.inputId);
    expect(original.input.resultMessageId).not.toBe(latest.input.resultMessageId);
    expect((latest.result as Message).parts[0]).toMatchObject({ text: `answer for ${first.agentId}` });

    const rootReceipt = await client.sendAgent({ sessionId: rootId, agentId: rootId, text: "message to root" });
    await rootRuntime.waitForIdle();
    const rootResult = await client.waitAgent({ sessionId: rootId, ...rootReceipt, timeoutMs: 0 });
    expect(rootResult.input.sessionId).toBe(rootId);
    expect(rootResult.input.outcome).toBe("completed");
    expect((rootResult.result as Message).parts[0]).toMatchObject({ text: `answer for ${rootId}` });

    await expect(client.sendAgent({ sessionId: otherRootId, agentId: first.agentId, text: "cross root" })).rejects.toMatchObject({ status: 403 });
    await expect(client.waitAgent({ sessionId: otherRootId, ...first, timeoutMs: 0 })).rejects.toMatchObject({ status: 403 });
    await expect(client.listAgents({ sessionId: first.agentId as SessionId })).rejects.toMatchObject({ status: 403 });
    await expect(client.submitPromptAsync({ sessionId: first.agentId as SessionId, text: "bypass Agent admission" })).rejects.toMatchObject({ status: 403 });
    await expect(client.interruptSession({ sessionId: first.agentId as SessionId })).rejects.toMatchObject({ status: 403 });
    await expect(client.stopAgent({ sessionId: rootId, agentId: rootId })).rejects.toMatchObject({ status: 403 });
    await client.stopAgent({ sessionId: rootId, agentId: second.agentId });
    expect((await client.listAgents({ sessionId: rootId })).find((record) => record.agentId === second.agentId)?.state).toBe("paused");
    await client.resumeAgent({ sessionId: rootId, agentId: second.agentId });
    expect((await client.listAgents({ sessionId: rootId })).find((record) => record.agentId === second.agentId)?.state).toBe("idle");
  } finally {
    await childRuntime.shutdown();
    await rootRuntime.shutdown();
    await store.flushInputMirrors();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
