import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRunContext, AgentRunOutcome, ModelLifecycleContext, ModelLifecycleOutcome,
  ModelRouter, ModelStreamEvent, ModelStreamInput,
} from "@chili/core";
import type { SessionId } from "@chili/protocol";
import type { BashRunner, ToolLifecycleOutcome } from "@chili/tools";
import { createChiliHost, type ChiliHostOptions } from "./host.js";

test("concurrent root and child inputs retain separate task, review, tool, and Agent lifecycles", async () => {
  await withWorkspace(async (options) => {
    const modelStarts: ModelLifecycleContext[] = [];
    const modelEnds: ModelLifecycleOutcome[] = [];
    const modelEvents: Array<{ context: ModelLifecycleContext; type: ModelStreamEvent["type"] }> = [];
    const agentStarts: AgentRunContext[] = [];
    const agentEnds: AgentRunOutcome[] = [];
    const toolEnds: ToolLifecycleOutcome[] = [];
    const followups: ModelStreamInput[] = [];
    const requests = new Map<SessionId, number>();
    let executions = 0;
    let openBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { openBarrier = resolve; });
    const host = await createChiliHost({
      ...options,
      permissionProfile: "auto-review",
      modelRouter: { async *stream(input) {
        const count = requests.get(input.sessionId) ?? 0;
        requests.set(input.sessionId, count + 1);
        if (count === 0) {
          if (requests.size === 2) openBarrier();
          await barrier;
          yield { type: "tool_call", name: "bash", input: { command: "/usr/bin/true" } };
          yield { type: "finish", reason: "tool_use" };
          return;
        }
        followups.push(input);
        yield { type: "text_delta", text: "Complete." };
        yield { type: "finish", reason: "stop" };
      } },
      reviewerModelRouter: allowingReviewer(),
      bashRunner: fakeRunner(() => { executions++; }),
      modules: [{
        id: "fixture.lifecycle",
        tools: {
          async processResult(context, result) { return { ...result, output: `processed:${context.sessionId}` }; },
          ended(outcome) { toolEnds.push(outcome); },
        },
        model: {
          started(context) { modelStarts.push(context); },
          event(context, event) { modelEvents.push({ context, type: event.type }); },
          ended(outcome) { modelEnds.push(outcome); },
        },
        agent: {
          started(context) { agentStarts.push(context); },
          ended(outcome) { agentEnds.push(outcome); },
        },
      }],
    });
    try {
      const rootId = (await host.service.createSession()).sessionId;
      const agents = host.agents.forSession(rootId);
      const child = await agents.spawnAgent({ name: "concurrent-reader", prompt: "Run the child fixture." });
      const rootResult = host.service.submitPrompt({ sessionId: rootId, text: "Run the root fixture." });
      expect((await rootResult).status).toBe("completed");
      expect((await agents.waitAgent({ ...child, timeoutMs: 5_000 })).input.outcome).toBe("completed");
      await host.waitForAgents();
      expect(executions).toBe(2);
      expect(agentStarts).toHaveLength(2);
      expect(agentEnds).toHaveLength(2);
      expect(toolEnds).toHaveLength(2);
      expect(modelStarts).toHaveLength(6);
      expect(modelEnds).toHaveLength(6);
      expect(new Set(modelStarts.map((value) => value.requestId)).size).toBe(6);
      expect(modelEnds.map((value) => value.context.requestId).sort()).toEqual(modelStarts.map((value) => value.requestId).sort());
      expect(modelEnds.every((value) => value.status === "completed")).toBe(true);
      for (const [sessionId, role] of [[rootId, "root"], [child.agentId, "child"]] as const) {
        const starts = modelStarts.filter((value) => value.sessionId === sessionId);
        expect(starts.filter((value) => value.purpose === "task").map((value) => value.agentRole)).toEqual([role, role]);
        expect(starts.filter((value) => value.purpose === "review").map((value) => value.agentRole)).toEqual([role]);
        if (role === "child") expect(starts.every((value) => value.parentSessionId === rootId)).toBe(true);
        expect(agentStarts.filter((value) => value.sessionId === sessionId)).toMatchObject([{ agentRole: role }]);
        expect(agentEnds.filter((value) => value.sessionId === sessionId)).toMatchObject([{ agentRole: role, status: "completed", turnCount: 2 }]);
        expect(toolEnds.filter((value) => value.context.sessionId === sessionId)).toMatchObject([
          { status: "completed", handlerEntered: true, executionSucceeded: true, result: { output: `processed:${sessionId}` } },
        ]);
        const followup = followups.find((value) => value.sessionId === sessionId);
        expect(followup?.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool_result"))
          .toMatchObject([{ output: `processed:${sessionId}` }]);
      }
      for (const value of modelEvents) {
        expect(modelStarts.find((start) => start.requestId === value.context.requestId)).toEqual(value.context);
      }
    } finally {
      openBarrier();
      await host.close();
    }
  });
});

