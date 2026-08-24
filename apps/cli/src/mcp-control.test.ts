import { access, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import type { RuntimeCommandCatalog, RuntimeCommandNode } from "@chili/protocol";
import { InMemoryToolRegistry } from "@chili/tools";
import type { PromptCommandControl } from "@chili/server";
import { createCliMcpRuntime, type CliMcpRuntime } from "./mcp-control.js";

test("project stdio MCP servers do not auto-start without user trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-project-"));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "home");
  await mkdir(join(cwd, ".chili"), { recursive: true });
  await mkdir(chiliHome, { recursive: true });
  await writeFile(join(cwd, ".chili", "mcp.json"), JSON.stringify({
    mcpServers: {
      project_shell: {
        command: "sh",
        args: ["-c", "exit 99"],
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
    const status = await runtime.control.status?.();
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
  await mkdir(cwd, { recursive: true });
  await mkdir(chiliHome, { recursive: true });

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
  stubMcpPrompts(runtime, [{
    server: { name: "Docs" },
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
    const catalog = await runtime.commands.list();
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
      serverName: "Docs",
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
  stubMcpPrompts(runtime, [{
    server: { name: "docs" },
    prompt: { name: "review" },
  }], async () => {
    rendered = true;
    return { messages: [{ role: "user", content: "Review" }] };
  });

  try {
    const catalog = await runtime.commands.list();
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
  stubMcpPrompts(runtime, [
    { server: { name: "docs" }, prompt: { name: "Review Doc" } },
    { server: { name: "docs" }, prompt: { name: "review-doc" } },
  ]);

  try {
    const catalog = await runtime.commands.list();
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

function stubMcpPrompts(
  runtime: CliMcpRuntime,
  prompts: readonly unknown[],
  getPrompt: (serverName: string, promptName: string, args: Record<string, string>) => Promise<unknown> = async () => ({
    messages: [],
  }),
): void {
  const manager = (runtime as unknown as {
    manager: {
      listPrompts(): readonly unknown[];
      getPrompt(serverName: string, promptName: string, args: Record<string, string>): Promise<unknown>;
    };
  }).manager;
  manager.listPrompts = () => prompts;
  manager.getPrompt = getPrompt;
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
