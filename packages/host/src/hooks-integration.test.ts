import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput, PromptFragment } from "@chili/core";
import type { RuntimeEvent, SessionId, TimestampMs } from "@chili/protocol";
import type { BashRunner } from "@chili/tools";
import { createChiliHost, type ChiliHost, type ChiliHostOptions } from "./host.js";
import { createHostMcpRuntime } from "./mcp-control.js";
import { readUserModelSelection } from "./user-model-state.js";

test("public Host hooks retain mandatory execution review in both permission modes", async () => {
  for (const outcome of ["full-access", "allow", "deny", "error"] as const) {
    await withWorkspace(async (options) => {
      let executions = 0;
      let reviews = 0;
      let moduleReviews = 0;
      const observed: RuntimeEvent[] = [];
      const host = await createChiliHost({
        ...options,
        permissionProfile: outcome === "full-access" ? "full-access" : "auto-review",
        bashRunner: fakeRunner(() => { executions++; }),
        reviewerModelRouter: reviewer(() => {
          reviews++;
          expect(executions).toBe(0);
          if (outcome === "error") throw new Error("Hook fixture reviewer unavailable");
          return { decision: outcome === "deny" ? "deny" : "allow", reason: "Hook fixture review" };
        }),
        modules: [{ id: "fixture.public", prompt: { collect: () => [fragment("fixture.public-prompt", "Public hook contribution")] },
          tools: { async review() { moduleReviews++; return { decision: "allow" }; } },
          runtime: { event: (event) => { observed.push(event); } } }],
      });
      try {
        const sessionId = await runShell(host);
        expect(reviews).toBe(outcome === "full-access" ? 0 : 1);
        expect(moduleReviews).toBe(outcome === "allow" ? 1 : 0);
        expect(executions).toBe(outcome === "full-access" || outcome === "allow" ? 1 : 0);
        const finished = await host.store.events({ sessionId, type: "tool.call_finished" });
        expect(finished).toHaveLength(1);
        expect(finished[0]).toMatchObject({ payload: { status: executions ? "completed" : "failed" } });
        expect(observed.filter((event) => event.id === finished[0]!.id)).toHaveLength(1);
        if (outcome === "error") expect(JSON.stringify(finished)).toContain("Hook fixture reviewer unavailable");
      } finally { await host.close(); }
    });
  }
});

