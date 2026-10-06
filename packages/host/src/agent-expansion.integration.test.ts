import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput, WorkerToolPolicy } from "@chili/core";
import { timestampNow, type AgentPath, type AgentRunId, type SessionId, type TaskId } from "@chili/protocol";
import { createChiliHost, type ChiliHost } from "./host.js";

const findings = "Inspected the requested scope and verified the findings. The relevant files are consistent, and all delegated results have been reviewed.";

test("Host completes three nested levels and fourteen agents with one execution slot", async () => {
  const root = await configuredWorkspace("max_children = 2\nmax_depth = 3\nmax_concurrent = 1");
  let rootSession: SessionId | undefined;
  const started = new Set<SessionId>();
  const leaves = new Set<SessionId>();
  const model: ModelRouter = { async *stream(input): AsyncIterable<ModelStreamEvent> {
    if (input.sessionId === rootSession) {
      if (!started.has(input.sessionId)) {
        started.add(input.sessionId);
        yield { type: "tool_call", name: "code_mode", input: { code: `
          text((await tools.agent_spawn({tasks:[
            {description:"First branch",prompt:"level:1 Review the first branch."},
            {description:"Second branch",prompt:"level:1 Review the second branch."}
          ],completionPolicy:"join",batchId:"shared-name",timeoutMs:10000})).structuredData);
        ` } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
    } else {
      const level = Number(userText(input).match(/level:(\d+)/)?.[1]);
      expect([1, 2, 3]).toContain(level);
      if (level === 3) {
        expect(input.tools.some((tool) => tool.name === "agent_spawn")).toBe(false);
        leaves.add(input.sessionId);
      } else if (!started.has(input.sessionId)) {
        expect(input.tools.some((tool) => tool.name === "agent_spawn")).toBe(true);
        started.add(input.sessionId);
        yield { type: "tool_call", name: "agent_spawn", input: {
          tasks: [
            { description: `Level ${level + 1} A`, prompt: `level:${level + 1} Review the first sub-scope.` },
            { description: `Level ${level + 1} B`, prompt: `level:${level + 1} Review the second sub-scope.` },
          ], completionPolicy: "join", batchId: "shared-name", timeoutMs: 10000,
        } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
    }
    yield { type: "text_delta", text: findings };
    yield { type: "finish", reason: "stop" };
  } };
  const host = await createChiliHost(hostOptions(root, model));
  try {
    rootSession = (await host.service.createSession()).sessionId;
    const result = await host.service.submitPrompt({ sessionId: rootSession, text: "Review the repository with nested agents." });
    expect(result.status).toBe("completed");
    await host.waitForBackgroundTasks();
    const tasks = await host.store.agentTasks({ limit: 64 });
    expect(tasks).toHaveLength(14);
    expect(tasks.every((task) => task.status === "completed")).toBe(true);
    expect(leaves.size).toBe(8);
    const owners = new Map(tasks.map((task) => [task.childSessionId!, task]));
    const counts = new Map<number, number>();
    for (const task of tasks) {
      const depth = task.path.split("/").length - 2;
      counts.set(depth, (counts.get(depth) ?? 0) + 1);
      const parentPath = task.parentSessionId === rootSession ? "/root" : owners.get(task.parentSessionId!)!.path;
      expect(task.parentPath).toBe(parentPath);
      expect(task.path).toBe(`${parentPath}/${task.id}`);
      expect(task.workerPolicy).toMatchObject({
        memberPath: task.path, parentSessionId: task.parentSessionId, childSessionId: task.childSessionId,
      });
      const errors = (await host.store.messages(task.childSessionId!)).flatMap((message) => message.parts)
        .filter((part) => part.type === "tool_result" && part.error !== undefined);
      expect(errors).toEqual([]);
    }
    expect([...counts].sort(([left], [right]) => left - right)).toEqual([[1, 2], [2, 4], [3, 8]]);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
}, 20000);

test("nested background and supervised spawns deliver handles before giving up the only execution slot", async () => {
  for (const [variant, callStyle] of [
    ["background", "direct"], ["supervised", "direct"],
    ["background", "code_mode"], ["supervised", "code_mode"],
  ] as const) {
    const root = await configuredWorkspace("max_children = 2\nmax_depth = 2\nmax_concurrent = 1");
    let rootSession: SessionId | undefined;
    let parentPhase = 0;
    let rootStarted = false;
    let receivedHandle = false;
    let timedOut = false;
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    const signal = new AbortController();
    const order: string[] = [];
    const model: ModelRouter = { async *stream(input): AsyncIterable<ModelStreamEvent> {
      if (input.sessionId === rootSession) {
        if (!rootStarted) {
          rootStarted = true;
          yield { type: "tool_call", name: "code_mode", input: { code: `
            text((await tools.agent_spawn({description:"Parent reviewer",prompt:"background-parent: Review with a nested agent.",mode:"resumable"})).structuredData);
          ` } };
          yield { type: "finish", reason: "tool_use" };
          return;
        }
      } else if (userText(input).includes("background-parent:")) {
        if (parentPhase++ === 0) {
          const spawnInput = variant === "background"
            ? { description: "Nested reviewer", prompt: "background-worker: Review the nested scope.", mode: "background", completionPolicy: "detached" }
            : { tasks: [{ description: "Nested reviewer", prompt: "background-worker: Review the nested scope." }], completionPolicy: "supervised" };
          yield callStyle === "direct"
            ? { type: "tool_call", name: "agent_spawn", input: spawnInput }
            : { type: "tool_call", name: "code_mode", input: { code: `text((await tools.agent_spawn(${JSON.stringify(spawnInput)})).structuredData);` } };
          yield { type: "finish", reason: "tool_use" };
          return;
        }
        if (!receivedHandle) {
          const result = input.messages.flatMap((message) => message.parts).findLast((part) => part.type === "tool_result");
          if (result?.type !== "tool_result") throw new Error("The parent did not receive its background handle");
          expect(result.error).toBeUndefined();
          const handle = JSON.parse(result.output) as { task_id?: string; tasks?: { task_id: string }[] };
          const taskId = handle.task_id ?? handle.tasks?.[0]?.task_id;
          expect(typeof taskId).toBe("string");
          receivedHandle = true;
          order.push("handle_received");
          releaseWorker();
          yield callStyle === "direct"
            ? { type: "tool_call", name: "agent_wait", input: { taskId, timeoutMs: 3000 } }
            : { type: "tool_call", name: "code_mode", input: { code: `text((await tools.agent_wait({taskId:${JSON.stringify(taskId)},timeoutMs:3000})).structuredData);` } };
          yield { type: "finish", reason: "tool_use" };
          return;
        }
      } else {
        await workerGate;
        expect(receivedHandle).toBe(true);
        order.push("worker_finished");
      }
      yield { type: "text_delta", text: findings };
      yield { type: "finish", reason: "stop" };
    } };
    const host = await createChiliHost(hostOptions(root, model));
    const timeout = setTimeout(() => {
      timedOut = true;
      releaseWorker();
      signal.abort(new Error("Background handle delivery deadlocked"));
    }, 5000);
    try {
      rootSession = (await host.service.createSession()).sessionId;
      const result = await host.service.submitPrompt({ sessionId: rootSession, text: "Review with background delegation.", signal: signal.signal });
      expect(timedOut).toBe(false);
      expect(result.status).toBe("completed");
      expect(order).toEqual(["handle_received", "worker_finished"]);
      const tasks = await host.store.agentTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.every((task) => task.status === "completed")).toBe(true);
    } finally {
      clearTimeout(timeout);
      releaseWorker();
      signal.abort();
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 15000);

test("Host child width survives completion and restart while resume reuses its existing identity", async () => {
  const root = await configuredWorkspace("max_children = 2\nmax_depth = 2\nmax_concurrent = 2");
  let rootSession: SessionId | undefined;
  let resumeTaskId = "";
  const handled = new Set<string>();
  const model: ModelRouter = { async *stream(input): AsyncIterable<ModelStreamEvent> {
    if (input.sessionId === rootSession) {
      const prompt = input.messages.findLast((message) => message.role === "user")!;
      const request = userText(input);
      if (!handled.has(prompt.id)) {
        handled.add(prompt.id);
        let code: string;
        if (request.includes("Initial concurrent")) {
          code = `
            const attempts = await Promise.allSettled([0,1,2].map(index => tools.agent_spawn({
              description:"Worker "+index,prompt:"Inspect the requested scope and report concrete findings.",mode:"background",completionPolicy:"detached"
            })));
            const accepted = attempts.filter(r => r.status === "fulfilled").map(r => r.value.structuredData.task_id);
            await tools.agent_wait({taskIds:accepted,timeoutMs:5000});
            text({kind:"initial",accepted,rejected:attempts.filter(r => r.status === "rejected").map(r => String(r.reason))});
          `;
        } else if (request.includes("Resume existing")) {
          code = `text({kind:"resumed",result:(await tools.agent_resume({taskId:${JSON.stringify(resumeTaskId)},prompt:"Verify your earlier findings once more."})).structuredData});`;
        } else {
          code = `
            let failure = "";
            try { await tools.agent_spawn({description:"Extra worker",prompt:"Inspect another scope."}); }
            catch (error) { failure = String(error); }
            text({kind:"restarted",failure});
          `;
        }
        yield { type: "tool_call", name: "code_mode", input: { code } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
    }
    yield { type: "text_delta", text: findings };
    yield { type: "finish", reason: "stop" };
  } };
  const options = hostOptions(root, model);
  let host = await createChiliHost(options);
  try {
    rootSession = (await host.service.createSession()).sessionId;
    expect((await host.service.submitPrompt({ sessionId: rootSession, text: "Initial concurrent allocation of three workers." })).status).toBe("completed");
    await host.waitForBackgroundTasks();
    const initial = await scriptRecord(host, rootSession, "initial");
    expect(initial.accepted).toHaveLength(2);
    expect(initial.rejected).toHaveLength(1);
    expect(String(initial.rejected)).toContain("direct children");
    let tasks = await host.store.agentTasks({ parentSessionId: rootSession });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.status === "completed")).toBe(true);
    resumeTaskId = tasks[0]!.id;
    const resumedSession = tasks[0]!.childSessionId;
    expect((await host.service.submitPrompt({ sessionId: rootSession, text: "Resume existing worker and verify its result." })).status).toBe("completed");
    expect((await scriptRecord(host, rootSession, "resumed")).result).toMatchObject({ taskId: resumeTaskId, status: "completed" });
    tasks = await host.store.agentTasks({ parentSessionId: rootSession });
    expect(tasks).toHaveLength(2);
    expect(tasks.find((task) => task.id === resumeTaskId)).toMatchObject({ childSessionId: resumedSession, generation: 2 });
    await host.close();
    host = await createChiliHost(options);
    expect((await host.service.submitPrompt({ sessionId: rootSession, text: "After restart, try allocating an additional worker." })).status).toBe("completed");
    expect(String((await scriptRecord(host, rootSession, "restarted")).failure)).toContain("direct children");
    expect(await host.store.agentTasks({ parentSessionId: rootSession })).toHaveLength(2);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);

test("zero depth or width hides spawning from root schemas, search and code mode", async () => {
  for (const configuration of ["max_children = 2\nmax_depth = 0", "max_children = 0\nmax_depth = 3"]) {
    const root = await configuredWorkspace(configuration);
    let searched = false;
    const model: ModelRouter = { async *stream(input): AsyncIterable<ModelStreamEvent> {
      expect(input.tools.some((tool) => tool.name === "agent_spawn")).toBe(false);
      if (!searched) {
        searched = true;
        yield { type: "tool_call", name: "code_mode", input: { code: `
          const search = (await tools.tool_search({query:"select:agent_spawn"})).structuredData;
          text({kind:"disabled",catalog:ALL_TOOLS.some(tool => tool.name === "agent_spawn"),callable:typeof tools.agent_spawn,found:search.tools.map(tool => tool.name)});
        ` } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text: findings };
      yield { type: "finish", reason: "stop" };
    } };
    const host = await createChiliHost(hostOptions(root, model));
    try {
      const sessionId = (await host.service.createSession()).sessionId;
      expect((await host.service.submitPrompt({ sessionId, text: "Inspect the available delegation tools." })).status).toBe("completed");
      expect(await scriptRecord(host, sessionId, "disabled")).toEqual({ kind: "disabled", catalog: false, callable: "undefined", found: [] });
      expect(await host.store.agentTasks()).toHaveLength(0);
    } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("persisted empty grants and scopes remain restrictive after restart and nested inheritance", async () => {
  for (const scenario of ["empty_grants", "empty_scopes"] as const) {
    const root = await configuredWorkspace("max_children = 2\nmax_depth = 2\nmax_concurrent = 1");
    await writeFile(join(root, "note.txt"), "original");
    let seededSession: SessionId | undefined;
    let nestedSession: SessionId | undefined;
    const scripted = new Set<SessionId>();
    const model: ModelRouter = { async *stream(input): AsyncIterable<ModelStreamEvent> {
      if (scenario === "empty_grants") {
        expect(input.tools.map((tool) => tool.name)).toEqual(["code_mode"]);
      }
      if (!scripted.has(input.sessionId)) {
        scripted.add(input.sessionId);
        let code: string;
        if (scenario === "empty_grants") {
          code = 'text({kind:"empty-policy",catalog:ALL_TOOLS.map(tool => tool.name),read:typeof tools.read,spawn:typeof tools.agent_spawn});';
        } else if (input.sessionId === seededSession) {
          code = `text({kind:"parent-policy",nested:(await tools.agent_spawn({
            description:"Scoped descendant",prompt:"Review the note while preserving inherited restrictions.",mode:"resumable"
          })).structuredData});`;
        } else {
          nestedSession = input.sessionId;
          code = `
            const note = (await tools.read({filePath:"note.txt"})).structuredData;
            let writeDenied = false;
            let executeError = "";
            try { await tools.write({filePath:"note.txt",content:"changed"}); } catch { writeDenied = true; }
            try { await tools.bash({command:"pwd"}); } catch (error) { executeError = String(error); }
            text({kind:"nested-policy",content:note.content,writeDenied,executeError});
          `;
        }
        yield { type: "tool_call", name: "code_mode", input: { code } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text: findings };
      yield { type: "finish", reason: "stop" };
    } };
    const options = hostOptions(root, model);
    let host = await createChiliHost(options);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const owner = (await host.service.createSession()).sessionId;
      const taskId = `${scenario}_worker` as TaskId;
      seededSession = await seedCompletedWorker(host, owner, taskId, {
        allowedTools: scenario === "empty_grants" ? [] : ["read", "write", "bash", "agent_spawn", "code_mode"],
        deniedTools: [], writeScope: [], executeScope: [],
      });
      await host.close();
      host = await createChiliHost(options);
      timeout = setTimeout(() => controller.abort(new Error("Scoped recursive work did not finish")), 5000);
      const result = await host.tasks.followupTask({ taskId, text: "Review the note and the effective policy.", signal: controller.signal });
      expect(result.task.status).toBe("completed");
      if (scenario === "empty_grants") {
        expect(await scriptRecord(host, seededSession, "empty-policy")).toEqual({
          kind: "empty-policy", catalog: [], read: "undefined", spawn: "undefined",
        });
        expect(await host.store.agentTasks({ parentSessionId: seededSession })).toHaveLength(0);
      } else {
        expect(nestedSession).toBeDefined();
        const nested = await scriptRecord(host, nestedSession!, "nested-policy");
        expect(nested.content).toBe("original");
        expect(nested.writeDenied).toBe(true);
        expect(String(nested.executeError)).toContain("does not have execute scope");
        const tasks = await host.store.agentTasks({ parentSessionId: seededSession });
        expect(tasks).toHaveLength(1);
        expect(tasks[0]!.workerPolicy).toMatchObject({
          allowedTools: ["read", "write", "bash", "agent_spawn", "code_mode"],
          deniedTools: [], writeScope: [], executeScope: [],
          memberPath: tasks[0]!.path, parentSessionId: seededSession, childSessionId: nestedSession,
        });
        expect(await readFile(join(root, "note.txt"), "utf8")).toBe("original");
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 15000);

function userText(input: ModelStreamInput): string {
  return input.messages.findLast((message) => message.role === "user")?.parts
    .flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "";
}

async function configuredWorkspace(configuration: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chili-agent-expansion-host-"));
  await mkdir(join(root, ".chili"));
  await writeFile(join(root, ".chili", "config.toml"), `[agents]\n${configuration}\n`);
  return root;
}

function hostOptions(root: string, modelRouter: ModelRouter) {
  return { cwd: root, chiliHome: join(root, "profile"), model: "fake" as const, modelRouter,
    mcpConnectMode: "manual" as const, staleTurnRecoveryIntervalMs: false as const };
}

async function seedCompletedWorker(
  host: ChiliHost, parentSessionId: SessionId, taskId: TaskId, policy: WorkerToolPolicy,
): Promise<SessionId> {
  const childSessionId = (await host.service.createSession()).sessionId;
  const path = `/root/${taskId}` as AgentPath;
  const runId = `${taskId}_run` as AgentRunId;
  const time = timestampNow();
  const identity = {
    taskId, path, parentPath: "/root" as AgentPath, parentSessionId, childSessionId,
    taskName: "Persisted worker", cwd: host.cwd, mode: "resumable" as const,
    workerPolicy: { ...policy, parentSessionId, childSessionId, memberPath: path },
  };
  await host.store.appendMany([
    { id: crypto.randomUUID(), type: "agent.task_created", sessionId: parentSessionId, time,
      payload: { ...identity, prompt: "Review the note" } },
    { id: crypto.randomUUID(), type: "agent.spawned", sessionId: parentSessionId, time,
      payload: { ...identity, runId } },
    { id: crypto.randomUUID(), type: "agent.completed", sessionId: parentSessionId, time,
      payload: { taskId, runId, path, status: "completed", summary: findings } },
  ]);
  return childSessionId;
}

async function scriptRecord(host: ChiliHost, sessionId: SessionId, kind: string): Promise<Record<string, unknown>> {
  const parts = (await host.store.messages(sessionId)).flatMap((message) => message.parts);
  for (const part of parts) {
    if (part.type !== "tool_result" || !part.output.includes(`"kind":"${kind}"`)) continue;
    expect(part.error).toBeUndefined();
    return JSON.parse(part.output) as Record<string, unknown>;
  }
  throw new Error(`Missing script record ${kind}: ${JSON.stringify(parts.filter((part) => part.type === "tool_result"))}`);
}
