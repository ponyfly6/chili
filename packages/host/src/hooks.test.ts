import { expect, test } from "bun:test";
import type { PromptFragment, RuntimeModelChangedInput } from "@chili/core";
import type { RuntimeEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import type { ToolReviewRequest } from "@chili/tools";
import { HostModuleRegistry, type HostModule, type HostHookDiagnostic, type HostPromptContext } from "./hooks.js";
import { createModuleExecutionGate, EXECUTION_REVIEW_MODULE_ID } from "./module-gate.js";
import type { ReviewSettings } from "./approval.js";

const sessionId = "hooks_session" as SessionId;
const context: HostPromptContext = { sessionId, cwd: "/workspace", agentKind: "root", turn: { text: "Read the code." } };
const modelInput: RuntimeModelChangedInput = { sessionId, modelSelection: { provider: "fake", model: "fake" } };
const request: ToolReviewRequest = {
  sessionId, turnId: "turn" as TurnId, callId: "call" as ToolCallId,
  toolName: "bash", toolDescription: "Run a command", risk: "execute", cwd: "/workspace", input: { command: "true" },
};
function fragment(id: string): PromptFragment {
  return { id, layer: "developer", source: "runtime", priority: 1, lifecycle: "turn", trust: "system", content: id,
    metadata: { source: { name: "original" } } };
}
function event(id = "event"): RuntimeEvent {
  return { id, type: "session.model_changed", sessionId, time: 1 as TimestampMs, payload: modelInput };
}

test("registration captures multiple capabilities in fixed order, rejecting collisions and reserved ids", async () => {
  for (const timeoutMs of [0, -1, 60_001, Number.NaN, 1.5]) {
    expect(() => new HostModuleRegistry({ modules: [{ id: "invalid", timeoutMs, prompt: { collect: () => [] } }] })).toThrow("timeoutMs");
  }
  expect(() => new HostModuleRegistry({ modules: [{ id: "chili.external", runtime: { event() {} } }] })).toThrow("reserved");
  expect(() => new HostModuleRegistry({ modules: [{ id: "same", runtime: { event() {} } }, { id: "same", prompt: { collect: () => [] } }] })).toThrow("Duplicate");
  expect(() => new HostModuleRegistry({ modules: [{ id: "unknown", wrap() {} } as unknown as HostModule] })).toThrow("Unsupported");
  expect(() => new HostModuleRegistry({ modules: [{ id: "unknown", constructor: {}, runtime: { event() {} } } as unknown as HostModule] })).toThrow("Unsupported");
  expect(() => new HostModuleRegistry({ modules: [{ id: "invalid", prompt: {}, runtime: { event() {} } } as unknown as HostModule] })).toThrow("requires a handler");
  const calls: string[] = [];
  const source: HostModule = { id: "external", prompt: { collect: () => { calls.push("prompt"); return []; } }, runtime: { event() { calls.push("event"); } } };
  const registry = new HostModuleRegistry({ builtins: [{ id: "chili.base", prompt: { collect: () => { calls.push("builtin"); return []; } } }], modules: [source] });
  source.prompt!.collect = () => { throw new Error("mutated registration"); };
  await registry.collectPrompt(context);
  registry.observeRuntime(event());
  expect(calls).toEqual(["builtin", "prompt", "event"]);
});

test("review module is mandatory even in full access, which retains the permission revision permit", async () => {
  let settings: ReviewSettings = { profile: "full-access", revision: 0, reviewInstructions: "custom" };
  expect(() => createModuleExecutionGate({ modules: new HostModuleRegistry({ modules: [{ id: "fake", tools: { review: () => ({ decision: "allow" }) } }] }), settings: () => settings })).toThrow("requires the registered");
  let reviews = 0;
  let freshness = 0;
  const modules = new HostModuleRegistry({ builtins: [{ id: EXECUTION_REVIEW_MODULE_ID, tools: { review: async (input) => {
    reviews++;
    expect(input).not.toBe(request);
    expect(Object.isFrozen(input.input)).toBe(true);
    return { decision: "allow", assertCurrent: async () => { freshness++; } };
  } } }] });
  const gate = createModuleExecutionGate({ modules, settings: () => settings });
  const permit = await gate.review(request);
  expect(reviews).toBe(0);
  settings = { ...settings, profile: "auto-review", revision: 1 };
  await expect(permit.assertCurrent!()).rejects.toThrow("settings changed");
  const reviewed = await gate.review(request);
  await reviewed.assertCurrent!();
  expect(reviews).toBe(1);
  expect(freshness).toBe(1);
});

test("review requires unanimous allows, rejects invalid contracts and bounds hung reviewers", async () => {
  const order: string[] = [];
  const modules = new HostModuleRegistry({ modules: [
    { id: "deny", tools: { review: () => { order.push("deny"); return { decision: "deny", reason: "outside scope" }; } } },
    { id: "allow", tools: { review: () => { order.push("allow"); return { decision: "allow" }; } } },
  ] });
  expect(await modules.review(request)).toMatchObject({ decision: "deny", reason: "outside scope" });
  expect(order).toEqual(["deny"]);
  const invalid = new HostModuleRegistry({ modules: [{ id: "invalid", tools: { review: () => ({ decision: "maybe" }) as never } }] });
  await expect(invalid.review(request)).rejects.toMatchObject({ moduleId: "invalid", point: "tools.review" });
  let received: AbortSignal | undefined;
  const slow = new HostModuleRegistry({ modules: [{ id: "slow", timeoutMs: 10, tools: { review: (_request, signal) => { received = signal; return new Promise(() => {}); } } }] });
  await expect(slow.review(request)).rejects.toThrow("Timed out");
  expect(received?.aborted).toBe(true);
});

test("prompt contributors get readonly snapshots and cannot overwrite another contributor's fragments", async () => {
  const supplied = fragment("external");
  const modules = new HostModuleRegistry({ builtins: [{ id: "chili.base", prompt: { collect: () => [fragment("base")] } }], modules: [{
    id: "custom", prompt: { collect(input) {
      expect(Object.isFrozen(input.turn)).toBe(true);
      expect(input).not.toBe(context);
      return [supplied];
    } },
  }] });
  const result = await modules.collectPrompt(context);
  supplied.content = "mutated later";
  (supplied.metadata!.source as { name: string }).name = "mutated later";
  expect(result.map((item) => item.content)).toEqual(["base", "external"]);
  expect(result[1]?.metadata).toEqual({ source: { name: "original" } });
  expect(Object.isFrozen(context.turn)).toBe(false);
  const collisions = new HostModuleRegistry({ modules: [
    { id: "first", prompt: { collect: () => [fragment("same")] } },
    { id: "second", prompt: { collect: () => [fragment("same")] } },
  ] });
  await expect(collisions.collectPrompt(context)).rejects.toMatchObject({ moduleId: "second" });
  const sameOwner = new HostModuleRegistry({ modules: [{ id: "one", prompt: { collect: () => [fragment("same"), fragment("same")] } }] });
  expect(await sameOwner.collectPrompt(context)).toHaveLength(2);
});

test("caller cancellation propagates unchanged while host shutdown preserves completion work and end observers", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Stopped", "AbortError");
  const diagnostics: HostHookDiagnostic[] = [];
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const calls: string[] = [];
  const registry = new HostModuleRegistry({ modules: [{ id: "combined",
    prompt: { collect: () => { start(); return new Promise(() => {}); } },
    modelSelection: { changed: async () => { calls.push("saved"); } },
    runtime: { event: (value) => { calls.push(value.id); } },
  }], onError: (diagnostic) => { diagnostics.push(diagnostic); } });
  const pending = registry.collectPrompt(context, controller.signal);
  await started;
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(diagnostics).toEqual([]);
  registry.abortPending();
  await registry.modelChanged(modelInput);
  registry.observeRuntime(event("closing"));
  await expect(registry.collectPrompt(context)).rejects.toMatchObject({ name: "AbortError" });
  registry.close();
  registry.observeRuntime(event("after-close"));
  expect(calls).toEqual(["saved", "closing"]);
});