test("Hook observers see separately reviewed code-mode children without authorizing a denied child", async () => {
  await withWorkspace(async (options) => {
    let executions = 0;
    const actions: ReviewAction[] = [];
    const starts: RuntimeEvent[] = [];
    const host = await createChiliHost({
      ...options,
      permissionProfile: "auto-review",
      modelRouter: singleToolModel("code_mode", { code: 'await tools.bash({command:"/usr/bin/true"});' }),
      bashRunner: fakeRunner(() => { executions++; }),
      reviewerModelRouter: reviewer((input) => {
        const action = reviewAction(input);
        actions.push(action);
        return { decision: action.toolName === "bash" ? "deny" : "allow", reason: "Nested hook fixture" };
      }),
      modules: [{ id: "fixture.nested-events", runtime: { eventTypes: ["tool.call_started"], event: (event) => { starts.push(event); } } }],
    });
    try {
      const sessionId = (await host.service.createSession()).sessionId;
      await host.service.submitPrompt({ sessionId, text: "Run the composed fixture." });
      expect(actions.map((action) => action.toolName)).toEqual(["code_mode", "bash"]);
      expect(actions[1]?.input).toEqual({ command: "/usr/bin/true" });
      expect(actions[1]?.parentCallId).toBe(actions[0]?.callId);
      expect(executions).toBe(0);
      expect(starts).toHaveLength(2);
      expect(starts.every((event) => event.type === "tool.call_started")).toBe(true);
      const finished = (await host.store.events({ sessionId, type: "tool.call_finished" }))
        .filter((event): event is Extract<RuntimeEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished");
      expect(finished).toHaveLength(2);
      expect(finished.every((event) => event.payload.status === "failed")).toBe(true);
    } finally { await host.close(); }
  });
});

test("prompt hooks contribute to root and child requests alongside fixed Host instructions", async () => {
  await withWorkspace(async (options) => {
    const requests: ModelStreamInput[] = [];
    const contexts: Array<{ agentKind: "root" | "child"; sessionId: SessionId; cwd: string }> = [];
    const host = await createChiliHost({
      ...options,
      permissionProfile: "auto-review",
      modelRouter: { async *stream(input) {
        requests.push(input);
        yield { type: "text_delta", text: "Fixture complete." };
        yield { type: "finish", reason: "stop" };
      } },
      modules: [{ id: "fixture.prompt-context", prompt: { async collect(context, signal) {
        expect(signal.aborted).toBe(false);
        contexts.push({ agentKind: context.agentKind, sessionId: context.sessionId, cwd: context.cwd });
        return [fragment("fixture.agent-kind", `HOOK_AGENT_KIND_${context.agentKind}`)];
      } } }],
    });
    try {
      const root = (await host.service.createSession()).sessionId;
      expect((await host.service.submitPrompt({ sessionId: root, text: "Root fixture." })).status).toBe("completed");
      const agents = host.agents.forSession(root);
      const child = await agents.spawnAgent({ name: "reader", prompt: "Child fixture." });
      expect((await agents.waitAgent({ ...child, timeoutMs: 5_000 })).input.outcome).toBe("completed");
      await host.waitForAgents();
      expect(requests).toHaveLength(2);
      for (const [sessionId, agentKind] of [[root, "root"], [child.agentId, "child"]] as const) {
        expect(contexts).toContainEqual({ sessionId: sessionId as SessionId, agentKind, cwd: host.cwd });
        const request = requests.find((input) => input.sessionId === sessionId)!;
        expect(request).toBeDefined();
        expect(request.contextualUser?.join("\n")).toContain(`HOOK_AGENT_KIND_${agentKind}`);
        const developer = request.developer?.join("\n") ?? "";
        expect(developer).toContain("Tool execution mode: Auto-review.");
        expect(developer).toContain("Agent expansion limits:");
        expect(developer.split("Tool execution mode: Auto-review.")).toHaveLength(2);
        expect(developer.split("Agent expansion limits:")).toHaveLength(2);
      }
    } finally { await host.close(); }
  });
});

test("runtime event hooks and legacy onEvent each observe startup and transient events once despite observer failures", async () => {
  await withWorkspace(async (options) => {
    const legacy: RuntimeEvent[] = [];
    const observed: RuntimeEvent[] = [];
    const filtered: RuntimeEvent[] = [];
    const diagnostics: unknown[] = [];
    const startup: RuntimeEvent = {
      id: "hook_fixture_startup", type: "mcp.diagnostic", time: Date.now() as TimestampMs,
      payload: { serverName: "fixture", level: "warning", code: "hook_fixture", source: "runtime", message: "Hook startup fixture" },
    };
    const host = await createChiliHost({
      ...options,
      bashRunner: fakeRunner(() => undefined, true),
      onEvent(event) { legacy.push(event); },
      onHookError(diagnostic) { diagnostics.push(diagnostic); },
      modules: [
        { id: "fixture.throwing-observer", runtime: { eventTypes: ["tool.call_finished"], event() { throw new Error("Hook observer failure"); } } },
        { id: "fixture.all-events", runtime: { event(event) { observed.push(event); } } },
        { id: "fixture.output-events", runtime: { eventTypes: ["tool.output_delta"], event(event) { filtered.push(event); } } },
      ],
      async mcpRuntimeFactory(runtimeOptions, baseCommands) {
        await runtimeOptions.events?.publish(startup);
        return createHostMcpRuntime(runtimeOptions, baseCommands);
      },
    });
    try {
      const sessionId = await runShell(host);
      expect(observed.filter((event) => event.id === startup.id)).toHaveLength(1);
      expect(legacy.filter((event) => event.id === startup.id)).toHaveLength(1);
      expect(observed.map((event) => event.id)).toEqual(legacy.map((event) => event.id));
      expect(new Set(observed.map((event) => event.id)).size).toBe(observed.length);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toMatchObject({ type: "tool.output_delta", payload: { delta: "Hook live output" } });
      expect(await host.store.events({ sessionId, type: "tool.output_delta" })).toEqual([]);
      expect(await host.store.events({ sessionId, type: "tool.call_finished" })).toMatchObject([{ payload: { status: "completed" } }]);
      expect(diagnostics).toHaveLength(1);
      expect(JSON.stringify(diagnostics)).toContain("fixture.throwing-observer");
    } finally { await host.close(); }
  });
});

test("model selection completion effects are awaited after the built-in module persists the personal model default", async () => {
  await withWorkspace(async (options) => {
    let begin!: () => void;
    const began = new Promise<void>((resolve) => { begin = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const changes: Array<{ sessionId: SessionId; modelSelection: { provider: string; model: string } }> = [];
    const host = await createChiliHost({
      ...options,
      modules: [{ id: "fixture.await-model", modelSelection: { async changed(input) {
        expect(await readUserModelSelection({ chiliHome: options.chiliHome })).toEqual(input.modelSelection);
        changes.push(input);
        begin();
        await released;
      } } }],
    });
    try {
      const sessionId = (await host.service.createSession()).sessionId;
      const modelSelection = { provider: "fixture", model: "hook-model" };
      let settled = false;
      const pending = host.service.setModel({ sessionId, modelSelection }).then((result) => { settled = true; return result; });
      await began;
      expect(settled).toBe(false);
      release();
      expect((await pending).modelSelection).toEqual(modelSelection);
      expect(changes).toEqual([{ sessionId, modelSelection }]);
      expect(await readUserModelSelection({ chiliHome: options.chiliHome })).toEqual(modelSelection);
      const next = (await host.service.createSession()).sessionId;
      expect((await host.service.getModelConfig(next)).modelSelection).toEqual(modelSelection);
    } finally {
      release();
      await host.close();
    }
  });
});

test("Host close cancels a pending prompt hook before requesting the model", async () => {
  await withWorkspace(async (options) => {
    let begin!: () => void;
    const began = new Promise<void>((resolve) => { begin = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let hookSignal: AbortSignal | undefined;
    let modelRequests = 0;
    const host = await createChiliHost({
      ...options,
      modelRouter: { async *stream() {
        modelRequests++;
        yield { type: "finish", reason: "stop" };
      } },
      modules: [{ id: "fixture.pending-prompt", prompt: { async collect(_context, signal) {
        hookSignal = signal;
        begin();
        await released;
        return [];
      } } }],
    });
    let closing: Promise<void> | undefined;
    try {
      const sessionId = (await host.service.createSession()).sessionId;
      const submitting = host.service.submitPrompt({ sessionId, text: "Wait in the prompt hook." });
      await began;
      closing = host.close();
      expect(await Promise.race([closing.then(() => true), Bun.sleep(2_000).then(() => false)])).toBe(true);
      expect(hookSignal?.aborted).toBe(true);
      expect((await submitting).status).toBe("cancelled");
      expect(modelRequests).toBe(0);
    } finally {
      release();
      await (closing ?? host.close());
    }
  });
});

function fragment(id: string, content: string): PromptFragment {
  return { id, content, layer: "contextual_user", source: "runtime", priority: 30, lifecycle: "turn", trust: "user" };
}

async function runShell(host: ChiliHost): Promise<SessionId> {
  const sessionId = (await host.service.createSession()).sessionId;
  expect((await host.service.submitPrompt({ sessionId, text: "desktop approval fixture" })).status).toBe("completed");
  return sessionId;
}

function singleToolModel(name: string, input: unknown): ModelRouter {
  let called = false;
  return { async *stream(): AsyncIterable<ModelStreamEvent> {
    if (!called) {
      called = true;
      yield { type: "tool_call", name, input };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "Fixture complete." };
    yield { type: "finish", reason: "stop" };
  } };
}

function fakeRunner(onRun: () => void, stream = false): BashRunner {
  return { async run(request) {
    onRun();
    if (stream) await request.onOutput?.({ stream: "stdout", delta: "Hook live output", bytes: 16 });
    return {
      exitCode: 0, signal: null, stdout: "ok", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      stdoutBytes: 2, stderrBytes: 0, outputLimitBytes: request.maxOutputBytes, durationMs: 1,
      timedOut: false, aborted: false, sandbox: "none",
    };
  } };
}

function reviewer(decide: (input: ModelStreamInput) => { decision: "allow" | "deny"; reason: string }): ModelRouter {
  return { async *stream(input) {
    yield { type: "text_delta", text: JSON.stringify(decide(input)) };
    yield { type: "finish", reason: "stop" };
  } };
}

interface ReviewAction { toolName: string; input: unknown; callId: string; parentCallId?: string; }

function reviewAction(input: ModelStreamInput): ReviewAction {
  const message = input.messages.findLast((item) => item.role === "user");
  const text = message?.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
  return JSON.parse(text).action as ReviewAction;
}

async function withWorkspace(run: (options: ChiliHostOptions & { chiliHome: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "chili-host-hooks-"));
  try {
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    await run({ cwd, chiliHome: join(root, "home"), model: "fake", permissionProfile: "full-access", mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  } finally { await rm(root, { recursive: true, force: true }); }
}
