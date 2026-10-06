import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryToolRegistry, createMcpResourceReadTool, ToolExecutor, PolicyApprovalBroker, type ChiliToolExecutionContext } from "@chili/tools";
import { type McpClient, type McpServerConfig } from "@chili/mcp";
import { type SessionId, type TurnId, type ToolCallId } from "@chili/protocol";
import { createHostMcpRuntime } from "./mcp-control.js";

test("manual Host connect, dynamic schema changes and disconnect invalidate executable definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-controls-"));
  const cwd = join(root, "workspace");
  const chiliHome = join(root, "profile");
  await mkdir(cwd);
  await mkdir(chiliHome);
  await writeFile(join(chiliHome, "mcp.json"), JSON.stringify({ servers: { local: { command: "fixture", args: [] } } }));
  const registry = new InMemoryToolRegistry();
  let client: ReturnType<typeof fakeClient> | undefined;
  let starts = 0;
  const runtime = await createHostMcpRuntime({
    cwd, chiliHome, registries: [registry], connectMode: "manual",
    createClient(server) { starts += 1; client = fakeClient(server); return client; },
  }, { list: async () => ({ roots: [], diagnostics: [] }), reload: async () => ({ roots: [], diagnostics: [] }), run: async () => { throw new Error("unused"); } });
  const context: ChiliToolExecutionContext = {
    cwd, sessionId: "s" as SessionId, turnId: "t" as TurnId, callId: "c" as ToolCallId,
    outputArtifactId: "c" as ToolCallId, signal: new AbortController().signal,
    registerPersistedOutput: async () => {},
    metadata: async () => {}, streamOutput: async () => {},
    requestApproval: async () => ({ action: "allow_once" }),
  };
  try {
    expect(starts).toBe(0);
    expect(await registry.listForContext(context)).toEqual([]);
    expect(await runtime.control.connect!("local")).toMatchObject({ status: "running", toolCount: 1 });
    const original = (await registry.listForContext(context))[0]!;
    expect(await original.execute({ old: "value" }, context)).toMatchObject({ structuredData: { accepted: true } });
    client!.schema = { type: "object", required: ["new"], properties: { new: { type: "number" } } };
    client!.changed?.();
    await Bun.sleep(0);
    const replacement = (await registry.listForContext(context))[0]!;
    expect(replacement.revision).not.toBe(original.revision);
    await expect(original.execute({ old: "value" }, context)).rejects.toThrow("definition or connection changed");
    expect(client!.calls).toBe(1);
    expect(await runtime.control.disconnect!("local")).toMatchObject({ status: "stopped", toolCount: 0 });
    expect(await registry.listForContext(context)).toEqual([]);
    await expect(replacement.execute({ new: 3 }, context)).rejects.toThrow("not connected");
    expect(await runtime.control.connect!("local")).toMatchObject({ status: "running" });
    await expect(replacement.execute({ new: 3 }, context)).rejects.toThrow("definition or connection changed");
    client!.schema = { type: "object", properties: { token: { const: "sk-inputSchemaSecret123456789" } } };
    client!.changed?.();
    await Bun.sleep(0);
    await expect(registry.listForContext(context)).rejects.toThrow("without changing its definition");
    client!.closed?.();
    expect((await runtime.control.get!("local"))?.status).toBe("stopped");
    expect(await registry.listForContext(context)).toEqual([]);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

function fakeClient(server: McpServerConfig) {
  const state: McpClient & { calls: number; schema: unknown; changed: (() => void) | undefined; closed: (() => void) | undefined } = {
    server, calls: 0, schema: { type: "object" } as unknown,
    changed: undefined as (() => void) | undefined,
    closed: undefined as (() => void) | undefined,
    initialize: async () => ({}),
    listTools: async () => ({ tools: [{ name: "run", inputSchema: state.schema }] }),
    listPrompts: async () => ({ prompts: [] }),
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    getPrompt: async () => ({ messages: [] }),
    callTool: async () => { state.calls += 1; return { structuredContent: { accepted: true } }; },
    onToolsChanged(handler: () => void) { state.changed = handler; return () => { state.changed = undefined; }; },
    onClose(handler: () => void) { state.closed = handler; return () => { state.closed = undefined; }; },
    close: async () => {},
  };
  return state;
}


test("MCP resource approvals are target-bound and a reload during approval cannot retarget the read", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-resource-"));
  const cwd = join(root, "workspace");
  const chiliHome = join(root, "profile");
  await mkdir(cwd);
  await mkdir(chiliHome);
  const configPath = join(chiliHome, "mcp.json");
  const configure = (name: string) => writeFile(configPath, JSON.stringify({ servers: { same: { type: "http", url: `https://${name}.invalid/mcp` } } }));
  await configure("first");
  const registry = new InMemoryToolRegistry();
  const reads: string[] = [];
  const runtime = await createHostMcpRuntime({
    cwd, chiliHome, registries: [registry],
    createClient(server) {
      return {
        ...fakeClient(server),
        listResources: async () => ({ resources: [{ uri: "fixture://same" }] }),
        readResource: async (uri) => {
          const target = server.type === "stdio" ? server.command : server.url;
          reads.push(target);
          return { contents: [{ uri, text: target }] };
        },
      };
    },
  }, { list: async () => ({ roots: [], diagnostics: [] }), reload: async () => ({ roots: [], diagnostics: [] }), run: async () => { throw new Error("unused"); } });
  registry.register(createMcpResourceReadTool(runtime.resources));
  let approvals = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const executor = new ToolExecutor({
    registry, events: { publish: async () => {} },
    approvals: new PolicyApprovalBroker({ ask: async () => {
      approvals += 1;
      if (approvals === 3) { entered(); await blocked; }
      return { action: "allow_session" };
    } }),
  });
  const run = () => executor.execute({ sessionId: "resource-session" as SessionId, turnId: "turn" as TurnId,
    toolName: "mcp_resource_read", input: { serverName: "same", uri: "fixture://same", resourceIdentity: "forged", revision: "forged" }, cwd });
  try {
    expect((await run()).status).toBe("completed");
    await configure("second");
    await runtime.control.reload!();
    expect((await run()).status).toBe("completed");
    expect(approvals).toBe(2);
    await configure("third");
    await runtime.control.reload!();
    const pending = run();
    await waiting;
    await configure("fourth");
    await runtime.control.reload!();
    release();
    const result = await pending;
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error.message).toContain("target changed");
    expect(reads).toEqual(["https://first.invalid/mcp", "https://second.invalid/mcp"]);
  } finally {
    release();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP resource reads recheck policy after asynchronous Host scope resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-resource-revocation-"));
  const cwd = join(root, "workspace");
  const chiliHome = join(root, "profile");
  await mkdir(cwd);
  await mkdir(chiliHome);
  await writeFile(join(chiliHome, "mcp.json"), JSON.stringify({ servers: { same: { type: "http", url: "https://fixture.invalid/mcp" } } }));
  const registry = new InMemoryToolRegistry();
  let reads = 0;
  const runtime = await createHostMcpRuntime({
    cwd, chiliHome, registries: [registry],
    createClient(server) {
      return {
        ...fakeClient(server),
        listResources: async () => ({ resources: [{ uri: "fixture://same" }] }),
        readResource: async (uri) => { reads += 1; return { contents: [{ uri, text: "private" }] }; },
      };
    },
  }, { list: async () => ({ roots: [], diagnostics: [] }), reload: async () => ({ roots: [], diagnostics: [] }), run: async () => { throw new Error("unused"); } });
  registry.register(createMcpResourceReadTool(runtime.resources));
  let denied = false;
  let approvals = 0;
  const executor = new ToolExecutor({
    registry, events: { publish: async () => {} },
    approvals: new PolicyApprovalBroker({
      rulesetsForRequest: () => denied ? [[{ permission: "mcp_resource_read", pattern: "*", action: "deny" }]] : [],
      ask: async () => { approvals += 1; return { action: "allow_once" }; },
    }),
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  // Pause only the actual resource execution's async scope lookup, after the
  // executor's final authorization check; preparation and registry checks run normally.
  const internals = runtime as unknown as { scopeView(cwd?: string): Promise<unknown> };
  const scopeView = internals.scopeView.bind(runtime);
  const readResource = runtime.resources.readResource.bind(runtime.resources);
  let pauseRead = false;
  internals.scopeView = async (scopeCwd) => {
    const view = await scopeView(scopeCwd);
    if (pauseRead) { pauseRead = false; entered(); await blocked; }
    return view;
  };
  runtime.resources.readResource = (input, context) => {
    pauseRead = true;
    return readResource(input, context);
  };
  try {
    const pending = executor.execute({ sessionId: "resource-session" as SessionId, turnId: "turn" as TurnId,
      toolName: "mcp_resource_read", input: { serverName: "same", uri: "fixture://same" }, cwd });
    await waiting;
    expect(approvals).toBe(1);
    denied = true;
    release();
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(reads).toBe(0);
  } finally {
    release();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
