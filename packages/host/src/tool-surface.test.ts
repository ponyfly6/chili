import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import { timestampNow, type AgentPath, type AgentRunId, type SessionId, type TaskId, type TeamId } from "@chili/protocol";
import { AGENT_CONTROL_TOOLS, DEFAULT_CODING_TOOLS, DeferredUserInputQueue } from "@chili/tools";
import { createChiliHost } from "./host.js";

test("interactive Host starts with 14 tools and recovers Goal, Agent and Team controls from durable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-host-tool-surface-"));
  const captured: ModelStreamInput[] = [];
  const model: ModelRouter = { async *stream(input): AsyncIterable<ModelStreamEvent> {
    captured.push(input);
    yield { type: "text_delta", text: "done" };
    yield { type: "finish", reason: "stop" };
  } };
  const host = await createChiliHost({ cwd: root, chiliHome: join(root, "profile"), model: "fake", modelRouter: model,
    userInputQueue: new DeferredUserInputQueue(), mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  try {
    const session = await host.service.createSession();
    await host.service.submitPrompt({ sessionId: session.sessionId, text: "Inspect the workspace." });
    expect(captured.at(-1)!.tools.map((tool) => tool.name).sort()).toEqual([...DEFAULT_CODING_TOOLS].sort());
    const now = timestampNow();
    await host.store.append({ id: "fixture-goal", type: "goal.updated", sessionId: session.sessionId, time: now,
      payload: { reason: "set", goal: { sessionId: session.sessionId, objective: "Inspect the repository", status: "paused",
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: now, updatedAt: now } } });
    await host.service.submitPrompt({ sessionId: session.sessionId, text: "Read the goal." });
    expect(captured.at(-1)!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["get_goal", "update_goal"]));
    const child = await host.service.createSession();
    await host.store.append({ id: "fixture-agent", type: "agent.task_created", sessionId: session.sessionId, time: now,
      payload: { taskId: "fixture-task" as TaskId, path: "/root/fixture" as AgentPath,
        parentPath: "/root" as AgentPath, parentSessionId: session.sessionId,
        childSessionId: child.sessionId, taskName: "fixture", cwd: root, prompt: "Inspect files" } });
    await host.store.append({ id: "fixture-team", type: "team.created", sessionId: session.sessionId, time: now,
      payload: { teamId: "fixture-team" as TeamId, name: "Fixture", leadPath: "/root" as AgentPath } });
    await host.service.submitPrompt({ sessionId: session.sessionId, text: "Inspect delegated work." });
    expect(captured.at(-1)!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "agent_wait", "agent_resume", "agent_stop", "agent_send", "team_snapshot", "team_task_list",
    ]));
    expect(await host.store.events({ sessionId: session.sessionId, type: "session.tools_loaded" })).toEqual([]);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test("Host exposes exactly six agent tools and composes their lifecycle through code mode without search", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-host-agent-tools-"));
  let rootSession: SessionId | undefined;
  let scripted = false;
  const childInputs: ModelStreamInput[] = [];
  const composedChildren = new Set<SessionId>();
  const captured: ModelStreamInput[] = [];
  const model: ModelRouter = { async *stream(input): AsyncIterable<ModelStreamEvent> {
    if (input.sessionId !== rootSession) {
      childInputs.push(input);
      expect(input.tools.map((tool) => tool.name)).toContain("code_mode");
      if (!composedChildren.has(input.sessionId)) {
        composedChildren.add(input.sessionId);
        yield { type: "tool_call", name: "code_mode", input: { code: 'text(ALL_TOOLS.map(tool => tool.name)); text(typeof tools.write);' } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text: "Inspected the requested files and confirmed the result." };
      yield { type: "finish", reason: "stop" };
      return;
    }
    captured.push(input);
    if (!scripted) {
      scripted = true;
      yield { type: "tool_call", name: "code_mode", input: { code: `
        text({catalog: ALL_TOOLS.filter(t => t.name.startsWith("agent_")).map(t => t.name).sort()});
        const spawned = (await tools.agent_spawn({description:"Inspect",prompt:"Inspect the files",mode:"resumable"})).structuredData;
        const taskId = spawned.task_id;
        await tools.agent_send({to:taskId,content:"Check the result again"});
        const messages = (await tools.agent_list({view:"messages",taskId})).structuredData;
        const waited = (await tools.agent_wait({taskId,timeoutMs:1000})).structuredData;
        const stopped = (await tools.agent_stop({taskId})).structuredData;
        const resumed = (await tools.agent_resume({taskId})).structuredData;
        const listed = (await tools.agent_list({taskIds:[taskId]})).structuredData;
        text({taskId,messages,waited,stopped,resumed,listed});
      ` } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "Inspected the agent result, resumed its review with the same history, and verified completion." };
    yield { type: "finish", reason: "stop" };
  } };
  const host = await createChiliHost({ cwd: root, chiliHome: join(root, "profile"), model: "fake", modelRouter: model,
    mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  try {
    rootSession = (await host.service.createSession()).sessionId;
    const result = await host.service.submitPrompt({ sessionId: rootSession, text: "Inspect files with an agent, then review its result." });
    expect(result.status).toBe("completed");
    expect(captured[0]!.tools.some((tool) => tool.name.startsWith("agent_"))).toBe(false);
    const parts = (await host.store.messages(rootSession)).flatMap((message) => message.parts);
    const scriptResult = parts.find((part) => part.type === "tool_result" && part.output.includes('"catalog"'));
    expect(scriptResult?.type).toBe("tool_result");
    if (scriptResult?.type !== "tool_result") throw new Error("Missing code-mode lifecycle result");
    expect(scriptResult.error).toBeUndefined();
    const [catalog, lifecycle] = scriptResult.output.trim().split("\n").map((line) => JSON.parse(line));
    expect(catalog.catalog).toEqual([...AGENT_CONTROL_TOOLS].sort());
    expect(lifecycle.messages.messages[0].content).toBe("Check the result again");
    expect(lifecycle.waited).toMatchObject({ satisfied: true, timedOut: false, count: 1 });
    expect(lifecycle.stopped.status).toBe("completed");
    expect(lifecycle.resumed).toMatchObject({ taskId: lifecycle.taskId, status: "completed" });
    expect(lifecycle.listed.tasks).toHaveLength(1);
    expect(childInputs).toHaveLength(3);
    expect(childInputs.at(-1)!.sessionId).toBe(childInputs[0]!.sessionId);
    expect(JSON.stringify(childInputs.at(-1)!.messages)).toContain("Inspect the files");
    expect(JSON.stringify(childInputs.at(-1)!.messages)).toContain("Continue the previous task");
    const childParts = (await host.store.messages(childInputs[0]!.sessionId)).flatMap((message) => message.parts);
    const childScript = childParts.find((part) => part.type === "tool_result" && part.output.includes("undefined"));
    expect(childScript).toMatchObject({ type: "tool_result" });
    if (childScript?.type !== "tool_result") throw new Error("Missing child code-mode result");
    expect(childScript.error).toBeUndefined();
    expect(childScript.output).toContain("read");
    expect(childScript.output).not.toContain('"write"');
    expect(await host.store.events({ sessionId: rootSession, type: "session.tools_loaded" })).toEqual([]);
    expect(captured.at(-1)!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([...AGENT_CONTROL_TOOLS]));
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test("a restarted Host gives legacy scoped workers code mode while nested tools retain their restrictions", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-child-code-mode-"));
  await writeFile(join(root, "note.txt"), "original");
  let requests = 0;
  const model: ModelRouter = { async *stream(input): AsyncIterable<ModelStreamEvent> {
    requests++;
    expect(input.tools.map((tool) => tool.name).sort()).toEqual(["code_mode", "read"]);
    if (requests === 1) {
      yield { type: "tool_call", name: "code_mode", input: { code: `
        const read = await tools.read({filePath:"note.txt"});
        let denied = false;
        try { await tools.write({filePath:"note.txt",content:"changed"}); } catch { denied = true; }
        text({content:read.structuredData.content,denied,catalog:ALL_TOOLS.map(t => t.name)});
      ` } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "Read the original note; the write was denied." };
    yield { type: "finish", reason: "stop" };
  } };
  const options = { cwd: root, chiliHome: join(root, "profile"), model: "fake" as const, modelRouter: model,
    mcpConnectMode: "manual" as const, staleTurnRecoveryIntervalMs: false as const };
  let host = await createChiliHost(options);
  try {
    const parent = (await host.service.createSession()).sessionId;
    const child = (await host.service.createSession()).sessionId;
    const taskId = "legacy-worker" as TaskId;
    const runId = "legacy-run" as AgentRunId;
    const path = "/root/legacy-worker" as AgentPath;
    const time = timestampNow();
    const workerPolicy = { allowedTools: ["read", "write"], writeScope: [], executeScope: [] };
    const identity = { taskId, path, parentPath: "/root" as AgentPath, parentSessionId: parent,
      childSessionId: child, taskName: "legacy-worker", cwd: root, mode: "resumable" as const, workerPolicy };
    await host.store.appendMany([
      { id: "legacy-created", type: "agent.task_created", sessionId: parent, time,
        payload: { ...identity, prompt: "Read the note" } },
      { id: "legacy-spawned", type: "agent.spawned", sessionId: parent, time,
        payload: { ...identity, runId } },
      { id: "legacy-completed", type: "agent.completed", sessionId: parent, time,
        payload: { taskId, runId, path, status: "completed", summary: "Previous work" } },
    ]);
    await host.close();
    host = await createChiliHost(options);
    const result = await host.tasks.followupTask({ taskId, text: "Read the note with code mode." });
    expect(result.task.status).toBe("completed");
    expect(requests).toBe(2);
    const parts = (await host.store.messages(child)).flatMap((message) => message.parts);
    const script = parts.find((part) => part.type === "tool_result" && part.output.includes('"catalog"'));
    if (script?.type !== "tool_result") throw new Error("Missing scoped child code-mode result");
    expect(script.error).toBeUndefined();
    expect(JSON.parse(script.output)).toEqual({ content: "original", denied: true, catalog: ["read"] });
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("original");
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
