import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChiliMemoryEntry, listChiliMemoryEntries, type ModelRouter, type ModelStreamEvent, type ModelStreamInput } from "@chili/core";
import type { PreparedModelRequest, SessionId } from "@chili/protocol";
import { createChiliHost, type ChiliHost } from "./host.js";
import { resolveHostExecutionIdentity } from "./identity.js";

test("Host refreshes Memory revision and deletion between tool calls in one submitted prompt", async () => {
  const workspace = await fixture();
  const requests: ModelStreamInput[] = [];
  let memoryId = "";
  const original = "Quartz original reconnect preference";
  const revised = "Quartz revised reconnect preference";
  const model: ModelRouter = {
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      requests.push(input);
      const call = requests.length;
      if (call === 1) yield { type: "tool_call", name: "tool_search", input: { query: "select:memory" } };
      if (call === 2) yield { type: "tool_call", name: "memory", input: { operation: "put", scope: "project", id: memoryId, expectedRevision: 1, text: revised } };
      if (call === 3) yield { type: "tool_call", name: "memory", input: { operation: "remove", scope: "project", id: memoryId, expectedRevision: 2 } };
      if (call >= 4) yield { type: "text_delta", text: "done" };
      yield { type: "finish", reason: call < 4 ? "tool_use" : "stop" };
    },
  };
  const host = await createChiliHost({ ...workspace.options, modelRouter: model });
  try {
    const memoryOptions = memoryOptionsForHost(host);
    memoryId = (await addChiliMemoryEntry({ ...memoryOptions, text: original })).id;
    const { sessionId } = await host.service.createSession();
    const result = await host.service.submitPrompt({ sessionId, text: "Update the Quartz reconnect preference, then forget it." });
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(4);
    expect(referenceText(requests[0]!)).toContain(original);
    expect(referenceText(requests[1]!)).toContain(original);
    expect(referenceText(requests[2]!)).toContain(revised);
    expect(referenceText(requests[2]!)).not.toContain(original);
    expect(referenceText(requests[3]!)).not.toContain(original);
    expect(referenceText(requests[3]!)).not.toContain(revised);
    expect(await listChiliMemoryEntries(memoryOptions)).toEqual([]);

    const prepared = await preparedRequests(host, sessionId);
    expect(prepared).toHaveLength(4);
    prepared.forEach((request, index) => expectPreparedMatches(request, requests[index]!));
    const memorySources = prepared.map((request) => request.sources.find((source) => source.metadata?.memoryId === memoryId));
    expect(memorySources.map((source) => source?.metadata?.memoryRevision)).toEqual([1, 1, 2, undefined]);
    expect(memorySources[0]).toMatchObject({ kind: "contextual_user", status: "included", metadata: { source: "memory", trust: "project" } });
    expect(memorySources[2]?.version).not.toBe(memorySources[0]?.version);
    expect(prepared[0]!.contextualUser.join("\n")).toContain(original);
    expect(prepared[0]!.contextualUser.join("\n")).not.toContain(revised);
    const inspected = await host.service.inspectPrompt({ sessionId, includeContent: true });
    expect(inspected.preparedRequest?.contentVersion).toBe(prepared[3]!.contentVersion);
    expect(inspected.fragments.some((fragment) => fragment.metadata?.memoryId === memoryId)).toBe(false);
  } finally {
    await host.close();
    await workspace.cleanup();
  }
});

