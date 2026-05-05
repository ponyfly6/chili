import { expect, test } from "bun:test";
import type {
  McpCallToolResult,
  McpClient,
  McpGetPromptResult,
  McpInitializeResult,
  McpListPromptsResult,
  McpListResourcesResult,
  McpListToolsResult,
  McpReadResourceResult,
  McpUnsubscribe,
} from "./client.js";
import type { McpConfig, McpServerConfig } from "./config.js";
import { McpClientManager } from "./manager.js";

test("manager connects fake clients and refreshes tools on tools_changed", async () => {
  const server: McpServerConfig = {
    name: "local",
    type: "stdio",
    command: "node",
    args: ["server.js"],
    enabled: true,
    required: false,
    trust: false,
    includeTools: ["read_file", "write_file"],
    excludeTools: ["write_file"],
    source: "user",
    raw: {},
  };
  const config: McpConfig = { servers: { local: server } };
  const client = new FakeMcpClient(server);
  const changed: string[][] = [];
  const manager = new McpClientManager({
    config,
    createClient: () => client,
    onToolsChanged: (event) => changed.push(event.tools.map((tool) => tool.tool.name)),
  });

  client.tools = [{ name: "read_file" }, { name: "write_file" }, { name: "shell" }];
  await manager.connect();

  expect(manager.getState("local")?.status).toBe("connected");
  expect(manager.listTools().map((tool) => tool.tool.name)).toEqual(["read_file"]);

  client.tools = [{ name: "read_file" }, { name: "search" }];
  client.emitToolsChanged();
  await eventually(() => {
    expect(changed).toEqual([["read_file"]]);
  });
  expect(manager.listTools().map((tool) => tool.tool.name)).toEqual(["read_file"]);
});

test("manager treats unsupported prompts and resources as empty capabilities", async () => {
  const server: McpServerConfig = {
    name: "tools_only",
    type: "stdio",
    command: "node",
    args: ["server.js"],
    enabled: true,
    required: true,
    trust: false,
    source: "user",
    raw: {},
  };
  const client = new FakeMcpClient(server);
  client.tools = [{ name: "search" }];
  client.promptsError = Object.assign(new Error("Method not found"), { code: -32601 });
  client.resourcesError = Object.assign(new Error("resources/list not implemented"), { code: -32601 });
  const manager = new McpClientManager({
    config: { servers: { tools_only: server } },
    createClient: () => client,
  });

  await manager.connect();

  expect(manager.getState("tools_only")?.status).toBe("connected");
  expect(manager.listTools().map((tool) => tool.tool.name)).toEqual(["search"]);
  expect(manager.listPrompts()).toEqual([]);
  expect(manager.listResources()).toEqual([]);
});

test("manager follows pagination for tools, prompts, and resources", async () => {
  const server = serverConfig("paged");
  const client = new FakeMcpClient(server);
  client.toolPages = [
    { tools: [{ name: "first" }], nextCursor: "1" },
    { tools: [{ name: "second" }] },
  ];
  client.promptPages = [
    { prompts: [{ name: "review" }], nextCursor: "1" },
    { prompts: [{ name: "summarize" }] },
  ];
  client.resourcePages = [
    { resources: [{ uri: "file:///a" }], nextCursor: "1" },
    { resources: [{ uri: "file:///b" }] },
  ];
  const manager = new McpClientManager({
    config: { servers: { paged: server } },
    createClient: () => client,
  });

  await manager.connect();

  expect(manager.listTools().map((tool) => tool.tool.name)).toEqual(["first", "second"]);
  expect(manager.listPrompts().map((prompt) => prompt.prompt.name)).toEqual(["review", "summarize"]);
  expect(manager.listResources().map((resource) => resource.resource.uri)).toEqual(["file:///a", "file:///b"]);
});

test("manager closes a client when connection fails", async () => {
  const server = serverConfig("broken");
  const client = new FakeMcpClient(server);
  client.initializeError = new Error("boom");
  const manager = new McpClientManager({
    config: { servers: { broken: server } },
    createClient: () => client,
  });

  await manager.connect();

  expect(manager.getState("broken")?.status).toBe("failed");
  expect(client.closeCount).toBe(1);
});

function serverConfig(name: string): McpServerConfig {
  return {
    name,
    type: "stdio",
    command: "node",
    args: ["server.js"],
    enabled: true,
    required: false,
    trust: false,
    source: "user",
    raw: {},
  };
}

class FakeMcpClient implements McpClient {
  tools: McpListToolsResult["tools"] = [];
  toolPages: McpListToolsResult[] | undefined;
  promptPages: McpListPromptsResult[] | undefined;
  resourcePages: McpListResourcesResult[] | undefined;
  initializeError: unknown;
  closeCount = 0;
  promptsError: unknown;
  resourcesError: unknown;
  private toolsChanged: (() => void) | undefined;

  constructor(readonly server: McpServerConfig) {}

  initialize(): Promise<McpInitializeResult> {
    if (this.initializeError) return Promise.reject(this.initializeError);
    return Promise.resolve({ capabilities: { tools: { listChanged: true } } });
  }

  listTools(options?: { cursor?: string }): Promise<McpListToolsResult> {
    if (this.toolPages) return Promise.resolve(page(this.toolPages, options?.cursor));
    return Promise.resolve({ tools: this.tools });
  }

  callTool(): Promise<McpCallToolResult> {
    return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
  }

  listPrompts(options?: { cursor?: string }): Promise<McpListPromptsResult> {
    if (this.promptsError) return Promise.reject(this.promptsError);
    if (this.promptPages) return Promise.resolve(page(this.promptPages, options?.cursor));
    return Promise.resolve({ prompts: [] });
  }

  listResources(options?: { cursor?: string }): Promise<McpListResourcesResult> {
    if (this.resourcesError) return Promise.reject(this.resourcesError);
    if (this.resourcePages) return Promise.resolve(page(this.resourcePages, options?.cursor));
    return Promise.resolve({ resources: [] });
  }

  readResource(): Promise<McpReadResourceResult> {
    return Promise.resolve({ contents: [] });
  }

  getPrompt(): Promise<McpGetPromptResult> {
    return Promise.resolve({ messages: [] });
  }

  onToolsChanged(handler: () => void): McpUnsubscribe {
    this.toolsChanged = handler;
    return () => {
      this.toolsChanged = undefined;
    };
  }

  emitToolsChanged(): void {
    this.toolsChanged?.();
  }

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }
}

function page<T>(pages: readonly T[], cursor: string | undefined): T {
  const index = cursor ? Number.parseInt(cursor, 10) : 0;
  const value = pages[index];
  if (!value) throw new Error(`missing page ${cursor ?? "0"}`);
  return value;
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}
