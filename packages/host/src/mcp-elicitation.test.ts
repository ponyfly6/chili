import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeferredUserInputQueue, InMemoryToolRegistry, type ChiliToolExecutionContext } from "@chili/tools";
import type { ChiliEvent, SessionId, ToolCallId, TurnId } from "@chili/protocol";
import { createHostMcpRuntime } from "./mcp-control.js";
import { elicitMcpInput } from "./mcp-elicitation.js";
import type { McpElicitationRequest, McpServerConfig } from "@chili/mcp";

const config: McpServerConfig = { name: "forms", type: "http", url: "https://example.test/mcp", headers: {},
  source: "user", raw: {}, trust: false, enabled: true, required: false };
const context = { sessionId: "session_form" as SessionId, callId: "call_form" as ToolCallId, signal: new AbortController().signal };

test("MCP forms ask permission, collect typed fields, and validate the external schema", async () => {
  const queue = new DeferredUserInputQueue();
  const events: ChiliEvent[] = [];
  const answers = ["Continue", "Ada", "7", "true", "Skip field"];
  const result = await elicitMcpInput({ queue, events: { publish: async (event) => {
    events.push(event);
    if (event.type === "user_input.requested") {
      expect(queue.list()[0]?.sessionId).toBe(context.sessionId);
      expect(queue.list()[0]?.callId).toBe(context.callId);
      queue.resolve({ inputId: event.payload.inputId, answers: { [event.payload.questions[0]!.id]: [answers.shift()!] } });
    }
  } } }, config, { mode: "form", message: "Complete your profile", requestedSchema: {
    type: "object", required: ["name", "count", "enabled"], properties: {
      name: { type: "string", minLength: 2 }, count: { type: "integer", minimum: 1, maximum: 10 }, enabled: { type: "boolean" }, optional: { type: "string" },
    },
  } }, context);
  expect(result).toEqual({ action: "accept", content: { name: "Ada", count: 7, enabled: true } });
  expect(queue.list()).toEqual([]);
  expect(events.filter((event) => event.type === "user_input.resolved")).toHaveLength(5);
});

test("MCP input can be declined or aborted without leaving pending questions", async () => {
  const queue = new DeferredUserInputQueue();
  const request: McpElicitationRequest = { mode: "url", message: "Confirm in browser", url: "https://example.test/confirm" };
  expect(await elicitMcpInput({ queue, events: { publish: async (event) => {
    if (event.type === "user_input.requested") queue.resolve({ inputId: event.payload.inputId, answers: { consent: ["Decline"] } });
  } } }, config, request, context)).toEqual({ action: "decline" });
  const abort = new AbortController();
  await expect(elicitMcpInput({ queue, events: { publish: async (event) => {
    if (event.type === "user_input.requested") abort.abort(new Error("Call interrupted"));
  } } }, config, request, { ...context, signal: abort.signal })).rejects.toThrow("Call interrupted");
  expect(queue.list()).toEqual([]);
});

test("invalid MCP form data is not sent back as accepted content", async () => {
  const queue = new DeferredUserInputQueue();
  await expect(elicitMcpInput({ queue, events: { publish: async (event) => {
    if (event.type === "user_input.requested") queue.resolve({ inputId: event.payload.inputId, answers: {
      [event.payload.questions[0]!.id]: [event.payload.questions[0]!.id === "consent" ? "Continue" : "99"],
    } });
  } } }, config, { mode: "form", message: "Choose count", requestedSchema: {
    type: "object", required: ["count"], properties: { count: { type: "integer", maximum: 10 } },
  } }, context)).rejects.toThrow();
});

test("Host completes a real MCP tool round trip through its session user-input queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-form-host-"));
  const cwd = join(root, "workspace"); const chiliHome = join(root, "profile");
  await mkdir(cwd); await mkdir(chiliHome);
  const wire: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as typeof wire[number]; wire.push(body);
    let result: unknown;
    if (body.method === "server/discover") result = { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } };
    else if (body.method === "tools/list") result = { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [{ name: "confirm", inputSchema: { type: "object" } }] };
    else if (body.method === "tools/call" && !body.params?.inputResponses) result = { resultType: "input_required", requestState: "opaque-state", inputRequests: {
      form: { method: "elicitation/create", params: { mode: "form", message: "Which project?", requestedSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] } } },
    } };
    else if (body.method === "tools/call") result = { resultType: "complete", content: [], structuredContent: body.params?.inputResponses };
    else return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Not supported" } });
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  } });
  await writeFile(join(chiliHome, "mcp.json"), JSON.stringify({ servers: { forms: { type: "http", url: server.url.href } } }));
  const registry = new InMemoryToolRegistry(); const queue = new DeferredUserInputQueue();
  let authorizationChecks = 0;
  const runtime = await createHostMcpRuntime({ cwd, chiliHome, registries: [registry], userInputQueue: queue, events: { publish: async (event) => {
    if (event.type === "user_input.requested") queue.resolve({ inputId: event.payload.inputId, answers: {
      [event.payload.questions[0]!.id]: [event.payload.questions[0]!.id === "consent" ? "Continue" : "Chili"],
    } });
  } } }, { list: async () => ({ roots: [], diagnostics: [] }), reload: async () => ({ roots: [], diagnostics: [] }), run: async () => { throw new Error("unused"); } });
  try {
    const toolContext: ChiliToolExecutionContext = { ...context, cwd, turnId: "turn_form" as TurnId, outputArtifactId: context.callId,
      assertCurrentAuthorization: async () => { authorizationChecks++; }, registerPersistedOutput: async () => {}, metadata: async () => {}, streamOutput: async () => {},
    };
    const tools = await registry.listForContext(toolContext);
    expect(tools).toHaveLength(1);
    expect(await tools[0]!.execute({}, toolContext)).toMatchObject({ structuredData: { form: { action: "accept", content: { project: "Chili" } } } });
    expect(authorizationChecks).toBe(1);
    expect(wire.filter((request) => request.method === "tools/call")).toHaveLength(2);
    expect(wire.at(-1)?.params?.requestState).toBe("opaque-state");
    expect(queue.list()).toEqual([]);
  } finally { await runtime.close(); server.stop(true); await rm(root, { recursive: true, force: true }); }
});