test("Host applies new file targets immediately and reloads changed rules and mentioned skills without duplicate injection", async () => {
  const workspace = await fixture();
  const rulePath = join(workspace.options.cwd, ".chili", "rules", "source.md");
  const skillPath = join(workspace.options.chiliHome, "skills", "quartz", "SKILL.md");
  const oldRule = "QUARTZ_RULE_VERSION_ONE";
  const newRule = "QUARTZ_RULE_VERSION_TWO";
  const oldSkill = "QUARTZ_SKILL_VERSION_ONE";
  const newSkill = "QUARTZ_SKILL_VERSION_TWO";
  const subtreeRule = "QUARTZ_SUBTREE_INSTRUCTION";
  await mkdir(join(workspace.options.cwd, ".chili", "rules"), { recursive: true });
  await mkdir(join(workspace.options.cwd, "src"), { recursive: true });
  await mkdir(join(workspace.options.chiliHome, "skills", "quartz"), { recursive: true });
  await writeFile(join(workspace.options.cwd, "src", "app.ts"), "export const app = true;\n");
  await writeFile(join(workspace.options.cwd, "src", "AGENTS.md"), subtreeRule);
  await writeFile(rulePath, pathRule(oldRule));
  await writeFile(skillPath, skill(oldSkill));
  const requests: ModelStreamInput[] = [];
  const model: ModelRouter = {
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      requests.push(input);
      const call = requests.length;
      // External edits between requests must invalidate material, even when the
      // source has the same length and the submitted user prompt is unchanged.
      if (call === 2) {
        await writeFile(rulePath, pathRule(newRule));
        await writeFile(skillPath, skill(newSkill));
      }
      if (call === 3) {
        await rm(rulePath);
        await rm(skillPath);
      }
      if (call < 4) yield { type: "tool_call", name: "read", input: { file_path: "src/app.ts" } };
      else yield { type: "text_delta", text: "done" };
      yield { type: "finish", reason: call < 4 ? "tool_use" : "stop" };
    },
  };
  const host = await createChiliHost({ ...workspace.options, modelRouter: model });
  try {
    const { sessionId } = await host.service.createSession();
    const result = await host.service.submitPrompt({
      sessionId, text: "Read the app using $quartz and $quartz twice.",
      skillMentions: [{ name: "quartz", path: skillPath }, { name: "quartz", path: skillPath }],
    });
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(4);
    expect(referenceText(requests[0]!)).not.toContain(oldRule);
    expect(referenceText(requests[0]!)).not.toContain(subtreeRule);
    expect(referenceText(requests[1]!)).toContain(oldRule);
    expect(referenceText(requests[1]!)).toContain(subtreeRule);
    expect(referenceText(requests[2]!)).toContain(newRule);
    expect(referenceText(requests[2]!)).not.toContain(oldRule);
    expect(referenceText(requests[3]!)).not.toContain(oldRule);
    expect(referenceText(requests[3]!)).not.toContain(newRule);
    expect(referenceText(requests[2]!)).toContain(newSkill);
    expect(referenceText(requests[2]!)).not.toContain(oldSkill);
    expect(referenceText(requests[3]!)).not.toContain(newSkill);
    for (const request of requests) {
      expect(occurrences(referenceText(request), oldSkill) + occurrences(referenceText(request), newSkill)).toBeLessThanOrEqual(1);
      expect(occurrences(referenceText(request), subtreeRule)).toBeLessThanOrEqual(1);
      expect(request.system.join("\n") + (request.developer ?? []).join("\n")).not.toContain("QUARTZ_");
    }
    expect(occurrences(referenceText(requests[0]!), oldSkill)).toBe(1);
    const prepared = await preparedRequests(host, sessionId);
    expect(prepared).toHaveLength(4);
    const ruleSources = prepared.map((request) => request.sources.find((source) => String(source.metadata?.path).endsWith("/.chili/rules/source.md")));
    expect(ruleSources[0]).toBeUndefined();
    expect(ruleSources[1]).toMatchObject({ kind: "contextual_user", status: "included", metadata: { source: "project", ruleType: "path_scoped" } });
    expect(ruleSources[2]?.version).not.toBe(ruleSources[1]?.version);
    expect(ruleSources[3]).toBeUndefined();
    for (const [index, request] of prepared.entries()) {
      expectPreparedMatches(request, requests[index]!);
      expect(request.sources.filter((source) => source.metadata?.kind === "skill_body")).toHaveLength(index < 3 ? 1 : 0);
    }
    const other = await host.service.createSession();
    await host.service.submitPrompt({ sessionId: other.sessionId, text: "Discuss Quartz without opening files." });
    expect(referenceText(requests.at(-1)!)).not.toContain(subtreeRule);
  } finally {
    await host.close();
    await workspace.cleanup();
  }
});

