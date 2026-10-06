import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "../packages/core/src/index.js";
import { createChiliHost } from "../packages/host/src/index.js";
import type { Message, SessionId } from "../packages/protocol/src/index.js";
import { HttpRuntimeClient } from "../packages/sdk/src/index.js";
import { startRuntimeHttpServer } from "../packages/server/src/index.js";

const controls = ["agent_spawn", "agent_send", "agent_wait", "agent_stop", "agent_resume", "agent_list"];
const retired = /^(?:team_|task_|agent_tasks$|complete_task$|subagent$|agent_message$|agent_mailbox$)/;
const textOf = (message: Message | undefined) => message?.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
function requestText(text: string): string {
  if (!text.startsWith("Agent message:")) return text;
  const message = JSON.parse(text.slice(text.indexOf("\n") + 1));
  assert.equal(typeof message.sender.agentId, "string");
  assert.equal(typeof message.sender.name, "string");
  assert.equal(typeof message.sender.path, "string");
  assert.equal(typeof message.text, "string");
  return message.text;
}
const latestText = (input: ModelStreamInput) => requestText(textOf(input.messages.filter((message) => message.role === "user").at(-1)));

async function until(predicate: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    assert(Date.now() < deadline, `Timed out waiting for ${description}`);
    await Bun.sleep(5);
  }
}

async function fixture(limits: string) {
  const cwd = await mkdtemp(join(tmpdir(), "chili-smoke-agents-"));
  await mkdir(join(cwd, ".chili"));
  await writeFile(join(cwd, ".chili", "config.toml"), `[agents]\n${limits}\n`);
  return { cwd, chiliHome: join(cwd, "profile"), model: "fake" as const, mcpConnectMode: "manual" as const, staleTurnRecoveryIntervalMs: false as const };
}

async function open(options: Awaited<ReturnType<typeof fixture>>, modelRouter: ModelRouter) {
  const host = await createChiliHost({ ...options, modelRouter });
  const server = startRuntimeHttpServer({ service: host.service, store: host.store, agents: host.agents });
  return {
    host,
    url: server.url,
    client: new HttpRuntimeClient({ baseUrl: server.url }),
    async close() { await server.close(); await host.close(); },
  };
}

