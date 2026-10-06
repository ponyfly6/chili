import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import type { BashRunner } from "@chili/tools";
import { createUnsandboxedBashRunner } from "@chili/tools";
import { createChiliHost } from "./host.js";
import { loadHostConfig } from "./config.js";

class ShellRouter implements ModelRouter {
  readonly requests: ModelStreamInput[] = [];
  private readonly prompts = new Set<string>();
  constructor(private readonly command: string) {}
  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    this.requests.push(input);
    const promptId = input.messages.findLast((message) => message.role === "user")?.id ?? input.sessionId;
    if (!this.prompts.has(promptId)) {
      this.prompts.add(promptId);
      yield { type: "tool_call", name: "bash", input: { command: this.command } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "finish", reason: "stop" };
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chili-host-resource-"));
  const cwd = join(root, "workspace");
  await mkdir(join(cwd, ".chili"), { recursive: true });
  await writeFile(join(cwd, "blocked.txt"), "private-resource-marker\n");
  await writeFile(join(cwd, ".chili", "config.toml"), '[permissions]\ndeny = ["read(blocked.txt)", "write(blocked.txt)"]\n');
  return { root, cwd, chiliHome: join(root, "profile") };
}

test("Host full-access shell enforces current file denials through the real backend", async () => {
  if (process.platform !== "darwin") return;
  const { root, ...options } = await fixture();
  const router = new ShellRouter("cat ./blocked.txt; printf changed > blocked.txt");
  const host = await createChiliHost({ ...options, modelRouter: router, permissionProfile: "full-access", mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  try {
    const session = await host.service.createSession();
    expect((await host.service.submitPrompt({ sessionId: session.sessionId, text: "Read and overwrite the file." })).status).toBe("completed");
    expect(await readFile(join(options.cwd, "blocked.txt"), "utf8")).toBe("private-resource-marker\n");
    const modelHistory = JSON.stringify(router.requests.at(-1)?.messages);
    expect(modelHistory).not.toContain("private-resource-marker");
    expect(modelHistory).toContain("Operation not permitted");
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);

test("Host cannot bypass file denials using an opaque injected shell backend", async () => {
  const { root, ...options } = await fixture();
  let executions = 0;
  const bashRunner: BashRunner = { async run() { executions++; throw new Error("Unexpected shell execution"); } };
  const router = new ShellRouter("cat blocked.txt");
  const host = await createChiliHost({ ...options, modelRouter: router, bashRunner, permissionProfile: "full-access", mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  try {
    const session = await host.service.createSession();
    expect((await host.service.submitPrompt({ sessionId: session.sessionId, text: "Read the file." })).status).toBe("completed");
    expect(executions).toBe(0);
    expect(JSON.stringify(router.requests.at(-1)?.messages)).toMatch(/resource denies|resource deny|file resource/i);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test("Host validates allow_always before persisting and rejects a new deny without effects", async () => {
  const { root, ...options } = await fixture();
  const projectConfig = join(options.cwd, ".chili", "config.toml");
  await writeFile(projectConfig, "");
  let executions = 0;
  const host = await createChiliHost({ ...options, modelRouter: new ShellRouter("printf approved"),
    bashRunner: { async run() { executions++; throw new Error("Unexpected execution"); } },
    askApproval: async () => {
      await writeFile(projectConfig, '[permissions]\ndeny = ["bash(*)"]\n');
      return { action: "allow_always" };
    }, mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  try {
    const session = await host.service.createSession();
    await host.service.submitPrompt({ sessionId: session.sessionId, text: "Run the controlled command." });
    expect(executions).toBe(0);
    expect((await loadHostConfig(options.cwd, options)).userPermissions).toEqual([]);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test("Host persistent approval executes once approved and config removal revokes the same session grant", async () => {
  const { root, ...options } = await fixture();
  await writeFile(join(options.cwd, ".chili", "config.toml"), "");
  let executions = 0;
  let approvals = 0;
  const backend = createUnsandboxedBashRunner();
  const host = await createChiliHost({ ...options, modelRouter: new ShellRouter("printf approved"),
    bashRunner: { async run(request) { executions++; return backend.run(request); } },
    askApproval: async () => ({ action: ++approvals === 1 ? "allow_always" : "deny" }),
    mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  try {
    const session = await host.service.createSession();
    for (const text of ["First approved run", "Reuse saved approval"]) {
      expect((await host.service.submitPrompt({ sessionId: session.sessionId, text })).status).toBe("completed");
    }
    expect(executions).toBe(2);
    expect(approvals).toBe(1);
    await writeFile(join(options.chiliHome, "config.toml"), '[permissions]\nallow = []\n');
    await host.service.submitPrompt({ sessionId: session.sessionId, text: "Run after approval removal" });
    expect(executions).toBe(2);
    expect(approvals).toBe(2);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);
