import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import { addChiliMemoryEntry, listChiliMemoryEntries } from "@chili/core";
import { createChiliHost } from "./host.js";

class MemoryHostRouter implements ModelRouter {
  readonly captured: ModelStreamInput[] = [];
  constructor(private readonly writeMemory: boolean) {}
  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    this.captured.push(JSON.parse(JSON.stringify(input)) as ModelStreamInput);
    if (this.writeMemory && this.captured.length === 1) {
      yield { type: "tool_call", name: "memory", input: { operation: "add", scope: "project", text: "Quartz reconnect uses exponential backoff" } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "finish", reason: "stop" };
  }
}

test("Host execution and later model requests share profile-scoped Memory and skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-host-memory-"));
  const cwd = join(root, "repo");
  const profileA = join(root, "profile-a");
  const profileB = join(root, "profile-b");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(profileA, "skills", "quartz"), { recursive: true });
  await writeFile(join(profileA, "skills", "quartz", "SKILL.md"), "---\nname: quartz\ndescription: Quartz profile skill\n---\nQuartz instructions\n");
  try {
    const writer = new MemoryHostRouter(true);
    const first = await createChiliHost({ cwd, chiliHome: profileA, model: "fake", modelRouter: writer, mcpConnectMode: "manual", askApproval: async () => ({ action: "allow_once" }), staleTurnRecoveryIntervalMs: false });
    try {
      const session = await first.service.createSession();
      const outcome = await first.service.submitPrompt({ sessionId: session.sessionId, text: "Remember the Quartz reconnect preference." });
      expect(outcome).toMatchObject({ status: "completed" });
      const entries = await listChiliMemoryEntries({ cwd, chiliHome: profileA, projectRoot: first.identity.projectRoot, projectId: first.identity.projectId });
      expect(entries.map((entry) => entry.text)).toEqual(["Quartz reconnect uses exponential backoff"]);
      expect((await first.service.submitPrompt({ sessionId: session.sessionId, text: "Explain Quartz reconnect." })).status).toBe("completed");
      const actual = JSON.stringify(writer.captured.at(-1));
      expect(actual).toContain("Quartz reconnect uses exponential backoff");
      expect(actual).toContain("Quartz profile skill");
    } finally { await first.close(); }
    const reader = new MemoryHostRouter(false);
    const second = await createChiliHost({ cwd, chiliHome: profileB, model: "fake", modelRouter: reader, mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
    try {
      const session = await second.service.createSession();
      expect((await second.service.submitPrompt({ sessionId: session.sessionId, text: "Explain Quartz reconnect." })).status).toBe("completed");
      const actual = JSON.stringify(reader.captured.at(-1));
      expect(actual).not.toContain("Quartz reconnect uses exponential backoff");
      expect(actual).not.toContain("Quartz profile skill");
    } finally { await second.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

class ScopedRuleRouter implements ModelRouter {
  readonly requests: string[] = [];
  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    this.requests.push(JSON.stringify({ system: input.system, developer: input.developer, contextualUser: input.contextualUser }));
    if (this.requests.length === 1) {
      yield { type: "tool_call", name: "read", input: { file_path: "src/app.ts" } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "finish", reason: "stop" };
  }
}

test("Host loads applicable path rules on the next turn from this session's actual file targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-host-rules-"));
  const cwd = join(root, "repo");
  await mkdir(join(cwd, ".chili", "rules"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "app.ts"), "export const app = true;\n");
  await writeFile(join(cwd, "src", "AGENTS.md"), "Known source subtree instructions.\n");
  await writeFile(join(cwd, ".chili", "rules", "source.md"), "---\npaths: [src/**]\nalwaysApply: false\n---\nApply Quartz source conventions.\n");
  const router = new ScopedRuleRouter();
  try {
    const host = await createChiliHost({ cwd, chiliHome: join(root, "profile"), model: "fake", modelRouter: router, mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
    try {
      const session = await host.service.createSession();
      expect((await host.service.submitPrompt({ sessionId: session.sessionId, text: "Read the app source." })).status).toBe("completed");
      expect(router.requests[0]).not.toContain("Apply Quartz source conventions.");
      expect((await host.service.submitPrompt({ sessionId: session.sessionId, text: "Continue with the app." })).status).toBe("completed");
      expect(router.requests.at(-1)).toContain("Apply Quartz source conventions.");
      expect(router.requests.at(-1)).toContain("Known source subtree instructions.");
      const other = await host.service.createSession();
      expect((await host.service.submitPrompt({ sessionId: other.sessionId, text: "Discuss the project." })).status).toBe("completed");
      expect(router.requests.at(-1)).not.toContain("Apply Quartz source conventions.");
    } finally { await host.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Host rechecks current memory.read policy before automatically loading Memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-host-memory-deny-"));
  const cwd = join(root, "repo");
  await mkdir(join(cwd, ".chili"), { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "Project instructions remain separate from Memory.\n");
  const router = new MemoryHostRouter(false);
  try {
    const host = await createChiliHost({ cwd, chiliHome: join(root, "profile"), model: "fake", modelRouter: router, mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
    try {
      await addChiliMemoryEntry({ cwd, chiliHome: host.identity.profilePath, projectRoot: host.identity.projectRoot, projectId: host.identity.projectId, text: "Quartz memory secret preference" });
      const allowed = await host.service.createSession();
      expect((await host.service.submitPrompt({ sessionId: allowed.sessionId, text: "Explain Quartz memory." })).status).toBe("completed");
      expect(JSON.stringify(router.captured.at(-1))).toContain("Quartz memory secret preference");
      await writeFile(join(cwd, ".chili", "config.toml"), '[permissions]\ndeny = ["memory.read(*)"]\n');
      const denied = await host.service.createSession();
      expect((await host.service.submitPrompt({ sessionId: denied.sessionId, text: "Explain Quartz memory." })).status).toBe("completed");
      const actual = JSON.stringify(router.captured.at(-1));
      expect(actual).not.toContain("Quartz memory secret preference");
      expect(actual).toContain("Project instructions remain separate from Memory.");
      expect(actual).toContain("memory_read_not_authorized");
    } finally { await host.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

class MultiProjectMemoryRouter implements ModelRouter {
  readonly requests: { sessionId: string; context: string }[] = [];
  private readonly started = new Set<string>();
  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    this.requests.push({ sessionId: input.sessionId, context: JSON.stringify(input.contextualUser ?? []) });
    const text = input.messages.flatMap((message) => message.role === "user" ? message.parts : [])
      .filter((part) => part.type === "text").map((part) => part.text).at(-1) ?? "";
    if (!this.started.has(input.sessionId)) {
      this.started.add(input.sessionId);
      yield { type: "tool_call", name: "memory", input: { operation: "add", scope: "project", text: text.includes("project A") ? "Quartz project A preference" : "Quartz project B preference" } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "finish", reason: "stop" };
  }
}

test("one Host keeps project Memory isolated across sessions with different working directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-host-project-memory-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  await mkdir(repoA, { recursive: true });
  await mkdir(repoB, { recursive: true });
  const router = new MultiProjectMemoryRouter();
  try {
    const host = await createChiliHost({ cwd: repoB, chiliHome: join(root, "profile"), model: "fake", modelRouter: router, mcpConnectMode: "manual", askApproval: async () => ({ action: "allow_once" }), staleTurnRecoveryIntervalMs: false });
    try {
      const a = await host.service.createSession({ cwd: repoA });
      expect((await host.service.submitPrompt({ sessionId: a.sessionId, text: "Remember project A Quartz preference." })).status).toBe("completed");
      const b = await host.service.createSession({ cwd: repoB });
      expect((await host.service.submitPrompt({ sessionId: b.sessionId, text: "Remember project B Quartz preference." })).status).toBe("completed");
      expect(router.requests.filter((request) => request.sessionId === b.sessionId).every((request) => !request.context.includes("Quartz project A preference"))).toBe(true);
      expect((await host.service.submitPrompt({ sessionId: a.sessionId, text: "Explain Quartz project preferences." })).status).toBe("completed");
      expect(router.requests.at(-1)?.context).toContain("Quartz project A preference");
      expect(router.requests.at(-1)?.context).not.toContain("Quartz project B preference");
      expect((await host.service.submitPrompt({ sessionId: b.sessionId, text: "Explain Quartz project preferences." })).status).toBe("completed");
      expect(router.requests.at(-1)?.context).toContain("Quartz project B preference");
      expect(router.requests.at(-1)?.context).not.toContain("Quartz project A preference");
    } finally { await host.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
