import { access, mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  RuntimeCommandCatalog,
  RuntimeCommandNode,
  RuntimeMcpListResponse,
  RuntimeMcpStatusResponse,
  RuntimeMcpToolsResponse,
  SessionId,
  TimestampMs,
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
  await stubMcpPrompts(runtime, cwd, [{
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
  const runtime = await createCliMcpRuntime({
    cwd,
    chiliHome,
    registries: [new InMemoryToolRegistry()],
    connectMode: "manual",
  }, fakePromptCommands());
  await stubMcpPrompts(runtime, cwd, [
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
  manager.listPrompts = () => prompts;
  manager.getPrompt = getPrompt;
}

interface StubMcpManager {
  listPrompts(): readonly unknown[];
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

async function writeMcpConfigs(path: string, serverNames: readonly string[]): Promise<void> {
  await writeFile(path, JSON.stringify({
    mcpServers: Object.fromEntries(serverNames.map((serverName) => [serverName, {
      type: "http",
      url: `https://${serverName.replaceAll("_", "-")}.example.test`,
      enabled: false,
    }])),
  }), "utf8");
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