test("root and child Agents share profile Memory and skill roles while keeping projects and session file targets isolated", async () => {
  const workspace = await fixture();
  const otherCwd = join(workspace.root, "other-project");
  const profileSkill = "QUARTZ_SHARED_PROFILE_SKILL";
  await mkdir(otherCwd, { recursive: true });
  await mkdir(join(workspace.options.chiliHome, "skills", "quartz"), { recursive: true });
  await writeFile(join(workspace.options.chiliHome, "skills", "quartz", "SKILL.md"), skill(profileSkill));
  await writeFile(join(workspace.options.cwd, "AGENTS.md"), "QUARTZ_PROJECT_A_RULE");
  await writeFile(join(otherCwd, "AGENTS.md"), "QUARTZ_PROJECT_B_RULE");
  const requests: ModelStreamInput[] = [];
  const model: ModelRouter = {
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      requests.push(input);
      yield { type: "text_delta", text: "done" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const host = await createChiliHost({ ...workspace.options, modelRouter: model });
  try {
    const identityB = await resolveHostExecutionIdentity({ cwd: otherCwd, chiliHome: workspace.options.chiliHome });
    const shared = await addChiliMemoryEntry({ ...memoryOptionsForHost(host), scope: "user", text: "Quartz shared user preference" });
    const a = await addChiliMemoryEntry({ ...memoryOptionsForHost(host), text: "Quartz project A preference" });
    const b = await addChiliMemoryEntry({ cwd: otherCwd, chiliHome: identityB.profilePath, projectRoot: identityB.projectRoot, projectId: identityB.projectId, text: "Quartz project B preference" });
    const rootA = await host.service.createSession();
    const rootB = await host.service.createSession({ cwd: otherCwd });
    for (const root of [rootA, rootB]) {
      expect((await host.service.submitPrompt({ sessionId: root.sessionId, text: "Apply $quartz to Quartz preferences." })).status).toBe("completed");
      const agents = host.agents.forSession(root.sessionId);
      const spawned = await agents.spawnAgent({ name: "reader", prompt: "Apply $quartz to Quartz preferences." });
      expect((await agents.waitAgent({ ...spawned, timeoutMs: 5_000 })).input.outcome).toBe("completed");
    }
    await host.waitForAgents();
    expect(requests).toHaveLength(4);
    const childrenA = await host.store.childSessions(rootA.sessionId);
    const childrenB = await host.store.childSessions(rootB.sessionId);
    expect(childrenA).toHaveLength(1);
    expect(childrenB).toHaveLength(1);
    for (const [root, child, expected, forbidden, rule, identity] of [
      [rootA.sessionId, childrenA[0]!.id, a, b, "QUARTZ_PROJECT_A_RULE", host.identity],
      [rootB.sessionId, childrenB[0]!.id, b, a, "QUARTZ_PROJECT_B_RULE", identityB],
    ] as const) {
      for (const sessionId of [root, child]) {
        const request = requests.find((candidate) => candidate.sessionId === sessionId)!;
        expect(referenceText(request)).toContain(shared.text);
        expect(referenceText(request)).toContain(expected.text);
        expect(referenceText(request)).not.toContain(forbidden.text);
        expect(referenceText(request)).toContain(rule);
        expect(occurrences(referenceText(request), profileSkill)).toBe(1);
        const privileged = request.system.join("\n") + (request.developer ?? []).join("\n");
        expect(privileged).not.toContain(shared.text);
        expect(privileged).not.toContain(profileSkill);
        const [prepared] = await preparedRequests(host, sessionId);
        expectPreparedMatches(prepared!, request);
        expect(prepared!.executionIdentity).toMatchObject({ profileId: host.identity.profileId, projectId: identity.projectId });
        expect(prepared!.sources.find((source) => source.metadata?.memoryId === expected.id)).toMatchObject({ kind: "contextual_user", status: "included" });
        expect(prepared!.sources.find((source) => source.metadata?.memoryId === forbidden.id)).toBeUndefined();
      }
    }
  } finally {
    await host.close();
    await workspace.cleanup();
  }
});

test("Host records bounded source material and the exact actual roles without promoting project text", async () => {
  const workspace = await fixture();
  const instruction = `QUARTZ_INSTRUCTION_BEGIN\n${"a".repeat(40_000)}\nQUARTZ_INSTRUCTION_END`;
  await writeFile(join(workspace.options.cwd, "AGENTS.md"), instruction);
  await mkdir(join(workspace.options.cwd, ".chili", "rules"), { recursive: true });
  await writeFile(join(workspace.options.cwd, ".chili", "rules", "always.md"), "QUARTZ_ALWAYS_RULE");
  const requests: ModelStreamInput[] = [];
  const model: ModelRouter = {
    resolveRequestLimits: () => ({ contextWindowTokens: 64_000, requestMaxOutputTokens: 2_048 }),
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      requests.push(input);
      yield { type: "text_delta", text: "done" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const host = await createChiliHost({ ...workspace.options, modelRouter: model });
  try {
    const saved = await addChiliMemoryEntry({ ...memoryOptionsForHost(host), text: "Quartz memory remains background data" });
    const { sessionId } = await host.service.createSession();
    expect((await host.service.submitPrompt({ sessionId, text: "Explain Quartz rules and Memory." })).status).toBe("completed");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const [prepared] = await preparedRequests(host, sessionId);
    expectPreparedMatches(prepared!, request);
    expect(referenceText(request)).toContain("QUARTZ_INSTRUCTION_BEGIN");
    expect(referenceText(request)).not.toContain("QUARTZ_INSTRUCTION_END");
    expect(referenceText(request)).toContain("QUARTZ_ALWAYS_RULE");
    expect(referenceText(request)).toContain(saved.text);
    expect(request.system.join("\n") + (request.developer ?? []).join("\n")).not.toContain("QUARTZ_");
    const source = prepared!.sources.find((candidate) => String(candidate.metadata?.path).endsWith("/AGENTS.md"));
    expect(source).toMatchObject({ kind: "contextual_user", status: "truncated", metadata: { source: "project", trust: "project", truncated: true } });
    expect(source?.metadata?.contentVersion).toBe(hash(instruction));
    const actualItem = request.contextualUser!.find((item) => item.includes("QUARTZ_INSTRUCTION_BEGIN"))!;
    expect(source?.metadata?.actualChars).toBe(actualItem.length);
    expect(source?.metadata?.actualVersion).toBe(hash(actualItem));
    expect(prepared!.budget.contextWindowTokens).toBe(64_000);
    expect(prepared!.budget.outputReserveTokens).toBe(2_048);
    expect(prepared!.budget.contextTokens! + prepared!.budget.fixedInputTokens! + prepared!.budget.outputReserveTokens! + 2_048).toBeLessThanOrEqual(64_000);
    expect(new Set(prepared!.sources.filter((candidate) => candidate.kind === "contextual_user").map((candidate) => candidate.id)).size)
      .toBe(prepared!.sources.filter((candidate) => candidate.kind === "contextual_user").length);
  } finally {
    await host.close();
    await workspace.cleanup();
  }
});

test("Host refuses a model window that cannot fit its fixed instructions instead of sending a clipped prompt", async () => {
  const workspace = await fixture();
  let calls = 0;
  const model: ModelRouter = {
    resolveRequestLimits: () => ({ contextWindowTokens: 128, requestMaxOutputTokens: 64 }),
    async *stream(): AsyncIterable<ModelStreamEvent> {
      calls++;
      yield { type: "text_delta", text: "should not run" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const host = await createChiliHost({ ...workspace.options, modelRouter: model });
  try {
    const { sessionId } = await host.service.createSession();
    const result = await host.service.submitPrompt({ sessionId, text: "A small request." });
    expect(result.status).toBe("failed");
    expect(calls).toBe(0);
    expect(await preparedRequests(host, sessionId)).toEqual([]);
    const history = await host.store.messages(sessionId);
    expect(history.flatMap((message) => message.parts).some((part) => part.type === "text" && part.text === "A small request.")).toBe(true);
  } finally {
    await host.close();
    await workspace.cleanup();
  }
});

test("Host drops optional Memory under token pressure while retaining current instructions and conversation", async () => {
  const workspace = await fixture();
  const rule = "QUARTZ_REQUIRED_RULE: preserve the public API.";
  await writeFile(join(workspace.options.cwd, "AGENTS.md"), rule);
  let contextWindowTokens = 64_000;
  const requests: ModelStreamInput[] = [];
  const model: ModelRouter = {
    resolveRequestLimits: () => ({ contextWindowTokens, requestMaxOutputTokens: 256 }),
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      requests.push(input);
      yield { type: "text_delta", text: "done" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const host = await createChiliHost({ ...workspace.options, modelRouter: model });
  try {
    const { sessionId } = await host.service.createSession();
    expect((await host.service.submitPrompt({ sessionId, text: "Quartz initial requirement: keep the parser public API." })).status).toBe("completed");
    const [baseline] = await preparedRequests(host, sessionId);
    // Derive the fixture window from the required Host surface, so additions to
    // normal tool schemas do not bake an arbitrary production token threshold into this test.
    contextWindowTokens = baseline!.budget.fixedInputTokens! + baseline!.budget.contextTokens! + 256 + 2_048 + 1_500;
    const memoryIds = new Set<string>();
    for (let index = 0; index < 6; index++) {
      const entry = await addChiliMemoryEntry({ ...memoryOptionsForHost(host), text: `Quartz optional memory ${index}: ${"界".repeat(1_500)}` });
      memoryIds.add(entry.id);
    }
    const currentRequest = "Quartz current task: preserve the parser tests.";
    const result = await host.service.submitPrompt({ sessionId, text: currentRequest });
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(2);
    const actual = requests[1]!;
    expect(referenceText(actual)).toContain(rule);
    const conversation = actual.messages.flatMap((message) => message.parts).flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    expect(conversation).toContain(currentRequest);
    expect(conversation).toContain("Quartz initial requirement: keep the parser public API.");
    const prepared = (await preparedRequests(host, sessionId)).at(-1)!;
    expectPreparedMatches(prepared, actual);
    const memorySources = prepared.sources.filter((source) => memoryIds.has(String(source.metadata?.memoryId)));
    expect(memorySources).toHaveLength(6);
    expect(memorySources.some((source) => source.status === "omitted")).toBe(true);
    expect(memorySources.some((source) => source.status === "truncated")).toBe(false);
    for (const source of memorySources) {
      if (source.status === "omitted") {
        expect(source.reason).toBeTruthy();
        expect(source.metadata?.actualChars).toBe(0);
      } else {
        expect(actual.contextualUser?.some((item) => hash(item) === source.metadata?.actualVersion)).toBe(true);
      }
    }
    expect(prepared.sources.find((source) => String(source.metadata?.path).endsWith("/AGENTS.md"))?.status).toBe("included");
    expect(prepared.budget.contextTokens! + prepared.budget.fixedInputTokens! + prepared.budget.outputReserveTokens! + 2_048)
      .toBeLessThanOrEqual(contextWindowTokens);
  } finally {
    await host.close();
    await workspace.cleanup();
  }
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chili-prompt-context-memory-")));
  const cwd = join(root, "repo");
  const chiliHome = join(root, "profile");
  await mkdir(cwd, { recursive: true });
  await mkdir(chiliHome, { recursive: true });
  return {
    root,
    options: { cwd, chiliHome, model: "fake", permissionProfile: "full-access" as const, mcpConnectMode: "manual" as const, staleTurnRecoveryIntervalMs: false as const },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function memoryOptionsForHost(host: ChiliHost) {
  return { cwd: host.cwd, chiliHome: host.identity.profilePath, projectRoot: host.identity.projectRoot, projectId: host.identity.projectId };
}

function referenceText(request: ModelStreamInput): string {
  return (request.contextualUser ?? []).join("\n");
}

function occurrences(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

function pathRule(body: string): string {
  return `---\npaths: [src/**]\nalwaysApply: false\n---\n${body}\n`;
}

function skill(body: string): string {
  return `---\nname: quartz\ndescription: Quartz fixture workflow\n---\n${body}\n`;
}

async function preparedRequests(host: ChiliHost, sessionId: SessionId): Promise<PreparedModelRequest[]> {
  const events = await host.store.events({ sessionId, type: "model.request_prepared", limit: 100 });
  return events.flatMap((event) => {
    const payload = event.payload as { request?: PreparedModelRequest };
    return payload.request ? [payload.request] : [];
  });
}

function expectPreparedMatches(prepared: PreparedModelRequest, request: ModelStreamInput): void {
  expect(prepared.system).toEqual(request.system);
  expect(prepared.developer).toEqual(request.developer ?? []);
  expect(prepared.contextualUser).toEqual(request.contextualUser ?? []);
  expect(prepared.messages).toEqual(request.messages);
  expect(prepared.tools).toEqual(request.tools.map(({ name, description, risk, inputSchema }) => ({ name, description, risk, inputSchema })));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