test("observers are filtered and isolated by capability, including accidental async observers", async () => {
  const diagnostics: HostHookDiagnostic[] = [];
  const calls: string[] = [];
  const eventTypes: RuntimeEvent["type"][] = ["session.model_changed"];
  const registry = new HostModuleRegistry({ modules: [
    { id: "mixed", runtime: { event() { calls.push("throws"); throw new Error("observer failed"); } }, tools: { review: () => { calls.push("review"); return { decision: "allow" }; } } },
    { id: "async", runtime: { event: async () => { calls.push("async"); throw new Error("async failed"); } } },
    { id: "filtered", runtime: { eventTypes: ["tool.call_started"], event() { calls.push("filtered"); } } },
    { id: "ok", runtime: { eventTypes, event(value) { calls.push(value.id); expect(Object.isFrozen(value.payload)).toBe(true); } } },
  ], onError: (diagnostic) => { diagnostics.push(diagnostic); throw new Error("diagnostic failed"); } });
  eventTypes.length = 0;
  const original = event("first");
  registry.observeRuntime(original);
  registry.observeRuntime(event("second"));
  expect((await registry.review(request)).decision).toBe("allow");
  expect(calls).toEqual(["throws", "async", "first", "second", "review"]);
  expect(Object.isFrozen(original.payload)).toBe(false);
  expect(diagnostics.map((item) => item.moduleId)).toEqual(["mixed", "async"]);
  expect(diagnostics.every((item) => item.error.name === "HostHookError")).toBe(true);
  await Promise.resolve();
});