test("a failed runtime observer does not disable review or tool completion in the same module", async () => {
  await withWorkspace(async (options) => {
    let externalReviews = 0;
    let executions = 0;
    const diagnostics: Array<{ moduleId: string; point: string }> = [];
    const ended: ToolLifecycleOutcome[] = [];
    const host = await createChiliHost({
      ...options,
      permissionProfile: "auto-review",
      modelRouter: oneToolModel(),
      reviewerModelRouter: allowingReviewer(),
      bashRunner: fakeRunner(() => { executions++; }),
      onHookError(diagnostic) { diagnostics.push(diagnostic); },
      modules: [{
        id: "fixture.mixed-capabilities",
        runtime: { eventTypes: ["tool.call_started"], event() { throw new Error("Observer unavailable"); } },
        tools: {
          async review() { externalReviews++; return { decision: "deny", reason: "Module rejects this fixture" }; },
          ended(outcome) { ended.push(outcome); },
        },
      }],
    });
    try {
      const sessionId = (await host.service.createSession()).sessionId;
      expect((await host.service.submitPrompt({ sessionId, text: "Run the fixture." })).status).toBe("completed");
      expect(externalReviews).toBe(1);
      expect(executions).toBe(0);
      expect(diagnostics).toMatchObject([{ moduleId: "fixture.mixed-capabilities", point: "runtime.event" }]);
      expect(ended).toHaveLength(1);
      expect(ended[0]).toMatchObject({ phase: "reviewing", status: "blocked", handlerEntered: false, executionSucceeded: false });
    } finally { await host.close(); }
  });
});

test("a result processor deadline preserves the successful execution and settles its input once", async () => {
  await withWorkspace(async (options) => {
    let executions = 0;
    let processorSignal: AbortSignal | undefined;
    const ended: ToolLifecycleOutcome[] = [];
    const agents: AgentRunOutcome[] = [];
    const diagnostics: Array<{ moduleId: string; point: string }> = [];
    const host = await createChiliHost({
      ...options,
      modelRouter: oneToolModel(),
      bashRunner: fakeRunner(() => { executions++; }),
      onHookError(diagnostic) { diagnostics.push(diagnostic); },
      modules: [{ id: "fixture.slow-processor", timeoutMs: 10,
        tools: {
          processResult(_context, _result, signal) { processorSignal = signal; return new Promise(() => {}); },
          ended(outcome) { ended.push(outcome); },
        },
        agent: { ended(outcome) { agents.push(outcome); } },
      }],
    });
    try {
      const sessionId = (await host.service.createSession()).sessionId;
      expect((await host.service.submitPrompt({ sessionId, text: "Run once." })).status).toBe("completed");
      expect(executions).toBe(1);
      expect(processorSignal?.aborted).toBe(true);
      expect(ended).toHaveLength(1);
      expect(ended[0]).toMatchObject({ status: "completed", executionSucceeded: true, handlerEntered: true });
      expect(ended[0]?.resultProcessingError).toBeDefined();
      expect(ended[0]?.result?.output).toContain("Do not rerun the tool");
      expect(await host.store.events({ sessionId, type: "tool.call_finished" })).toMatchObject([{ payload: { status: "completed" } }]);
      expect(agents).toMatchObject([{ sessionId, status: "completed", turnCount: 2 }]);
      expect(diagnostics).toMatchObject([{ moduleId: "fixture.slow-processor", point: "tools.processResult" }]);
    } finally { await host.close(); }
  });
});

