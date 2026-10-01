import { access, mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import type {
  McpClient,
  McpDiagnostic,
  McpInitializeResult,
  McpPrompt,
  McpResource,
  McpServerConfig,
  McpServerState,
  McpTool,
} from "@chili/mcp";
import type {
  ChiliEvent,
  RuntimeCommandCatalog,
  RuntimeCommandNode,
  RuntimeMcpListResponse,
  RuntimeMcpStatusResponse,
  RuntimeMcpToolsResponse,
  SessionId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import { createToolSearchTool, InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import type { PromptCommandControl } from "@chili/server";
import { createCliMcpRuntime, type CliMcpRuntime } from "./mcp-control.js";

test("project stdio MCP servers do not auto-start without user trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-project-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  await mkdir(join(cwd, ".chili"), { recursive: true });
  await mkdir(chiliHome, { recursive: true });
  await writeFile(join(chiliHome, "mcp.json"), JSON.stringify({
    mcpServers: {
      project_shell: {
        command: "sh",
        args: ["-c", "exit 98"],
        enabled: false,
        trust: false,
      },
    },
  }), "utf8");
  await writeFile(join(cwd, ".chili", "mcp.json"), JSON.stringify({
    mcpServers: {
      project_shell: {
        command: "sh",
        args: ["-c", "exit 99"],
        enabled: true,
        trust: true,
      },
    },
  }), "utf8");

  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
  }, fakePromptCommands());

  try {
    const status = await scopedMcpControl(runtime).status?.({ cwd });
    expect(status?.servers[0]).toMatchObject({
      name: "project_shell",
      status: "disabled",
      enabled: false,
      transport: "stdio",
    });
    expect(status?.summary.disabled).toBe(1);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("same-name user trust allows a project stdio override to start", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-project-trusted-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  const marker = join(root, "project-started");
  await mkdir(join(cwd, ".chili"), { recursive: true });
  await mkdir(chiliHome, { recursive: true });
  await writeFile(join(chiliHome, "mcp.json"), JSON.stringify({
    mcpServers: {
      project_shell: {
        command: "sh",
        args: ["-c", "exit 98"],
        enabled: false,
        trust: true,
      },
    },
  }), "utf8");
  await writeFile(join(cwd, ".chili", "mcp.json"), JSON.stringify({
    mcpServers: {
      project_shell: {
        command: "sh",
        args: ["-c", `touch ${JSON.stringify(marker)}; exit 99`],
        enabled: true,
        trust: false,
      },
    },
  }), "utf8");

  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
  }, fakePromptCommands());

  try {
    const status = await scopedMcpControl(runtime).status?.({ cwd });
    expect(status?.servers[0]).toMatchObject({
      name: "project_shell",
      status: "error",
      enabled: true,
      transport: "stdio",
    });
    await access(marker);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed user trust-only config cannot authorize a project stdio server", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-project-malformed-trust-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  const marker = join(root, "project-started");
  await mkdir(join(cwd, ".chili"), { recursive: true });
  await mkdir(chiliHome, { recursive: true });
  await writeFile(join(chiliHome, "mcp.json"), JSON.stringify({
    mcpServers: {
      project_shell: { trust: true },
    },
  }), "utf8");
  await writeFile(join(cwd, ".chili", "mcp.json"), JSON.stringify({
    mcpServers: {
      project_shell: {
        command: "sh",
        args: ["-c", `touch ${JSON.stringify(marker)}; exit 99`],
        enabled: true,
        trust: true,
      },
    },
  }), "utf8");

  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
  }, fakePromptCommands());

  try {
    const status = await scopedMcpControl(runtime).status?.({ cwd });
    expect(status?.servers[0]).toMatchObject({
      name: "project_shell",
      status: "disabled",
      enabled: false,
      transport: "stdio",
    });
    await expect(access(marker)).rejects.toThrow();
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP workspace scope canonicalizes a missing tail and rejects files without exposing paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-missing-tail-"));
  const chiliHome = join(root, "home");
  const workspace = join(root, "workspace");
  const workspaceAlias = join(root, "workspace-link");
  const nonDirectory = join(root, "not-a-directory");
  await Promise.all([
    mkdir(chiliHome, { recursive: true }),
    mkdir(join(workspace, ".chili"), { recursive: true }),
  ]);
  await Promise.all([
    writeMcpConfig(join(workspace, ".chili", "mcp.json"), "project_docs"),
    symlink(workspace, workspaceAlias),
    writeFile(nonDirectory, "file", "utf8"),
  ]);

  const runtime = await createCliMcpRuntime({
    cwd: workspace,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
  }, fakePromptCommands());
  const control = scopedMcpControl(runtime);
  const missingTail = join(workspaceAlias, "future", "child");

  try {
    expect((await control.list({ cwd: missingTail })).servers.map((server) => server.name)).toEqual([
      "project_docs",
    ]);
    expect((await control.status?.({ cwd: missingTail }))?.summary).toMatchObject({
      total: 1,
      disabled: 1,
    });

    const error = await control.list({ cwd: nonDirectory }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("MCP workspace cwd is not a directory");
    expect((error as Error).message).not.toContain(nonDirectory);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("manual MCP connect mode loads config without starting stdio servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-manual-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  const marker = join(root, "started");
  await mkdir(cwd, { recursive: true });
  await mkdir(chiliHome, { recursive: true });
  await writeFile(join(chiliHome, "mcp.json"), JSON.stringify({
    mcpServers: {
      user_shell: {
        command: "sh",
        args: ["-c", `touch ${JSON.stringify(marker)}`],
        enabled: true,
      },
    },
  }), "utf8");

  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
  }, fakePromptCommands());

  try {
    const status = await runtime.control.status?.();
    expect(status?.servers[0]).toMatchObject({
      name: "user_shell",
      status: "stopped",
      enabled: true,
      transport: "stdio",
    });
    await expect(access(marker)).rejects.toThrow();
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP prompts extend the recursive command catalog and run by command ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-prompts-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  await mkdir(join(cwd, ".chili"), { recursive: true });
  await mkdir(chiliHome, { recursive: true });
  await writeFile(join(cwd, ".chili", "mcp.json"), JSON.stringify({
    mcpServers: {
      docs: { type: "http", url: "https://docs.example.test", enabled: false },
    },
  }), "utf8");

  const baseCatalog: RuntimeCommandCatalog = {
    roots: [promptRoot([commandNode({
      id: "prompt.project",
      name: "project",
      path: "/prompt project",
      source: "project",
      selectionMode: "drilldown",
      children: [],
    })])],
    diagnostics: [{ level: "warning", code: "base_warning", message: "Keep me" }],
  };
  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
  }, fakePromptCommands(baseCatalog));
  const promptCalls: unknown[] = [];
  await stubMcpPrompts(runtime, cwd, [{
    server: { name: "docs" },
    prompt: {
      name: "Review Doc",
      description: "Review a document",
      arguments: [{ name: "target", required: true }],
    },
  }], async (serverName, promptName, args) => {
    promptCalls.push({ serverName, promptName, args });
    return { messages: [{ role: "user", content: `Review ${args.target}` }] };
  });

  try {
    const catalog = await runtime.commands.list({ cwd });
    expect(findCommand(catalog.roots, "prompt.mcp.docs.review-doc")).toMatchObject({
      path: "/prompt mcp docs review-doc",
      source: "mcp",
      argumentMode: "required",
      argumentHint: "<target>",
      executionTarget: "prompt",
    });
    expect(catalog.diagnostics).toEqual(baseCatalog.diagnostics);
    expect(baseCatalog.roots[0]?.children.map((command) => command.id)).toEqual(["prompt.project"]);

    const result = await runtime.commands.run({
      commandId: "prompt.mcp.docs.review-doc",
      args: "README.md",
      cwd,
    });
    expect(result).toMatchObject({
      prompt: "USER: Review README.md",
      command: { id: "prompt.mcp.docs.review-doc", path: "/prompt mcp docs review-doc" },
      metadata: { commandId: "prompt.mcp.docs.review-doc", source: "mcp" },
    });
    expect(promptCalls).toEqual([{
      serverName: "docs",
      promptName: "Review Doc",
      args: { target: "README.md" },
    }]);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP prompt conflicts are diagnosed and rejected from catalog execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-prompt-conflict-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(chiliHome, { recursive: true });
  await writeMcpConfig(join(chiliHome, "mcp.json"), "docs");

  const baseMcp = commandNode({
    id: "prompt.project.mcp",
    name: "mcp",
    path: "/prompt mcp",
    source: "project",
    selectionMode: "drilldown",
    children: [],
  });
  const baseCatalog: RuntimeCommandCatalog = {
    roots: [promptRoot([baseMcp])],
    diagnostics: [],
  };
  let baseRunCount = 0;
  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
  }, fakePromptCommands(baseCatalog, async () => {
    baseRunCount += 1;
    throw new Error("base command not found");
  }));
  let rendered = false;
  await stubMcpPrompts(runtime, undefined, [{
    server: { name: "docs" },
    prompt: { name: "review" },
  }], async () => {
    rendered = true;
    return { messages: [{ role: "user", content: "Review" }] };
  });

  try {
    const catalog = await runtime.commands.list({ cwd });
    expect(catalog.roots[0]?.children.map((command: RuntimeCommandNode) => command.id)).toEqual(["prompt.project.mcp"]);
    expect(catalog.diagnostics).toContainEqual({
      level: "error",
      code: "duplicate_command_path",
      message: "Rejected prompt.mcp because /prompt mcp is already owned by prompt.project.mcp.",
      path: "/prompt mcp",
      commandIds: ["prompt.project.mcp", "prompt.mcp"],
    });

    await expect(runtime.commands.run({ commandId: "prompt.mcp.docs.review" }))
      .rejects.toThrow("base command not found");
    expect(baseRunCount).toBe(1);
    expect(rendered).toBe(false);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate MCP prompt paths retain command diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-prompt-diagnostics-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(chiliHome, { recursive: true });
  await writeMcpConfig(join(chiliHome, "mcp.json"), "docs");
  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
  }, fakePromptCommands());
  await stubMcpPrompts(runtime, undefined, [
    { server: { name: "docs" }, prompt: { name: "Review Doc" } },
    { server: { name: "docs" }, prompt: { name: "review-doc" } },
  ]);

  try {
    const catalog = await runtime.commands.list({ cwd });
    expect(catalog.diagnostics).toContainEqual({
      level: "error",
      code: "duplicate_command_path",
      message: "Rejected prompt.mcp.docs.review-doc because /prompt mcp docs review-doc is already owned by prompt.mcp.docs.review-doc.",
      path: "/prompt mcp docs review-doc",
      commandIds: ["prompt.mcp.docs.review-doc", "prompt.mcp.docs.review-doc"],
    });
    expect(findCommands(catalog.roots, "prompt.mcp.docs.review-doc")).toHaveLength(1);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP server views isolate project config by canonical workspace cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-workspaces-"));
  const chiliHome = join(root, "home");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const workspaceAlias = join(root, "workspace-a-link");
  await Promise.all([
    mkdir(chiliHome, { recursive: true }),
    mkdir(join(workspaceA, ".chili"), { recursive: true }),
    mkdir(join(workspaceB, ".chili"), { recursive: true }),
  ]);
  await Promise.all([
    writeMcpConfig(join(chiliHome, "mcp.json"), "user_global"),
    writeMcpConfig(join(workspaceA, ".chili", "mcp.json"), "a_only"),
    writeMcpConfig(join(workspaceB, ".chili", "mcp.json"), "b_only"),
    symlink(workspaceA, workspaceAlias),
  ]);

  const runtime = await createCliMcpRuntime({
    cwd: workspaceB,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
  }, fakePromptCommands());
  const control = scopedMcpControl(runtime);

  try {
    expect((await control.list()).servers.map((server) => server.name)).toEqual(["user_global"]);
    expect((await control.list({ cwd: workspaceA })).servers.map((server) => server.name)).toEqual([
      "user_global",
      "a_only",
    ]);
    expect((await control.list({ cwd: workspaceB })).servers.map((server) => server.name)).toEqual([
      "user_global",
      "b_only",
    ]);
    expect((await control.list({ cwd: workspaceAlias })).servers.map((server) => server.name)).toEqual([
      "user_global",
      "a_only",
    ]);
    await expect(control.tools?.("a_only", { cwd: workspaceB }))
      .rejects.toThrow("MCP server not found: a_only");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("project MCP tools resolve and execute only in their canonical workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-tool-workspaces-"));
  const chiliHome = join(root, "home");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const workspaceAlias = join(root, "workspace-a-link");
  await Promise.all([
    mkdir(chiliHome, { recursive: true }),
    mkdir(join(workspaceA, ".chili"), { recursive: true }),
    mkdir(join(workspaceB, ".chili"), { recursive: true }),
  ]);
  await Promise.all([
    writeMcpConfigs(join(chiliHome, "mcp.json"), ["user_global", "shared", "empty_override"]),
    writeMcpConfigs(join(workspaceA, ".chili", "mcp.json"), ["a_only", "shared", "empty_override"]),
    writeMcpConfigs(join(workspaceB, ".chili", "mcp.json"), ["b_only"]),
    symlink(workspaceA, workspaceAlias),
  ]);

  const registry = new InMemoryToolRegistry();
  registry.register(createToolSearchTool(registry));
  const runtime = await createCliMcpRuntime({
    cwd: workspaceB,
    chiliHome,
    registries: [registry],
    connectMode: "manual",
  }, fakePromptCommands());
  const calls: string[] = [];
  await stubMcpTools(runtime, undefined, {
    user_global: [{ name: "lookup", description: "global lookup" }],
    shared: [{ name: "lookup", description: "user shared lookup" }],
    empty_override: [{ name: "lookup", description: "user tool shadowed by an empty project server" }],
  }, async (serverName, toolName) => {
    calls.push(`user:${serverName}/${toolName}`);
    return { content: [{ type: "text", text: `user:${serverName}` }] };
  });
  await stubMcpTools(runtime, workspaceA, {
    a_only: [{ name: "lookup", description: "workspace A lookup" }],
    shared: [{ name: "lookup", description: "project shared lookup" }],
  }, async (serverName, toolName) => {
    calls.push(`a:${serverName}/${toolName}`);
    return { content: [{ type: "text", text: `a:${serverName}` }] };
  });
  await stubMcpTools(runtime, workspaceB, {
    b_only: [{ name: "lookup", description: "workspace B lookup" }],
  }, async (serverName, toolName) => {
    calls.push(`b:${serverName}/${toolName}`);
    return { content: [{ type: "text", text: `b:${serverName}` }] };
  });
  const executor = new ToolExecutor({
    registry,
    events: { publish: async (_event: ChiliEvent) => {} },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    createId: (prefix) => `${prefix}_mcp_scope`,
    now: () => 1 as TimestampMs,
  });

  try {
    const namesA = (await registry.listForContext(toolRegistryContext(workspaceA))).map((tool) => tool.name);
    const namesB = (await registry.listForContext(toolRegistryContext(workspaceB))).map((tool) => tool.name);
    const namesAlias = (await registry.listForContext(toolRegistryContext(workspaceAlias))).map((tool) => tool.name);
    expect(registry.list().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
    expect(namesA).toContain("mcp__a_only__lookup");
    expect(namesA).not.toContain("mcp__b_only__lookup");
    expect(namesA).not.toContain("mcp__empty_override__lookup");
    expect(namesB).toContain("mcp__b_only__lookup");
    expect(namesB).not.toContain("mcp__a_only__lookup");
    expect(namesB).toContain("mcp__empty_override__lookup");
    expect(namesAlias).toContain("mcp__a_only__lookup");
    expect((await registry.getForContext(
      "mcp__shared__lookup",
      toolRegistryContext(workspaceA),
    ))?.description).toContain("project shared lookup");
    expect((await registry.getForContext(
      "mcp__shared__lookup",
      toolRegistryContext(workspaceB),
    ))?.description).toContain("user shared lookup");

    const aResult = await executor.execute(toolExecuteInput("mcp__a_only__lookup", workspaceA));
    expect(aResult).toMatchObject({ status: "completed", result: { output: "a:a_only" } });
    const aliasResult = await executor.execute(toolExecuteInput("mcp__shared__lookup", workspaceAlias));
    expect(aliasResult).toMatchObject({ status: "completed", result: { output: "a:shared" } });
    const bSharedResult = await executor.execute(toolExecuteInput("mcp__shared__lookup", workspaceB));
    expect(bSharedResult).toMatchObject({ status: "completed", result: { output: "user:shared" } });
    const searchA = await executor.execute(toolExecuteInput("tool_search", workspaceA, { query: "a_only" }));
    expect(searchA).toMatchObject({ status: "completed" });
    if (searchA.status === "completed") expect(searchA.result.output).toContain("mcp__a_only__lookup");
    const searchB = await executor.execute(toolExecuteInput("tool_search", workspaceB, { query: "a_only" }));
    expect(searchB).toMatchObject({ status: "completed", result: { output: "(no matching tools)" } });
    const crossWorkspaceResult = await executor.execute(toolExecuteInput("mcp__a_only__lookup", workspaceB));
    expect(crossWorkspaceResult.status).toBe("failed");
    if (crossWorkspaceResult.status === "failed") {
      expect(crossWorkspaceResult.error.name).toBe("UnknownToolError");
    }
    expect(calls).toEqual([
      "a:a_only/lookup",
      "a:shared/lookup",
      "user:shared/lookup",
    ]);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP prompt catalogs and execution never cross workspace scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-prompt-workspaces-"));
  const chiliHome = join(root, "home");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const workspaceAlias = join(root, "workspace-a-link");
  await Promise.all([
    mkdir(chiliHome, { recursive: true }),
    mkdir(join(workspaceA, ".chili"), { recursive: true }),
    mkdir(join(workspaceB, ".chili"), { recursive: true }),
  ]);
  await Promise.all([
    writeMcpConfig(join(chiliHome, "mcp.json"), "user_global"),
    writeMcpConfig(join(workspaceA, ".chili", "mcp.json"), "a_only"),
    writeMcpConfig(join(workspaceB, ".chili", "mcp.json"), "b_only"),
    symlink(workspaceA, workspaceAlias),
  ]);

  const runtime = await createCliMcpRuntime({
    cwd: workspaceB,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
  }, fakePromptCommands());
  const rendered: string[] = [];
  await stubMcpPrompts(runtime, undefined, [{
    server: { name: "user_global" },
    prompt: { name: "global" },
  }], async (serverName) => {
    rendered.push(serverName);
    return { messages: [{ role: "user", content: "global" }] };
  });
  await stubMcpPrompts(runtime, workspaceA, [{
    server: { name: "a_only" },
    prompt: { name: "project" },
  }], async (serverName) => {
    rendered.push(serverName);
    return { messages: [{ role: "user", content: "workspace A" }] };
  });
  await stubMcpPrompts(runtime, workspaceB, [{
    server: { name: "b_only" },
    prompt: { name: "project" },
  }], async (serverName) => {
    rendered.push(serverName);
    return { messages: [{ role: "user", content: "workspace B" }] };
  });

  try {
    const globalCatalog = await runtime.commands.list();
    const catalogA = await runtime.commands.list({ cwd: workspaceA });
    const catalogB = await runtime.commands.list({ cwd: workspaceB });
    const aliasCatalog = await runtime.commands.list({ cwd: workspaceAlias });
    expect(findCommand(globalCatalog.roots, "prompt.mcp.user_global.global")).toBeDefined();
    expect(findCommand(globalCatalog.roots, "prompt.mcp.b_only.project")).toBeUndefined();
    expect(findCommand(catalogA.roots, "prompt.mcp.a_only.project")).toBeDefined();
    expect(findCommand(catalogA.roots, "prompt.mcp.b_only.project")).toBeUndefined();
    expect(findCommand(catalogB.roots, "prompt.mcp.b_only.project")).toBeDefined();
    expect(findCommand(catalogB.roots, "prompt.mcp.a_only.project")).toBeUndefined();
    expect(findCommand(aliasCatalog.roots, "prompt.mcp.a_only.project")).toBeDefined();

    await expect(runtime.commands.run({
      commandId: "prompt.mcp.a_only.project",
      cwd: workspaceB,
    })).rejects.toThrow("not found");
    expect(rendered).toEqual([]);

    const result = await runtime.commands.run({
      commandId: "prompt.mcp.a_only.project",
      cwd: workspaceA,
    });
    expect(result.prompt).toBe("USER: workspace A");
    expect(rendered).toEqual(["a_only"]);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP state errors are normalized before status descriptors and durable events", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-error-boundary-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  const events: ChiliEvent[] = [];
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(chiliHome, { recursive: true })]);
  await writeMcpConfig(join(chiliHome, "mcp.json"), "docs");
  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
    events: { publish: async (event) => { events.push(event); } },
  }, fakePromptCommands());

  try {
    const internal = mcpRuntimeInternals(runtime);
    const state = internal.userScope?.manager.listStates()[0];
    if (!state || !internal.userScope) throw new Error("test MCP state was not initialized");
    const secret = "sk-mcpBoundarySecret123456789";
    const loopback = "http://127.0.0.1:43123/private?access_token=mcpLoopbackSecret";
    const hostile = `Bearer ${secret} ${loopback} ${"\u0000\"\\\n".repeat(1_310_720)}`;
    state.status = "failed";
    state.error = Object.assign(new Error(hostile), {
      name: "RemoteMcpError",
      code: "TOKEN_INVALIDATED",
    });
    state.server.raw.description = "A normal, useful MCP server description.";

    const status = await scopedMcpControl(runtime).status?.();
    const descriptorJson = JSON.stringify(status);
    expect(status?.servers[0]).toMatchObject({
      name: "docs",
      status: "error",
      description: "A normal, useful MCP server description.",
    });
    expect(descriptorJson).not.toContain(secret);
    expect(descriptorJson).not.toContain("127.0.0.1");
    expect(descriptorJson).not.toContain("mcpLoopbackSecret");
    expect(descriptorJson).toContain("REDACTED");
    expect(descriptorJson).toContain("truncated from");
    expect(testJsonBytes(status)).toBeLessThanOrEqual(300 * 1024);

    events.length = 0;
    internal.publishStatusSnapshot(internal.userScope);
    const statusEvent = events.find((event) => event.type === "mcp.server_status_changed");
    expect(statusEvent?.type).toBe("mcp.server_status_changed");
    const eventJson = JSON.stringify(statusEvent);
    expect(eventJson).not.toContain(secret);
    expect(eventJson).not.toContain("127.0.0.1");
    expect(eventJson).not.toContain("mcpLoopbackSecret");
    expect(eventJson).toContain("truncated from");
    expect(testJsonBytes(statusEvent)).toBeLessThanOrEqual(80 * 1024);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP diagnostics and reload errors share the persistence-safe normalizer", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-diagnostic-boundary-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  const events: ChiliEvent[] = [];
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(chiliHome, { recursive: true })]);
  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
    events: { publish: async (event) => { events.push(event); } },
  }, fakePromptCommands());

  try {
    const internal = mcpRuntimeInternals(runtime);
    const scope = internal.userScope;
    if (!scope) throw new Error("test MCP scope was not initialized");
    const secret = "sk-mcpDiagnosticSecret123456789";
    const loopback = "http://localhost:44111/callback?token=mcpDiagnosticToken";
    const hostile = `Authorization: Basic ${secret} ${loopback} ${"\u0000\"\\\n".repeat(1_310_720)}`;

    events.length = 0;
    internal.publishDiagnostic({
      severity: "error",
      code: "connect_failed",
      message: hostile,
      path: "servers.docs",
      source: "user",
    });
    internal.publishDiagnostic({
      severity: "warning",
      code: "normal_warning",
      message: "A normal diagnostic remains useful.",
      path: "servers.docs",
      source: "user",
    });
    const diagnosticEvents = events.filter((event) => event.type === "mcp.diagnostic");
    expect(diagnosticEvents).toHaveLength(2);
    const hostileJson = JSON.stringify(diagnosticEvents[0]);
    expect(hostileJson).not.toContain(secret);
    expect(hostileJson).not.toContain("localhost:44111");
    expect(hostileJson).not.toContain("mcpDiagnosticToken");
    expect(hostileJson).toContain("REDACTED");
    expect(hostileJson).toContain("truncated from");
    expect(testJsonBytes(diagnosticEvents[0])).toBeLessThanOrEqual(20 * 1024);
    expect(diagnosticEvents[1]).toMatchObject({
      payload: { message: "A normal diagnostic remains useful." },
    });

    scope.loadErrors = [{ server: "docs", message: hostile }];
    internal.reloadUserScope = async () => {};
    internal.invalidateProjectScopes = async () => {};
    const reloaded = await runtime.control.reload?.();
    const reloadJson = JSON.stringify(reloaded);
    expect(reloadJson).not.toContain(secret);
    expect(reloadJson).not.toContain("localhost:44111");
    expect(reloadJson).not.toContain("mcpDiagnosticToken");
    expect(reloadJson).toContain("truncated from");
    expect(testJsonBytes(reloaded)).toBeLessThanOrEqual(300 * 1024);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP tool, prompt, and resource descriptors are recursively bounded and redacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-descriptor-boundary-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  const events: ChiliEvent[] = [];
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(chiliHome, { recursive: true })]);
  await writeMcpConfig(join(chiliHome, "mcp.json"), "docs");
  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
    events: { publish: async (event) => { events.push(event); } },
  }, fakePromptCommands());

  try {
    const internal = mcpRuntimeInternals(runtime);
    const state = internal.userScope?.manager.listStates()[0];
    if (!state) throw new Error("test MCP state was not initialized");
    const secret = "sk-mcpDescriptorSecret123456789";
    const loopback = "http://[::1]:45111/private?api_key=mcpDescriptorToken";
    const worstEscaped = "\u0000\"\\\n".repeat(1_310_720);
    state.tools = [
      {
        name: "normal_tool",
        description: "A normal tool description stays intact.",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
      {
        name: "hostile_tool",
        description: `Bearer ${secret} ${loopback}`,
        inputSchema: {
          type: "object",
          secret: `api_key=${secret}`,
          endpoint: loopback,
          nested: nestedDescriptor(12),
          escaped: worstEscaped,
        },
        annotations: { note: `access_token=${secret}`, callback: loopback },
      },
    ];
    state.prompts = [{
      name: "review",
      description: `Review safely. Bearer ${secret} ${loopback}`,
      arguments: [{ name: "target", description: `Target ${secret}`, required: true }],
    }];
    state.resources = [{
      uri: "https://docs.example.test/guide",
      name: "Guide",
      description: `Guide endpoint ${loopback} token=${secret}`,
      mimeType: "text/plain",
    }];

    const tools = await scopedMcpControl(runtime).tools?.("docs");
    const toolsJson = JSON.stringify(tools);
    expect(tools?.tools[0]?.description).toBe("A normal tool description stays intact.");
    expect(toolsJson).not.toContain(secret);
    expect(toolsJson).not.toContain("::1");
    expect(toolsJson).not.toContain("mcpDescriptorToken");
    expect(toolsJson).toContain("REDACTED");
    expect(toolsJson).toContain("omitted");
    expect(toolsJson).toContain("depth limit exceeded");
    expect(testJsonBytes(tools)).toBeLessThanOrEqual(300 * 1024);

    const resources = await runtime.resources.listResources({}, mcpResourceContext(cwd));
    const resourcesJson = JSON.stringify(resources);
    expect(resources[0]).toMatchObject({ uri: "https://docs.example.test/guide", name: "Guide" });
    expect(resourcesJson).not.toContain(secret);
    expect(resourcesJson).not.toContain("::1");

    events.length = 0;
    internal.publishToolsChanged(state.server, state.tools);
    internal.publishPromptsChanged(state.server, state.prompts);
    internal.publishResourcesChanged(state.server, state.resources);
    const descriptorsJson = JSON.stringify(events);
    expect(descriptorsJson).not.toContain(secret);
    expect(descriptorsJson).not.toContain("::1");
    expect(descriptorsJson).not.toContain("mcpDescriptorToken");
    expect(descriptorsJson).toContain("A normal tool description stays intact.");
    for (const event of events) expect(testJsonBytes(event)).toBeLessThanOrEqual(300 * 1024);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP descriptor catalogs fail closed for responses and mark truncated events", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-catalog-limits-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  const events: ChiliEvent[] = [];
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(chiliHome, { recursive: true })]);
  await writeMcpConfig(join(chiliHome, "mcp.json"), "docs");
  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
    events: { publish: async (event) => { events.push(event); } },
  }, fakePromptCommands());

  try {
    const internal = mcpRuntimeInternals(runtime);
    const state = internal.userScope?.manager.listStates()[0];
    if (!state) throw new Error("test MCP state was not initialized");
    state.tools = Array.from({ length: 129 }, (_, index) => ({
      name: `tool_${index}`,
      description: `Tool ${index}`,
    }));
    await expect(scopedMcpControl(runtime).tools?.("docs"))
      .rejects.toThrow("MCP tool descriptor exceeds the safe catalog limit.");

    events.length = 0;
    internal.publishToolsChanged(state.server, state.tools);
    const countEvent = events.find((event) => event.type === "mcp.tools_changed");
    expect(countEvent?.type).toBe("mcp.tools_changed");
    if (countEvent?.type === "mcp.tools_changed") {
      expect(countEvent.payload.toolCount).toBe(129);
      expect(countEvent.payload.tools).toHaveLength(128);
    }
    expect(events).toContainEqual(expect.objectContaining({
      type: "mcp.diagnostic",
      payload: expect.objectContaining({ code: "descriptor_catalog_truncated" }),
    }));

    state.tools = [{
      name: "oversized_item",
      description: "\t\"\\\n".repeat(2_048),
      inputSchema: wideStructuredDescriptor(),
      annotations: wideStructuredDescriptor(),
    }];
    await expect(scopedMcpControl(runtime).tools?.("docs"))
      .rejects.toThrow("MCP tool descriptor exceeds the safe catalog limit.");
    events.length = 0;
    internal.publishToolsChanged(state.server, state.tools);
    const itemEvent = events.find((event) => event.type === "mcp.tools_changed");
    expect(itemEvent?.type).toBe("mcp.tools_changed");
    if (itemEvent?.type === "mcp.tools_changed") {
      expect(itemEvent.payload.toolCount).toBe(1);
      expect(itemEvent.payload.tools).toHaveLength(0);
    }

    const escapedDescription = "\t\"\\\n".repeat(2_048);
    state.tools = Array.from({ length: 20 }, (_, index) => ({
      name: `wide_tool_${index}`,
      description: escapedDescription,
    }));
    await expect(scopedMcpControl(runtime).tools?.("docs"))
      .rejects.toThrow("MCP tool descriptor exceeds the safe catalog limit.");
    events.length = 0;
    internal.publishToolsChanged(state.server, state.tools);
    const aggregateEvent = events.find((event) => event.type === "mcp.tools_changed");
    expect(aggregateEvent?.type).toBe("mcp.tools_changed");
    if (aggregateEvent?.type === "mcp.tools_changed") {
      expect(aggregateEvent.payload.toolCount).toBe(20);
      expect(aggregateEvent.payload.tools.length).toBeLessThan(20);
      expect(testJsonBytes(aggregateEvent)).toBeLessThanOrEqual(300 * 1024);
    }
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP close is reentrant, observes disconnect rejection, and rejects every post-close surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-close-reentrant-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  const disconnect = deferred<void>();
  let disconnectCalls = 0;
  let closeFromDisconnect: Promise<void> | undefined;
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(chiliHome, { recursive: true })]);
  await writeEnabledMcpConfig(join(chiliHome, "mcp.json"), "docs");
  let runtime!: CliMcpRuntime;
  runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    createClient: (server) => fakeMcpClient(server, {
      close: () => {
        disconnectCalls += 1;
        closeFromDisconnect = runtime.close();
        return disconnect.promise;
      },
    }),
  }, fakePromptCommands());

  try {
    const first = runtime.close();
    const second = runtime.close();
    expect(second).toBe(first);
    expect(closeFromDisconnect).toBe(first);
    expect(disconnectCalls).toBe(1);

    disconnect.reject(new Error("controlled disconnect rejection"));
    const results = await Promise.allSettled([first, second]);
    expect(results).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]);
    expect(runtime.close()).toBe(first);
    expect(disconnectCalls).toBe(1);

    const context = mcpResourceContext(cwd);
    const closedOperations: Array<() => Promise<unknown>> = [
      () => runtime.control.list(),
      () => runtime.control.status?.() ?? Promise.resolve(),
      () => runtime.control.get?.("docs") ?? Promise.resolve(),
      () => runtime.control.reload?.() ?? Promise.resolve(),
      () => runtime.control.add?.({ name: "late", url: "https://late.example.test" }) ?? Promise.resolve(),
      () => runtime.control.remove?.("docs") ?? Promise.resolve(),
      () => runtime.control.tools?.("docs") ?? Promise.resolve(),
      () => runtime.control.auth?.("docs") ?? Promise.resolve(),
      () => runtime.control.logout?.("docs") ?? Promise.resolve(),
      () => Promise.resolve(runtime.resources.listResources({}, context)),
      () => Promise.resolve(runtime.resources.readResource({ serverName: "docs", uri: "docs://late" }, context)),
      () => Promise.resolve(runtime.prompts.renderPrompt({
        serverName: "docs",
        promptName: "late",
        arguments: {},
      }, { cwd })),
      () => runtime.commands.list({ cwd }),
      () => runtime.commands.reload({ cwd }),
      () => runtime.commands.run({ commandId: "late", cwd }),
    ];
    for (const operation of closedOperations) {
      await expect(Promise.resolve().then(operation)).rejects.toMatchObject({
        name: "HostMcpRuntimeClosedError",
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP close shares an admitted reload disconnect and prevents a replacement scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-reload-close-race-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  const disconnect = deferred<void>();
  let clientCount = 0;
  let disconnectCalls = 0;
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(chiliHome, { recursive: true })]);
  await writeEnabledMcpConfig(join(chiliHome, "mcp.json"), "docs");
  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    createClient: (server) => {
      clientCount += 1;
      return fakeMcpClient(server, {
        close: () => {
          disconnectCalls += 1;
          return disconnect.promise;
        },
      });
    },
  }, fakePromptCommands());

  try {
    const reload = runtime.control.reload?.();
    if (!reload) throw new Error("MCP reload is unavailable");
    await waitForTestCondition(() => disconnectCalls === 1);
    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(secondClose).toBe(firstClose);
    expect(disconnectCalls).toBe(1);

    disconnect.resolve();
    const [reloadResult, closeResult] = await Promise.allSettled([reload, firstClose]);
    expect(reloadResult).toMatchObject({
      status: "rejected",
      reason: { name: "HostMcpRuntimeClosedError" },
    });
    expect(closeResult).toEqual({ status: "fulfilled", value: undefined });
    expect(clientCount).toBe(1);
    expect(disconnectCalls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP close does not await a stuck background connect and contains its late completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-late-connect-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  const initialize = deferred<McpInitializeResult>();
  let disconnectCalls = 0;
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(chiliHome, { recursive: true })]);
  await writeEnabledMcpConfig(join(chiliHome, "mcp.json"), "docs");
  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "background",
    createClient: (server) => fakeMcpClient(server, {
      initialize: () => initialize.promise,
      close: async () => {
        disconnectCalls += 1;
      },
    }),
  }, fakePromptCommands());
  const state = mcpRuntimeInternals(runtime).userScope?.manager.listStates()[0];
  if (!state) throw new Error("test MCP state was not initialized");

  try {
    expect(state.status).toBe("connecting");
    await runtime.close();
    expect(disconnectCalls).toBe(1);
    expect(state.status).toBe("disconnected");

    initialize.resolve({});
    await initialize.promise;
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(state.status).toBe("disconnected");
    expect(disconnectCalls).toBe(1);
    await expect(runtime.control.list()).rejects.toMatchObject({ name: "HostMcpRuntimeClosedError" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP close does not await an admitted eager reconnect and rejects its late scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-late-eager-connect-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  const initialize = deferred<McpInitializeResult>();
  let initializeCalls = 0;
  let disconnectCalls = 0;
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(chiliHome, { recursive: true })]);
  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "eager",
    createClient: (server) => fakeMcpClient(server, {
      initialize: () => {
        initializeCalls += 1;
        return initialize.promise;
      },
      close: async () => {
        disconnectCalls += 1;
      },
    }),
  }, fakePromptCommands());

  let add: Promise<unknown> | undefined;
  try {
    add = runtime.control.add?.({
      name: "late",
      transport: "http",
      url: "https://late.example.test",
      enabled: true,
    });
    if (!add) throw new Error("MCP add is unavailable");
    await waitForTestCondition(() => initializeCalls === 1);
    const connectingScope = [...mcpRuntimeInternals(runtime).liveScopes]
      .find((scope) => scope.manager.listStates().some((state) => state.server.name === "late"));
    const state = connectingScope?.manager.listStates()[0];
    if (!state) throw new Error("test MCP reconnect scope was not initialized");
    expect(state.status).toBe("connecting");

    await runtime.close();
    expect(disconnectCalls).toBe(1);
    expect(state.status).toBe("disconnected");

    initialize.resolve({});
    const addResult = await Promise.allSettled([add]);
    expect(addResult).toMatchObject([{
      status: "rejected",
      reason: { name: "HostMcpRuntimeClosedError" },
    }]);
    expect(state.status).toBe("disconnected");
    expect(disconnectCalls).toBe(1);
  } finally {
    initialize.resolve({});
    await Promise.allSettled([
      ...(add ? [add] : []),
      runtime.close(),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP close drains accepted event publications and drops callbacks after admission closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-event-drain-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  const publication = deferred<void>();
  let publicationCalls = 0;
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(chiliHome, { recursive: true })]);
  await writeMcpConfig(join(chiliHome, "mcp.json"), "docs");
  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
    events: {
      publish: async () => {
        publicationCalls += 1;
        return publication.promise;
      },
    },
  }, fakePromptCommands());

  try {
    expect(publicationCalls).toBeGreaterThan(0);
    let closeSettled = false;
    const close = runtime.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    publication.resolve();
    await close;
    expect(closeSettled).toBe(true);
    const callsAtClose = publicationCalls;
    mcpRuntimeInternals(runtime).publishDiagnostic({
      severity: "warning",
      code: "late_callback",
      message: "must be dropped",
      path: "servers.docs",
      source: "user",
    });
    await Promise.resolve();
    expect(publicationCalls).toBe(callsAtClose);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakePromptCommands(
  catalog: RuntimeCommandCatalog = { roots: [], diagnostics: [] },
  run: PromptCommandControl["run"] = async () => {
    throw new Error("not found");
  },
): PromptCommandControl {
  return {
    async list() {
      return catalog;
    },
    async reload() {
      return this.list();
    },
    run,
  };
}

interface McpRuntimeTestScope {
  manager: { listStates(): McpServerState[] };
  loadErrors: Array<{ server?: string; message: string }>;
}

interface McpRuntimeTestInternals {
  userScope?: McpRuntimeTestScope;
  liveScopes: Set<McpRuntimeTestScope>;
  publishStatusSnapshot(scope: McpRuntimeTestScope): void;
  publishDiagnostic(diagnostic: McpDiagnostic): void;
  publishToolsChanged(server: McpServerConfig, tools: readonly McpTool[]): void;
  publishPromptsChanged(server: McpServerConfig, prompts: readonly McpPrompt[]): void;
  publishResourcesChanged(server: McpServerConfig, resources: readonly McpResource[]): void;
  reloadUserScope(): Promise<void>;
  invalidateProjectScopes(): Promise<void>;
}

function mcpRuntimeInternals(runtime: CliMcpRuntime): McpRuntimeTestInternals {
  return runtime as unknown as McpRuntimeTestInternals;
}

function mcpResourceContext(cwd: string) {
  return {
    sessionId: "session_mcp_descriptors" as SessionId,
    turnId: "turn_mcp_descriptors" as TurnId,
    callId: "tool_call_mcp_descriptors" as ToolCallId,
    cwd,
    signal: new AbortController().signal,
  };
}

function nestedDescriptor(depth: number): unknown {
  let value: unknown = { leaf: "kept" };
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

function wideStructuredDescriptor(): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 32 }, (_, index) => [
    `field_${index}`,
    "\t\"\\\n".repeat(512),
  ]));
}

function testJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function stubMcpPrompts(
  runtime: CliMcpRuntime,
  cwd: string | undefined,
  prompts: readonly unknown[],
  getPrompt: (serverName: string, promptName: string, args: Record<string, string>) => Promise<unknown> = async () => ({
    messages: [],
  }),
): Promise<void> {
  const implementation = runtime as unknown as {
    userScope?: { manager: StubMcpManager };
    projectScope(cwd: string): Promise<{ manager: StubMcpManager }>;
  };
  const manager = cwd === undefined
    ? implementation.userScope?.manager
    : (await implementation.projectScope(cwd)).manager;
  if (!manager) throw new Error("MCP manager scope was not initialized");
  const entries = prompts as ReadonlyArray<{ server: { name: string }; prompt: unknown }>;
  for (const state of manager.listStates()) {
    state.prompts = entries
      .filter((entry) => entry.server.name === state.server.name)
      .map((entry) => entry.prompt);
  }
  manager.getPrompt = getPrompt;
}

interface StubMcpManager {
  listStates(): Array<{
    server: { name: string };
    prompts: unknown[];
  }>;
  getPrompt(serverName: string, promptName: string, args: Record<string, string>): Promise<unknown>;
}

interface StubMcpTool {
  name: string;
  description?: string;
}

