import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChiliMemoryDirectories, type ModelRouter, type ModelStreamEvent, type ModelStreamInput } from "@chili/core";
import type { SessionId } from "@chili/protocol";
import { createChiliHost } from "./host.js";

class MemoryFileReader implements ModelRouter {
  readonly captured: ModelStreamInput[] = [];
  private readonly steps = new Map<string, number>();
  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    this.captured.push(input);
    const step = (this.steps.get(input.sessionId) ?? 0) + 1;
    this.steps.set(input.sessionId, step);
    if (step === 1) {
      yield { type: "tool_call", name: "code_mode", input: { code: "text(ALL_TOOLS.map(tool => tool.name));" } };
    } else if (step === 2) {
      const file = join(memoryLocation(input, "Current project Markdown"), "reconnect.md");
      yield { type: "tool_call", name: "bash", input: { command: `if test -f ${quote(file)}; then cat ${quote(file)}; else printf '%s' 'No saved file'; fi` } };
    } else yield { type: "text_delta", text: "done" };
    yield { type: "finish", reason: step < 3 ? "tool_use" : "stop" };
  }
}

test("Host exposes only active profile Memory paths and reads ordinary Markdown without creating a tree or registering a Memory tool", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chili-host-memory-")));
  const cwd = join(root, "repo");
  const profileA = join(root, "profile-a");
  const profileB = join(root, "profile-b");
  const fact = "Quartz reconnect uses exponential backoff";
  await mkdir(cwd, { recursive: true });
  await mkdir(join(profileA, "skills", "quartz"), { recursive: true });
  await writeFile(join(profileA, "skills", "quartz", "SKILL.md"), "---\nname: quartz\ndescription: Quartz profile skill\n---\nQuartz instructions\n");
  let seeded = false;
  try {
    for (const [profile, expected] of [[profileA, true], [profileA, true], [profileB, false]] as const) {
      const router = new MemoryFileReader();
      const reviews: ModelStreamInput[] = [];
      const host = await createChiliHost({ cwd, chiliHome: profile, model: "fake", permissionProfile: "auto-review", modelRouter: router,
        reviewerModelRouter: approvingReviewer(reviews), mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
      try {
        const directories = await resolveChiliMemoryDirectories({ cwd, chiliHome: host.identity.profilePath, projectRoot: host.identity.projectRoot, projectId: host.identity.projectId });
        if (profile === profileA && !seeded) {
          await mkdir(directories.project, { recursive: true });
          await writeFile(join(directories.project, "reconnect.md"), fact);
          seeded = true;
        } else if (profile === profileB) await expect(access(directories.root)).rejects.toThrow();
        const session = await host.service.createSession();
        expect((await host.service.submitPrompt({ sessionId: session.sessionId, text: "Read saved reconnect guidance if useful." })).status).toBe("completed");
        expect(router.captured).toHaveLength(3);
        expect(JSON.stringify(router.captured[0]!.messages)).not.toContain(fact);
        expect(memoryLocation(router.captured[0]!, "Navigation root")).toBe(directories.root);
        expect(memoryLocation(router.captured[0]!, "Personal Markdown")).toBe(directories.personal);
        expect(memoryLocation(router.captured[0]!, "Current project Markdown")).toBe(directories.project);
        const final = router.captured.at(-1)!;
        expect(final.system.join("\n")).not.toContain(expected ? profileB : profileA);
        const results = final.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool_result");
        expect(results.every((part) => !part.error)).toBe(true);
        const catalog = JSON.parse(results[0]!.output) as string[];
        expect(catalog).not.toContain("memory");
        expect(catalog).not.toContain("save_memory");
        expect(catalog).toEqual(expect.arrayContaining(["read", "grep", "edit", "write", "bash"]));
        expect(results.at(-1)!.output.includes(fact)).toBe(expected);
        expect(JSON.stringify(final.contextualUser ?? []).includes("Quartz profile skill")).toBe(expected);
        expect(JSON.stringify(final.contextualUser ?? [])).not.toContain(fact);
        expect(reviews.some((request) => reviewAction(request).toolName === "bash")).toBe(true);
        if (!expected) await expect(access(directories.root)).rejects.toThrow();
      } finally { await host.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Host does not automatically load project rules after observing file targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-host-rules-"));
  const cwd = join(root, "repo");
  await mkdir(join(cwd, ".chili", "rules"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "app.ts"), "export const app = true;\n");
  await writeFile(join(cwd, "src", "AGENTS.md"), "Known source subtree instructions.\n");
  await writeFile(join(cwd, ".chili", "rules", "source.md"), "---\npaths: [src/**]\nalwaysApply: false\n---\nApply Quartz source conventions.\n");
  const requests: ModelStreamInput[] = [];
  const router: ModelRouter = { async *stream(input) {
    requests.push(input);
    if (requests.length === 1) yield { type: "tool_call", name: "read", input: { file_path: "src/app.ts" } };
    else yield { type: "text_delta", text: "done" };
    yield { type: "finish", reason: requests.length === 1 ? "tool_use" : "stop" };
  } };
  try {
    const host = await createChiliHost({ cwd, chiliHome: join(root, "profile"), model: "fake", permissionProfile: "full-access", modelRouter: router, mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
    try {
      const session = await host.service.createSession();
      expect((await host.service.submitPrompt({ sessionId: session.sessionId, text: "Read the app source." })).status).toBe("completed");
      expect((await host.service.submitPrompt({ sessionId: session.sessionId, text: "Continue with the app." })).status).toBe("completed");
      for (const request of requests) {
        expect(JSON.stringify(request)).not.toContain("Apply Quartz source conventions.");
        expect(JSON.stringify(request)).not.toContain("Known source subtree instructions.");
      }
    } finally { await host.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Memory paths do not expand ordinary file access or a child Agent's write scope", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chili-memory-scope-")));
  const cwd = join(root, "repo");
  await mkdir(cwd, { recursive: true });
  const requests: ModelStreamInput[] = [];
  let personalFile = "";
  let rootSession: SessionId;
  let directFileAttempt: "read" | "write" | undefined;
  const model: ModelRouter = { async *stream(input) {
    requests.push(input);
    const step = requests.filter((request) => request.sessionId === input.sessionId).length;
    if (directFileAttempt) {
      yield { type: "tool_call", name: directFileAttempt, input: { filePath: personalFile, ...(directFileAttempt === "write" ? { content: "forbidden direct write" } : {}) } };
      yield { type: "finish", reason: "tool_use" };
      return;
    }
    if (input.sessionId === rootSession) {
      if (step === 1) yield { type: "tool_call", name: "tool_search", input: { query: "select:agent_spawn" } };
      else if (step === 2) yield { type: "tool_call", name: "agent_spawn", input: { name: "reader", prompt: "Try to save the requested fact within your existing scope." } };
      else yield { type: "text_delta", text: "done" };
      yield { type: "finish", reason: step < 3 ? "tool_use" : "stop" };
    } else {
      if (step === 1) yield { type: "tool_call", name: "bash", input: { command: `printf '%s' 'forbidden child write' > ${quote(personalFile)}` } };
      else yield { type: "text_delta", text: "done" };
      yield { type: "finish", reason: step === 1 ? "tool_use" : "stop" };
    }
  } };
  const host = await createChiliHost({ cwd, chiliHome: join(root, "profile"), model: "fake", permissionProfile: "auto-review", modelRouter: model,
    reviewerModelRouter: approvingReviewer([]), mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  try {
    const directories = await resolveChiliMemoryDirectories({ cwd, chiliHome: host.identity.profilePath, projectRoot: host.identity.projectRoot, projectId: host.identity.projectId });
    await mkdir(directories.personal, { recursive: true });
    personalFile = join(directories.personal, "preference.md");
    await writeFile(personalFile, "original preference");
    for (const operation of ["read", "write"] as const) {
      directFileAttempt = operation;
      const session = await host.service.createSession();
      const result = await host.service.submitPrompt({ sessionId: session.sessionId, text: `Try a direct ${operation} of the supplied Memory path.` });
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(String(result.error)).toContain("inside the workspace");
    }
    directFileAttempt = undefined;
    rootSession = (await host.service.createSession()).sessionId;
    expect(await host.service.submitPrompt({ sessionId: rootSession, text: "Delegate this save attempt with no write scope.", toolPolicy: { writeScope: [], executeScope: ["*"] } })).toMatchObject({ status: "completed" });
    await host.waitForAgents();
    expect(await readFile(personalFile, "utf8")).toBe("original preference");
    const children = await host.store.childSessions(rootSession);
    expect(children).toHaveLength(1);
    expect(children[0]!.agent?.policy.writeScope).toEqual([]);
    const childResults = (await host.store.messages(children[0]!.id)).flatMap((message) => message.parts).filter((part) => part.type === "tool_result");
    expect(childResults).toHaveLength(1);
    expect(childResults[0]!.error ?? childResults[0]!.output).toMatch(/scope|sandbox|permitted|Permission denied/i);
    const childRequest = requests.find((request) => request.sessionId === children[0]!.id)!;
    expect(memoryLocation(childRequest, "Personal Markdown")).toBe(directories.personal);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

function memoryLocation(input: ModelStreamInput, label: string): string {
  const line = input.system.join("\n").split("\n").find((value) => value.startsWith(`- ${label}: `));
  if (!line) throw new Error(`Missing ${label}`);
  return JSON.parse(line.slice(`- ${label}: `.length)) as string;
}

function quote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

function approvingReviewer(requests: ModelStreamInput[]): ModelRouter {
  return { async *stream(input) {
    requests.push(input);
    yield { type: "text_delta", text: JSON.stringify({ decision: "allow", reason: "Requested fixture file operation." }) };
    yield { type: "finish", reason: "stop" };
  } };
}

function reviewAction(input: ModelStreamInput): { toolName: string } {
  const text = input.messages.findLast((message) => message.role === "user")?.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
  return JSON.parse(text).action;
}