test("manual compaction and verification keep their model purposes without creating prompt Agent runs", async () => {
  await withWorkspace(async (options) => {
    const starts: ModelLifecycleContext[] = [];
    const ends: ModelLifecycleOutcome[] = [];
    const agents: AgentRunOutcome[] = [];
    const host = await createChiliHost({
      ...options,
      modelRouter: { async *stream(input) {
        yield { type: "text_delta", text: input.purpose === "task" ? "Initial fixture response." : "Preserved fixture summary." };
        yield { type: "finish", reason: "stop" };
      } },
      modules: [{ id: "fixture.compaction",
        model: { started(context) { starts.push(context); }, ended(outcome) { ends.push(outcome); } },
        agent: { ended(outcome) { agents.push(outcome); } },
      }],
    });
    try {
      const sessionId = (await host.service.createSession()).sessionId;
      expect((await host.service.submitPrompt({ sessionId, text: "Remember the fixture." })).status).toBe("completed");
      expect((await host.service.compactSession({ sessionId })).status).toBe("completed");
      expect(starts.map((value) => value.purpose)).toEqual(["task", "compaction", "validation"]);
      expect(starts.every((value) => value.agentRole === "root" && value.sessionId === sessionId)).toBe(true);
      expect(ends.map((value) => value.context.requestId)).toEqual(starts.map((value) => value.requestId));
      expect(ends.every((value) => value.status === "completed")).toBe(true);
      expect(agents).toMatchObject([{ sessionId, status: "completed", turnCount: 1 }]);
    } finally { await host.close(); }
  });
});

test("Stop settles one model and one input lifecycle and closes the active provider iterator", async () => {
  await withWorkspace(async (options) => {
    let entered!: () => void;
    const enteredModel = new Promise<void>((resolve) => { entered = resolve; });
    let providerClosed = false;
    const models: ModelLifecycleOutcome[] = [];
    const agents: AgentRunOutcome[] = [];
    const host = await createChiliHost({
      ...options,
      modelRouter: { async *stream(input): AsyncIterable<ModelStreamEvent> {
        try {
          entered();
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(input.signal?.reason);
            if (input.signal?.aborted) abort();
            else input.signal?.addEventListener("abort", abort, { once: true });
          });
        } finally { providerClosed = true; }
      } },
      modules: [{ id: "fixture.stop",
        model: { ended(outcome) { models.push(outcome); } },
        agent: { ended(outcome) { agents.push(outcome); } },
      }],
    });
    try {
      const sessionId = (await host.service.createSession()).sessionId;
      const pending = host.service.submitPrompt({ sessionId, text: "Wait until stopped." });
      await enteredModel;
      await host.service.interrupt(sessionId);
      expect((await pending).status).toBe("cancelled");
      expect(providerClosed).toBe(true);
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({ status: "cancelled", termination: "abort", context: { sessionId, purpose: "task", agentRole: "root" } });
      expect(agents).toMatchObject([{ sessionId, status: "cancelled" }]);
    } finally { await host.close(); }
  });
});

function oneToolModel(): ModelRouter {
  let called = false;
  return { async *stream() {
    if (!called) {
      called = true;
      yield { type: "tool_call", name: "bash", input: { command: "/usr/bin/true" } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "Complete." };
    yield { type: "finish", reason: "stop" };
  } };
}

function allowingReviewer(): ModelRouter {
  return { async *stream() {
    yield { type: "text_delta", text: '{"decision":"allow","reason":"Requested fixture"}' };
    yield { type: "finish", reason: "stop" };
  } };
}

function fakeRunner(onRun: () => void): BashRunner {
  return { async run(request) {
    onRun();
    return { exitCode: 0, signal: null, stdout: "original", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      stdoutBytes: 8, stderrBytes: 0, outputLimitBytes: request.maxOutputBytes, durationMs: 1, timedOut: false, aborted: false, sandbox: "none" };
  } };
}

async function withWorkspace(run: (options: ChiliHostOptions & { chiliHome: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "chili-host-lifecycle-"));
  try {
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    await run({ cwd, chiliHome: join(root, "home"), model: "fake", permissionProfile: "full-access", mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  } finally { await rm(root, { recursive: true, force: true }); }
}