async function stubMcpTools(
  runtime: CliMcpRuntime,
  cwd: string | undefined,
  toolsByServer: Readonly<Record<string, readonly StubMcpTool[]>>,
  callTool: (serverName: string, toolName: string, input: unknown) => Promise<unknown>,
): Promise<void> {
  const implementation = runtime as unknown as {
    userScope?: { manager: StubMcpToolManager };
    projectScope(cwd: string): Promise<{ manager: StubMcpToolManager }>;
  };
  const manager = cwd === undefined
    ? implementation.userScope?.manager
    : (await implementation.projectScope(cwd)).manager;
  if (!manager) throw new Error("MCP manager scope was not initialized");
  for (const state of manager.listStates()) {
    state.tools = [...(toolsByServer[state.server.name] ?? [])];
  }
  manager.callTool = callTool;
}

interface StubMcpToolManager {
  listStates(): Array<{
    server: { name: string };
    tools: StubMcpTool[];
  }>;
  callTool(serverName: string, toolName: string, input: unknown): Promise<unknown>;
}

async function writeMcpConfig(path: string, serverName: string): Promise<void> {
  return writeMcpConfigs(path, [serverName]);
}

async function writeEnabledMcpConfig(path: string, serverName: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    mcpServers: {
      [serverName]: {
        type: "http",
        url: `https://${serverName.replaceAll("_", "-")}.example.test`,
        enabled: true,
      },
    },
  }), "utf8");
}