async function withWorkspace(limits: string, run: (options: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const options = await fixture(limits);
  let passed = false;
  try { await run(options); passed = true; }
  finally {
    if (passed && process.env.CHILI_SMOKE_KEEP_WORKSPACE !== "1") await rm(options.cwd, { recursive: true, force: true });
    else console.log(`[smoke:agents] retained workspace: ${options.cwd}`);
  }
}

await withWorkspace("max_children = 1\nmax_depth = 1\nmax_concurrent = 1", async (options) => {
  let hold = true;
  let began = false;
  const completed: string[] = [];
  const model: ModelRouter = { async *stream(input) {
    let prompt = latestText(input);
    const recovery = input.contextualUser?.find((text) => text.includes("Original request:"));
    if (recovery) {
      const original = /^Original request: (.+)$/mu.exec(recovery)?.[1];
      assert(original, "Resume must include the original request");
      assert.equal(requestText(JSON.parse(original)), "third", "Resume must carry the exact original request");
      assert(recovery.includes("Never blindly replay"), "Recovery warns about effects from interrupted operations");
      prompt = "third";
    }
    assert(input.tools.some((tool) => tool.name === "code_mode"), "Every Agent has Code Mode by default");
    assert(!input.tools.some((tool) => retired.test(tool.name)), "Retired controls must not be exposed");
    if (prompt === "third" && hold) {
      began = true;
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      input.signal?.throwIfAborted();
    }
    completed.push(prompt);
    yield { type: "text_delta", text: `answer:${prompt}` };
    yield { type: "finish", reason: "stop" };
  } };
  let runtime = await open(options, model);
  try {
    const sessionId = (await runtime.client.createSession()).sessionId;
    const first = await runtime.client.spawnAgent({ sessionId, name: "worker", prompt: "first" });
    const second = await runtime.client.sendAgent({ sessionId, agentId: first.agentId, text: "second" });
    assert.equal(second.agentId, first.agentId);
    assert.notEqual(first.inputId, second.inputId);
    let previousMessageId: string | undefined;
    for (const [receipt, expected] of [[first, "first"], [second, "second"]] as const) {
      const result = await runtime.client.waitAgent({ sessionId, ...receipt, timeoutMs: 5_000 });
      assert.equal(result.timedOut, false);
      assert.equal(result.input.inputId, receipt.inputId);
      assert.equal(result.input.outcome, "completed");
      assert.equal(textOf(result.result as Message), `answer:${expected}`);
      previousMessageId = (result.result as Message).id;
    }
    const third = await runtime.client.sendAgent({ sessionId, agentId: first.agentId, text: "third" });
    await until(() => began, "the third input to start");
    assert.equal((await runtime.client.waitAgent({ sessionId, ...third, timeoutMs: 0 })).timedOut, true);
    assert.equal((await runtime.client.listAgents({ sessionId })).find((agent) => agent.agentId === first.agentId)?.state, "running", "Wait timeout must not stop execution");
    await runtime.client.stopAgent({ sessionId, agentId: first.agentId });
    const fourth = await runtime.client.sendAgent({ sessionId, agentId: first.agentId, text: "fourth", mode: "queue" });
    assert.equal((await runtime.client.listAgents({ sessionId })).find((agent) => agent.agentId === first.agentId)?.state, "paused");
    await runtime.close();
    hold = false;
    runtime = await open(options, model);
    const paused = (await runtime.client.listAgents({ sessionId })).filter((agent) => agent.agentId !== sessionId);
    assert.equal(paused.length, 1);
    assert.equal(paused[0]?.agentId, first.agentId);
    assert.equal(paused[0]?.state, "paused", "Pause must survive Host reconstruction");
    assert.equal((await runtime.client.waitAgent({ sessionId, ...fourth, timeoutMs: 0 })).timedOut, true);
    const resumed = await runtime.client.resumeAgent({ sessionId, agentId: first.agentId });
    assert.equal(resumed.agentId, first.agentId);
    assert.equal(resumed.inputId, third.inputId, "Resume must preserve the interrupted input identity");
    for (const [receipt, expected] of [[third, "third"], [fourth, "fourth"]] as const) {
      const result = await runtime.client.waitAgent({ sessionId, ...receipt, timeoutMs: 5_000 });
      assert.equal(result.input.inputId, receipt.inputId);
      assert.equal(result.input.outcome, "completed");
      assert.equal(textOf(result.result as Message), `answer:${expected}`);
      assert.notEqual((result.result as Message).id, previousMessageId, "Each resumed input produces its own result message");
      previousMessageId = (result.result as Message).id;
    }
    assert.deepEqual(completed, ["first", "second", "third", "fourth"]);
    assert.equal((await runtime.host.store.childSessions(sessionId)).length, 1);
    await assert.rejects(runtime.client.spawnAgent({ sessionId, name: "extra", prompt: "over capacity" }), /child|limit|maximum/i);
    assert.equal((await runtime.client.listAgents({ sessionId })).find((agent) => agent.agentId === first.agentId)?.state, "idle");
    assert.deepEqual(await runtime.host.store.agentTasks({ parentSessionId: sessionId }), [], "New Agents do not create business Tasks");
    for (const path of ["teams", "teams/old/tasks", "teams/old/run_loop", "tasks", "tasks/old/followup", "tasks/reconcile_stale", "agents/tree", "agent_runs", "mailbox"]) {
      for (const method of ["GET", "POST"]) {
        assert.equal((await fetch(new URL(path, runtime.url), { method })).status, 404, `${method} ${path} must be retired`);
      }
    }
  } finally { await runtime.close(); }
});
console.log("[smoke:agents] HTTP/SDK receipts, pause/restart/resume, stable allowance and retired routes passed");

await withWorkspace("max_children = 1\nmax_depth = 2\nmax_concurrent = 1", async (options) => {
  const composed = new Set<SessionId>();
  const seen = new Set<string>();
  const model: ModelRouter = { async *stream(input): AsyncIterable<ModelStreamEvent> {
    const prompt = latestText(input);
    seen.add(prompt);
    assert(input.tools.some((tool) => tool.name === "code_mode"));
    if (!composed.has(input.sessionId)) {
      composed.add(input.sessionId);
      const child = prompt === "root" ? "middle" : "leaf";
      const code = prompt === "leaf"
        ? `let denied = false;
           try { await tools.agent_spawn({name:"too_deep",prompt:"forbidden"}); } catch { denied = true; }
           if (!denied) throw new Error("Depth limit was not enforced");
           text({denied});`
        : `const catalog = ALL_TOOLS.map(tool => tool.name);
           const receipt = (await tools.agent_spawn({name:${JSON.stringify(child)},prompt:${JSON.stringify(child)}})).structuredData;
           const answer = (await tools.agent_wait({...receipt,timeoutMs:5000})).structuredData;
           if (answer.timedOut || answer.input.outcome !== "completed") throw new Error("Nested input did not finish");
           text({catalog,answer});`;
      yield { type: "tool_call", name: "code_mode", input: { code } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: `done:${prompt}` };
    yield { type: "finish", reason: "stop" };
  } };
  const runtime = await open(options, model);
  try {
    const sessionId = (await runtime.client.createSession()).sessionId;
    assert.equal((await runtime.client.submitPrompt({ sessionId, text: "root" })).status, "completed");
    await runtime.host.waitForAgents();
    assert.deepEqual([...seen].sort(), ["leaf", "middle", "root"]);
    const agents = (await runtime.client.listAgents({ sessionId })).filter((agent) => agent.agentId !== sessionId);
    assert.equal(agents.length, 2);
    assert.equal(agents.find((agent) => agent.name === "leaf")?.parentAgentId, agents.find((agent) => agent.name === "middle")?.agentId);
    for (const id of [sessionId, ...agents.map((agent) => agent.agentId as SessionId)]) {
      const results = (await runtime.client.messages(id)).flatMap((message) => message.parts).filter((part) => part.type === "tool_result");
      assert.equal(results.length, 1);
      assert.equal(results[0]?.error, undefined, results[0]?.output);
      const output = JSON.parse(results[0]!.output);
      if (output.catalog) {
        for (const name of controls) assert(output.catalog.includes(name), `${name} is available inside Code Mode`);
        assert(!output.catalog.some((name: string) => retired.test(name)));
      } else assert.equal(output.denied, true);
    }
  } finally { await runtime.close(); }
});
console.log("[smoke:agents] Code Mode nesting, shared wait capacity and depth limit passed");

await withWorkspace("max_children = 2\nmax_depth = 1\nmax_concurrent = 1", async (options) => {
  let otherRoot: SessionId;
  const relayed = new Set<SessionId>();
  const model: ModelRouter = { async *stream(input): AsyncIterable<ModelStreamEvent> {
    const prompt = latestText(input);
    if (prompt === "relay" && !relayed.has(input.sessionId)) {
      relayed.add(input.sessionId);
      yield { type: "tool_call", name: "code_mode", input: { code: `
        const agents = (await tools.agent_list({})).structuredData.agents;
        if (agents.length !== 3) throw new Error("Expected root, peer and self");
        const peer = agents.find(agent => agent.name === "receiver");
        const root = agents.find(agent => !agent.parentAgentId);
        let denied = 0;
        try { await tools.agent_stop({agentId:peer.agentId}); } catch { denied++; }
        try { await tools.agent_send({agentId:${JSON.stringify(otherRoot)},text:"forbidden"}); } catch { denied++; }
        if (denied !== 2) throw new Error("Hierarchy control or root isolation was bypassed");
        const outcomes = [];
        for (const target of [peer, root]) {
          const receipt = (await tools.agent_send({agentId:target.agentId,text:"from-relay-to:"+target.name})).structuredData;
          const result = (await tools.agent_wait({...receipt,timeoutMs:5000})).structuredData;
          if (result.timedOut || result.input.outcome !== "completed") throw new Error("Peer/parent input did not finish");
          outcomes.push(result);
        }
        text({outcomes,denied});
      ` } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    if (prompt.startsWith("from-relay-to:")) {
      const raw = textOf(input.messages.filter((message) => message.role === "user").at(-1));
      const attributed = JSON.parse(raw.slice(raw.indexOf("\n") + 1));
      assert.equal(attributed.sender.name, "relay");
      assert.equal(attributed.sender.path, "/root/relay");
      assert.notEqual(attributed.sender.agentId, input.sessionId);
    }
    yield { type: "text_delta", text: `received:${prompt}` };
    yield { type: "finish", reason: "stop" };
  } };
  const runtime = await open(options, model);
  try {
    const sessionId = (await runtime.client.createSession()).sessionId;
    otherRoot = (await runtime.client.createSession()).sessionId;
    const receiver = await runtime.client.spawnAgent({ sessionId, name: "receiver", prompt: "ready" });
    assert.equal((await runtime.client.waitAgent({ sessionId, ...receiver, timeoutMs: 5_000 })).input.outcome, "completed");
    const relay = await runtime.client.spawnAgent({ sessionId, name: "relay", prompt: "relay" });
    assert.equal((await runtime.client.waitAgent({ sessionId, ...relay, timeoutMs: 5_000 })).input.outcome, "completed");
    const result = (await runtime.client.messages(relay.agentId as SessionId)).flatMap((message) => message.parts).find((part) => part.type === "tool_result");
    assert(result?.type === "tool_result");
    assert.equal(result.error, undefined, result.output);
    const output = JSON.parse(result.output);
    assert.equal(output.denied, 2);
    assert.deepEqual(output.outcomes.map((outcome: { result: Message }) => textOf(outcome.result)), ["received:from-relay-to:receiver", "received:from-relay-to:root"]);
    assert.equal((await runtime.client.messages(otherRoot)).length, 0);
  } finally { await runtime.close(); }
});
console.log("[smoke:agents] peer/parent messages, trusted sender and root isolation passed");

await withWorkspace("max_children = 3\nmax_depth = 1\nmax_concurrent = 2", async (options) => {
  let active = 0;
  let peak = 0;
  const release = new Map<string, () => void>();
  const model: ModelRouter = { async *stream(input) {
    const prompt = latestText(input);
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise<void>((resolve) => {
        release.set(prompt, resolve);
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      input.signal?.throwIfAborted();
      yield { type: "text_delta", text: `parallel:${prompt}` };
      yield { type: "finish", reason: "stop" };
    } finally { active--; }
  } };
  const runtime = await open(options, model);
  try {
    const sessionId = (await runtime.client.createSession()).sessionId;
    const receipts = await Promise.all(["one", "two", "three"].map((name) => runtime.client.spawnAgent({ sessionId, name, prompt: name })));
    assert.equal(new Set(receipts.map((receipt) => receipt.agentId)).size, 3);
    await until(() => release.size === 2, "two concurrent Agents");
    assert.equal(active, 2);
    for (const unblock of release.values()) unblock();
    await until(() => release.size === 3, "the queued Agent to start");
    for (const unblock of release.values()) unblock();
    for (const [index, receipt] of receipts.entries()) {
      const result = await runtime.client.waitAgent({ sessionId, ...receipt, timeoutMs: 5_000 });
      assert.equal(result.input.outcome, "completed");
      assert.equal(textOf(result.result as Message), `parallel:${["one", "two", "three"][index]}`);
    }
    assert.equal(peak, 2, "All child Agents must share the configured concurrency limit");
  } finally { for (const unblock of release.values()) unblock(); await runtime.close(); }
});
console.log("[smoke:agents] asynchronous creation and shared concurrency passed");