test("required model setting effects run first and named failures remain failures", async () => {
  const calls: string[] = [];
  const registry = new HostModuleRegistry({ builtins: [{ id: "chili.persist", modelSelection: { changed: async (input) => {
    expect(Object.isFrozen(input.modelSelection)).toBe(true);
    calls.push("saved");
  } } }], modules: [{ id: "failure", modelSelection: { changed() { throw new Error("disk full"); } } }] });
  registry.abortPending();
  await expect(registry.modelChanged(modelInput)).rejects.toMatchObject({ moduleId: "failure", point: "modelSelection.changed" });
  expect(calls).toEqual(["saved"]);
});

test("freshness assertions are bounded and cancelled, even when a module returns a hung assertion", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const registry = new HostModuleRegistry({ modules: [{ id: "hung", tools: { review: () => ({ decision: "allow", assertCurrent: async () => {
    entered(); await new Promise(() => {});
  } }) } }] });
  const permit = await registry.review(request);
  const pending = permit.assertCurrent!();
  await ready;
  registry.abortPending();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  const timed = new HostModuleRegistry({ modules: [{ id: "slow", timeoutMs: 10, tools: { review: () => ({ decision: "allow", assertCurrent: () => new Promise(() => {}) }) } }] });
  await expect((await timed.review(request)).assertCurrent!()).rejects.toMatchObject({ moduleId: "slow", point: "tools.review" });
});

test("each processor stage validates presentation and preserves canonical fields before the next module", async () => {
  const registry = new HostModuleRegistry({ modules: [
    { id: "first", tools: { processResult: async (_context, result) => ({ ...result, output: "first", metadata: { forged: true }, structuredData: { value: 0 } }) } },
    { id: "second", tools: { processResult: async (_context, result) => {
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.metadata).toEqual({ canonical: true });
      expect(result.structuredData).toEqual({ value: 42 });
      expect(result.output).toBe("first");
      return { ...result, output: "second" };
    } } },
  ] });
  const result = await registry.toolLifecycle.processResult!({ ...request, prepared: true, invocationMode: "direct" }, {
    title: "result", output: "original", structuredData: { value: 42 }, metadata: { canonical: true },
  }, new AbortController().signal);
  expect(result.output).toBe("second");
  expect(result.metadata).toEqual({ canonical: true });
  let next = false;
  let getterRan = false;
  const invalid = new HostModuleRegistry({ modules: [
    { id: "invalid", tools: { processResult: async () => Object.defineProperty({ title: "bad" }, "output", { get() { getterRan = true; return "bad"; } }) as never } },
    { id: "later", tools: { processResult: async (_context, value) => { next = true; return value; } } },
  ] });
  await expect(invalid.toolLifecycle.processResult!({ ...request, prepared: true, invocationMode: "direct" }, {
    title: "original", output: "original",
  }, new AbortController().signal)).rejects.toMatchObject({ moduleId: "invalid", point: "tools.processResult" });
  expect(getterRan).toBe(false);
  expect(next).toBe(false);
});

test("diagnostics cannot mutate an awaited failure into cancellation or change its explanation", async () => {
  let diagnosticError: Error | undefined;
  const registry = new HostModuleRegistry({ modules: [{ id: "failed", prompt: { collect() { throw new Error("actual failure"); } } }],
    onError(diagnostic) {
      diagnosticError = diagnostic.error;
      expect(Object.isFrozen(diagnostic)).toBe(true);
      diagnostic.error.name = "AbortError";
    },
  });
  const failure = await registry.collectPrompt(context).catch((error: unknown) => error);
  expect(failure).toMatchObject({ name: "HostHookError", moduleId: "failed" });
  expect((failure as Error).message).toContain("actual failure");
  expect(failure).not.toBe(diagnosticError);
});