async function writeMcpConfigs(path: string, serverNames: readonly string[]): Promise<void> {
  await writeFile(path, JSON.stringify({
    mcpServers: Object.fromEntries(serverNames.map((serverName) => [serverName, {
      type: "http",
      url: `https://${serverName.replaceAll("_", "-")}.example.test`,
      enabled: false,
    }])),
  }), "utf8");
}

function fakeMcpClient(
  server: McpServerConfig,
  overrides: Partial<Pick<McpClient, "initialize" | "close">> = {},
): McpClient {
  return {
    server,
    initialize: overrides.initialize ?? (async () => ({})),
    async listTools() {
      return { tools: [] };
    },
    async callTool() {
      return { content: [] };
    },
    async listPrompts() {
      return { prompts: [] };
    },
    async listResources() {
      return { resources: [] };
    },
    async readResource(uri) {
      return { contents: [{ uri, text: "" }] };
    },
    async getPrompt() {
      return { messages: [] };
    },
    close: overrides.close ?? (async () => {}),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise(value as T | PromiseLike<T>);
    },
    reject(reason) {
      rejectPromise(reason);
    },
  };
}

async function waitForTestCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error("test condition did not become true");
}

function toolRegistryContext(cwd: string): { sessionId: SessionId; turnId: TurnId; cwd: string } {
  return {
    sessionId: "session_mcp_scope" as SessionId,
    turnId: "turn_mcp_scope" as TurnId,
    cwd,
  };
}

