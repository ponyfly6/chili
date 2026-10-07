import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChiliEvent, type SessionId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { createCodeModeTool, createToolSearchTool, InMemoryToolRegistry, ToolExecutor, type ToolAccessPolicy } from "@chili/tools";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "chili-tool-discovery-"));
  const path = join(cwd, "events.sqlite");
  let store = new SqliteEventStore(path);
  cleanup.push(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const registry = new InMemoryToolRegistry();
  let calls: Array<{ name: string; input: unknown }> = [];
  const captured: ModelStreamInput[] = [];
  const executed: string[] = [];
  let policy: ToolAccessPolicy | undefined;
  let required: string[] = [];
  let duringExposure: (() => void) | undefined;
  const resolver = { resolve: () => policy };
  for (const name of ["read", "lookup", "followup", "native_only"]) registry.register({
    name, aliases: name === "lookup" ? ["legacy_lookup"] : [], description: `Inspect ${name} records.`,
    risk: "read", codeMode: name !== "native_only", resourcePolicy: "internal",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Exact record identifier" } } },
    outputSchema: { type: "object", properties: { found: { type: "boolean" } } },
    resources: () => false,
    async execute() { executed.push(name); return { title: name, output: "ok", structuredData: { found: true } }; },
  });
  registry.register(createCodeModeTool());
  registry.register(createToolSearchTool(registry, { groups: [["lookup", "followup"]] }));
  const model: ModelRouter = {
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      captured.push(input);
      const next = calls;
      calls = [];
      for (const call of next) yield { type: "tool_call", ...call };
      if (!next.length) yield { type: "text_delta", text: "Summary of the completed inspection." };
      yield { type: "finish", reason: next.length ? "tool_use" : "stop" };
    },
  };
  const makeRuntime = () => new SingleAgentRuntime({
    store, model, toolRegistry: registry, toolPolicyResolver: resolver,
    toolExposure: { eagerTools: ["read", "code_mode", "tool_search"], requiredTools: async () => { duringExposure?.(); return required; } },
    toolExecutor: new ToolExecutor({ registry, events: { publish: (event) => store.append(event) },
      gate: { review: async () => ({ decision: "allow" }) }, policyResolver: resolver }),
  });
  let runtime = makeRuntime();
  const sessionId = await runtime.createSession({ cwd });
  const run = async (next: typeof calls = [], session: SessionId = sessionId) => {
    calls = next;
    return runtime.runTurn({ sessionId: session, cwd });
  };
  return {
    registry, captured, executed, sessionId, run,
    get store() { return store; },
    get runtime() { return runtime; },
    names: () => captured.at(-1)!.tools.map((tool) => tool.name),
    policy: (value: ToolAccessPolicy) => { policy = value; },
    required: (value: string[]) => { required = value; },
    duringExposure: (callback: () => void) => { duringExposure = callback; },
    restart() { store.close(); store = new SqliteEventStore(path); runtime = makeRuntime(); },
    newSession: () => runtime.createSession({ cwd }),
  };
}

test("search loads exact aliases and related controls durably across compaction and restart, scoped to the session", async () => {
  const f = await fixture();
  await f.run();
  expect(f.names()).toEqual(["code_mode", "read", "tool_search"]);
  await f.run([{ name: "tool_search", input: { query: "select:legacy_lookup" } }]);
  expect(f.names()).not.toContain("lookup");
  const events = await f.store.events({ sessionId: f.sessionId, type: "session.tools_loaded" });
  expect(events).toHaveLength(1);
  expect(parseChiliEvent(events[0]).payload).toMatchObject({ names: ["followup", "lookup"] });
  expect(() => parseChiliEvent({ ...events[0], sessionId: "another-session" })).toThrow("must match");
  await f.run([{ name: "lookup", input: {} }]);
  expect(f.names()).toContain("followup");
  expect(f.executed).toEqual(["lookup"]);
  expect((await f.runtime.compactContext({ sessionId: f.sessionId })).status).toBe("completed");
  f.restart();
  await f.run();
  expect(f.names()).toContain("lookup");
  await f.run([], await f.newSession());
  expect(f.names()).not.toContain("lookup");
});

test("unloaded direct calls and same-turn guessed calls cannot execute, including aliases", async () => {
  const f = await fixture();
  await f.run([
    { name: "tool_search", input: { query: "select:lookup" } },
    { name: "legacy_lookup", input: {} },
  ]);
  expect(f.executed).toEqual([]);
  const parts = (await f.store.messages(f.sessionId)).flatMap((message) => message.parts);
  expect(parts.some((part) => part.type === "tool_result" && part.error?.includes("not loaded for direct calls"))).toBe(true);
  await f.run([{ name: "legacy_lookup", input: {} }]);
  expect(f.executed).toEqual(["lookup"]);
});

test("code mode calls deferred tools without search and inspects full schemas without loading direct definitions", async () => {
  const f = await fixture();
  await f.run([{ name: "code_mode", input: { code: `
    text((await tools.lookup({query: "known"})).structuredData);
    const contract = (await tools.tool_search({query: "select:legacy_lookup"})).structuredData;
    text(contract.tools[0].inputSchema.properties.query.description);
    text(contract.loaded);
    text(typeof tools.native_only);
  ` } }]);
  expect(f.executed).toEqual(["lookup"]);
  expect(await f.store.events({ sessionId: f.sessionId, type: "session.tools_loaded" })).toEqual([]);
  const parts = (await f.store.messages(f.sessionId)).flatMap((message) => message.parts);
  expect(parts.some((part) => part.type === "tool_result" && part.output.includes("Exact record identifier\n[]\nundefined"))).toBe(true);
  await f.run();
  expect(f.names()).not.toContain("lookup");
});

test("loaded and workflow-required tools remain filtered by current policy and catalog removal", async () => {
  const f = await fixture();
  await f.run([{ name: "tool_search", input: { query: "select:lookup" } }]);
  f.required(["native_only"]);
  f.policy({ deniedTools: ["lookup", "native_only"] });
  await f.run([{ name: "code_mode", input: { code: 'text(typeof tools.lookup); text((await tools.tool_search({query:"select:lookup"})).structuredData.tools);' } }]);
  expect(f.names()).not.toContain("lookup");
  expect(f.names()).not.toContain("native_only");
  expect(f.executed).toEqual([]);
  f.registry.unregister("followup");
  await f.run();
  expect(f.names()).not.toContain("followup");
});

test("workflow controls are visible without search history and require no synthetic activation event", async () => {
  const f = await fixture();
  f.required(["followup"]);
  await f.run([{ name: "followup", input: {} }]);
  expect(f.executed).toEqual(["followup"]);
  expect(await f.store.events({ type: "session.tools_loaded" })).toEqual([]);
});

test("a catalog change during asynchronous exposure resolution invalidates the captured model definitions", async () => {
  const f = await fixture();
  f.duringExposure(() => {
    f.registry.register({ ...f.registry.get("read")!, description: "Replacement read contract" }, { replace: true });
  });
  await f.run([{ name: "read", input: {} }]);
  expect(f.executed).toEqual([]);
  const parts = (await f.store.messages(f.sessionId)).flatMap((message) => message.parts);
  expect(parts.some((part) => part.type === "tool_result" && part.error?.includes("Tool catalog changed"))).toBe(true);
});
