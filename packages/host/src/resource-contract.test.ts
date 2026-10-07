import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import type { BashRunner } from "@chili/tools";
import { createUnsandboxedBashRunner } from "@chili/tools";
import { createChiliHost } from "./host.js";

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

test("Full Access executes without legacy file-deny configuration affecting the backend", async () => {
  const { root, ...options } = await fixture();
  const router = new ShellRouter("cat ./blocked.txt; printf changed > blocked.txt");
  const host = await createChiliHost({ ...options, modelRouter: router, permissionProfile: "full-access", mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  try {
    const session = await host.service.createSession();
    expect((await host.service.submitPrompt({ sessionId: session.sessionId, text: "Read and overwrite the file." })).status).toBe("completed");
    expect(await readFile(join(options.cwd, "blocked.txt"), "utf8")).toBe("changed");
    expect(JSON.stringify(router.requests.at(-1)?.messages)).toContain("private-resource-marker");
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);

test("automatic review rejects a command before an injected backend is called", async () => {
  const { root, ...options } = await fixture();
  let executions = 0;
  const bashRunner: BashRunner = { async run() { executions++; throw new Error("Unexpected shell execution"); } };
  const router = new ShellRouter("cat blocked.txt");
  const reviewerModelRouter: ModelRouter = { async *stream() {
    yield { type: "text_delta", text: JSON.stringify({ decision: "deny", reason: "Not part of the requested task." }) };
    yield { type: "finish", reason: "stop" };
  } };
  const host = await createChiliHost({ ...options, modelRouter: router, reviewerModelRouter, bashRunner,
    permissionProfile: "auto-review", mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  try {
    const session = await host.service.createSession();
    expect((await host.service.submitPrompt({ sessionId: session.sessionId, text: "Discuss the file." })).status).toBe("completed");
    expect(executions).toBe(0);
    expect(JSON.stringify(router.requests.at(-1)?.messages)).toContain("Not part of the requested task.");
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test("changing review instructions while a verdict is pending prevents execution", async () => {
  const { root, ...options } = await fixture();
  let executions = 0;
  let changeInstructions!: () => Promise<void>;
  const reviewerModelRouter: ModelRouter = { async *stream() {
    await changeInstructions();
    yield { type: "text_delta", text: JSON.stringify({ decision: "allow", reason: "Outdated verdict." }) };
    yield { type: "finish", reason: "stop" };
  } };
  const host = await createChiliHost({ ...options, modelRouter: new ShellRouter("printf approved"), reviewerModelRouter,
    permissionProfile: "auto-review", bashRunner: { async run() { executions++; throw new Error("Unexpected execution"); } },
    mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  changeInstructions = async () => { await host.permissions.set("auto-review", { reviewInstructions: "A newly changed review policy." }); };
  try {
    const session = await host.service.createSession();
    await host.service.submitPrompt({ sessionId: session.sessionId, text: "Run the controlled command." });
    expect(executions).toBe(0);
    expect(await host.store.pendingApprovals(session.sessionId)).toHaveLength(0);
    expect(host.permissions.get().reviewInstructions).toBe("A newly changed review policy.");
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test("an approved action creates no session or persistent grant for subsequent calls", async () => {
  const { root, ...options } = await fixture();
  let executions = 0;
  let reviews = 0;
  const backend = createUnsandboxedBashRunner();
  const reviewerModelRouter: ModelRouter = { async *stream() {
    reviews++;
    yield { type: "text_delta", text: JSON.stringify({ decision: reviews === 1 ? "allow" : "deny", reason: "Each call is reviewed independently." }) };
    yield { type: "finish", reason: "stop" };
  } };
  const host = await createChiliHost({ ...options, modelRouter: new ShellRouter("printf approved"), reviewerModelRouter,
    permissionProfile: "auto-review", bashRunner: { async run(request) { executions++; return backend.run(request); } },
    mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  try {
    const session = await host.service.createSession();
    for (const text of ["First requested run", "Repeat the run"]) {
      expect((await host.service.submitPrompt({ sessionId: session.sessionId, text })).status).toBe("completed");
    }
    expect(executions).toBe(1);
    expect(reviews).toBe(2);
    await expect(readFile(join(options.chiliHome, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await host.store.pendingApprovals(session.sessionId)).toHaveLength(0);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);