function toolExecuteInput(toolName: string, cwd: string, input: unknown = {}) {
  return {
    ...toolRegistryContext(cwd),
    toolName,
    input,
  };
}

interface ScopedMcpControl {
  list(input?: { cwd?: string }): Promise<RuntimeMcpListResponse>;
  status?(input?: { cwd?: string }): Promise<RuntimeMcpStatusResponse>;
  tools?(server: string, input?: { cwd?: string }): Promise<RuntimeMcpToolsResponse>;
  reload?(input?: { cwd?: string }): Promise<{
    reloaded: boolean;
    servers: RuntimeMcpListResponse["servers"];
    errors: Array<{ server?: string; message: string }>;
  }>;
}

function scopedMcpControl(runtime: CliMcpRuntime): ScopedMcpControl {
  return runtime.control as unknown as ScopedMcpControl;
}

function promptRoot(children: RuntimeCommandNode[]): RuntimeCommandNode {
  return commandNode({
    id: "prompt",
    name: "prompt",
    path: "/prompt",
    selectionMode: "drilldown",
    executionTarget: "prompt",
    children,
  });
}

function commandNode(
  input: Pick<RuntimeCommandNode, "id" | "name" | "path">
    & Partial<Omit<RuntimeCommandNode, "id" | "name" | "path">>,
): RuntimeCommandNode {
  return {
    title: input.name,
    description: input.name,
    group: "prompt",
    source: "builtin",
    argumentMode: "none",
    argumentHint: "",
    selectionMode: "execute",
    concurrency: "allow",
    hidden: false,
    enabled: true,
    executionTarget: "prompt",
    children: [],
    ...input,
  };
}

function findCommand(commands: readonly RuntimeCommandNode[], id: string): RuntimeCommandNode | undefined {
  return findCommands(commands, id)[0];
}

function findCommands(commands: readonly RuntimeCommandNode[], id: string): RuntimeCommandNode[] {
  return commands.flatMap((command) => [
    ...(command.id === id ? [command] : []),
    ...findCommands(command.children, id),
  ]);
}
