import { access, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { InMemoryToolRegistry } from "@chili/tools";
import type { PromptCommandControl } from "@chili/server";
import { createCliMcpRuntime } from "./mcp-control.js";

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

function fakePromptCommands(): PromptCommandControl {
  return {
    async list() {
      return { commands: [], diagnostics: [], directories: [], skippedConflicts: [] };
    },
    async reload() {
      return this.list();
    },
    async run() {
      throw new Error("not found");
    },
  };
}
