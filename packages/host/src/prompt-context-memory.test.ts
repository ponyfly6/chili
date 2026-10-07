import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChiliMemoryDirectories, type ModelRouter, type ModelStreamEvent, type ModelStreamInput } from "@chili/core";
import type { PreparedModelRequest, SessionId } from "@chili/protocol";
import { createChiliHost, type ChiliHost } from "./host.js";
import { resolveHostExecutionIdentity } from "./identity.js";

test("Host reads current Markdown Memory through reviewed bash and preserves request snapshots across update and deletion", async () => {
  const workspace = await fixture();
  const requests: ModelStreamInput[] = [];
  let memoryPath = "";
  const reviews: ModelStreamInput[] = [];
  const original = "Quartz original reconnect preference";
  const revised = "Quartz revised reconnect preference";
  const model: ModelRouter = {
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      requests.push(input);
      const call = requests.length;
      const file = join(memoryLocation(input, "Current project Markdown"), "reconnect.md");
      const command = call === 1 || call === 3 ? `cat ${quote(file)}`
        : call === 2 ? `printf '%s' ${quote(revised)} > ${quote(file)}`
        : call === 4 ? `rm ${quote(file)}`
        : call === 5 ? `if test -f ${quote(file)}; then cat ${quote(file)}; else printf '%s' 'Memory file missing'; fi` : undefined;
      if (command) yield { type: "tool_call", name: "bash", input: { command } };
      else yield { type: "text_delta", text: "done" };
      yield { type: "finish", reason: command ? "tool_use" : "stop" };
    },
  };
  const host = await createChiliHost({ ...workspace.options, permissionProfile: "auto-review", modelRouter: model, reviewerModelRouter: approvingReviewer(reviews) });
  try {
    const directories = await resolveChiliMemoryDirectories(memoryOptionsForHost(host));
    await mkdir(directories.project, { recursive: true });
    memoryPath = join(directories.project, "reconnect.md");
    await writeFile(memoryPath, original);
    const { sessionId } = await host.service.createSession();
    const result = await host.service.submitPrompt({ sessionId, text: "Read, update, verify, then forget and recheck the Quartz reconnect preference." });
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(6);
    expect(requests.flatMap((request) => request.messages.flatMap((message) => message.parts))
      .flatMap((part) => part.type === "tool_result" && part.error ? [part.error] : [])).toEqual([]);
    expect(historyText(requests[0]!)).not.toContain(original);
    expect(latestToolOutput(requests[1]!)).toContain(original);
    expect(latestToolOutput(requests[3]!)).toContain(revised);
    expect(latestToolOutput(requests[3]!)).not.toContain(original);
    expect(latestToolOutput(requests[5]!)).not.toContain(original);
    expect(latestToolOutput(requests[5]!)).not.toContain(revised);
    expect(latestToolOutput(requests[5]!)).toContain("Memory file missing");
    await expect(access(memoryPath)).rejects.toThrow();
    expect(reviews).toHaveLength(5);
    expect(reviews.every((request) => reviewAction(request).toolName === "bash")).toBe(true);
    for (const request of requests) {
      expect(referenceText(request)).not.toContain(original);
      expect(referenceText(request)).not.toContain(revised);
    }

    const prepared = await preparedRequests(host, sessionId);
    expect(prepared).toHaveLength(6);
    prepared.forEach((request, index) => expectPreparedMatches(request, requests[index]!));
    expect(prepared[0]!.sources.find((source) => source.id === "chili.base")?.metadata?.memoryDirectories).toEqual(directories);
    expect(prepared.flatMap((request) => request.sources).some((source) => source.kind === "contextual_user" && source.metadata?.memoryId)).toBe(false);
    const readMessage = requests[1]!.messages.find((message) => message.parts.some((part) => part.type === "tool_result" && part.output.includes(original)))!;
    expect(prepared[1]!.sources.find((source) => source.id === readMessage.id)?.status).not.toBe("omitted");
    expect(JSON.stringify(prepared[1]!.messages)).toContain(original);
    expect(JSON.stringify(prepared[1]!.messages)).not.toContain(revised);
    expect(historyText(requests[5]!)).toContain(original); // An old tool observation remains historical evidence.
    expect((await preparedRequests(host, sessionId))[1]).toEqual(prepared[1]);
    const inspected = await host.service.inspectPrompt({ sessionId, includeContent: true });
    expect(inspected.preparedRequest?.contentVersion).toBe(prepared[5]!.contentVersion);
  } finally {
    await host.close();
    await workspace.cleanup();
  }
});

test("Host refreshes mentioned skills without automatically loading rules for observed file targets", async () => {
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
    expect(referenceText(requests[1]!)).not.toContain(oldRule);
    expect(referenceText(requests[1]!)).not.toContain(subtreeRule);
    expect(referenceText(requests[2]!)).not.toContain(newRule);
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
    expect(ruleSources[1]).toBeUndefined();
    expect(ruleSources[2]).toBeUndefined();
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

test("root and child Agents discover and read shared profile Memory while isolating projects and tool history", async () => {
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
      const step = requests.filter((request) => request.sessionId === input.sessionId).length;
      if (step === 1) {
        const personal = join(memoryLocation(input, "Personal Markdown"), "preference.md");
        const project = join(memoryLocation(input, "Current project Markdown"), "preference.md");
        yield { type: "tool_call", name: "bash", input: { command: `cat ${quote(personal)} ${quote(project)}` } };
      }
      if (step === 2) yield { type: "tool_call", name: "read", input: { file_path: "AGENTS.md" } };
      if (step >= 3) yield { type: "text_delta", text: "done" };
      yield { type: "finish", reason: step < 3 ? "tool_use" : "stop" };
    },
  };
  const reviews: ModelStreamInput[] = [];
  const host = await createChiliHost({ ...workspace.options, permissionProfile: "auto-review", modelRouter: model, reviewerModelRouter: approvingReviewer(reviews) });
  try {
    const identityB = await resolveHostExecutionIdentity({ cwd: otherCwd, chiliHome: workspace.options.chiliHome });
    const directoriesA = await resolveChiliMemoryDirectories(memoryOptionsForHost(host));
    const directoriesB = await resolveChiliMemoryDirectories({ cwd: otherCwd, chiliHome: identityB.profilePath, projectRoot: identityB.projectRoot, projectId: identityB.projectId });
    const shared = "Quartz shared user preference";
    const a = "Quartz project A preference";
    const b = "Quartz project B preference";
    for (const directory of [directoriesA.personal, directoriesA.project, directoriesB.project]) await mkdir(directory, { recursive: true });
    await writeFile(join(directoriesA.personal, "preference.md"), shared);
    await writeFile(join(directoriesA.project, "preference.md"), a);
    await writeFile(join(directoriesB.project, "preference.md"), b);
    const rootA = await host.service.createSession();
    const rootB = await host.service.createSession({ cwd: otherCwd });
    for (const root of [rootA, rootB]) {
      expect((await host.service.submitPrompt({ sessionId: root.sessionId, text: "Apply $quartz to Quartz preferences." })).status).toBe("completed");
      const agents = host.agents.forSession(root.sessionId);
      const spawned = await agents.spawnAgent({ name: "reader", prompt: "Apply $quartz to Quartz preferences." });
      expect((await agents.waitAgent({ ...spawned, timeoutMs: 5_000 })).input.outcome).toBe("completed");
    }
    await host.waitForAgents();
    expect(requests).toHaveLength(12);
    expect(reviews.filter((request) => reviewAction(request).toolName === "bash")).toHaveLength(4);
    const childrenA = await host.store.childSessions(rootA.sessionId);
    const childrenB = await host.store.childSessions(rootB.sessionId);
    expect(childrenA).toHaveLength(1);
    expect(childrenB).toHaveLength(1);
    for (const [root, child, expected, forbidden, rule, directories] of [
      [rootA.sessionId, childrenA[0]!.id, a, b, "QUARTZ_PROJECT_A_RULE", directoriesA],
      [rootB.sessionId, childrenB[0]!.id, b, a, "QUARTZ_PROJECT_B_RULE", directoriesB],
    ] as const) {
      for (const sessionId of [root, child]) {
        const sessionRequests = requests.filter((candidate) => candidate.sessionId === sessionId);
        const request = sessionRequests.at(-1)!;
        expect(historyText(sessionRequests[0]!)).not.toContain(shared);
        expect(historyText(sessionRequests[0]!)).not.toContain(rule);
        expect(historyText(request)).toContain(shared);
        expect(historyText(request)).toContain(expected);
        expect(historyText(request)).not.toContain(forbidden);
        expect(historyText(request)).toContain(rule);
        expect(referenceText(request)).not.toContain(shared);
        expect(referenceText(request)).not.toContain(rule);
        expect(occurrences(referenceText(request), profileSkill)).toBe(1);
        const privileged = request.system.join("\n") + (request.developer ?? []).join("\n");
        expect(privileged).not.toContain(shared);
        expect(privileged).not.toContain(profileSkill);
        expect(memoryLocation(request, "Personal Markdown")).toBe(directories.personal);
        expect(memoryLocation(request, "Current project Markdown")).toBe(directories.project);
        expect(occurrences(privileged, "Memory locations (directories may not exist):")).toBe(1);
        const prepared = await preparedRequests(host, sessionId);
        prepared.forEach((snapshot, index) => expectPreparedMatches(snapshot, sessionRequests[index]!));
        expect(prepared.at(-1)!).not.toHaveProperty("executionIdentity");
        expect(prepared.at(-1)!.sources.some((source) => source.kind === "contextual_user" && source.metadata?.memoryId)).toBe(false);
        expect(request.messages.every((message) => message.sessionId === sessionId)).toBe(true);
      }
    }
  } finally {
    await host.close();
    await workspace.cleanup();
  }
});

test("Host only includes project instructions after explicit file reads, with actual request provenance", async () => {
  const workspace = await fixture();
  const instruction = "QUARTZ_INSTRUCTION_VERSION_ONE";
  const revised = "QUARTZ_INSTRUCTION_VERSION_TWO";
  const instructionPath = join(workspace.options.cwd, "AGENTS.md");
  await writeFile(instructionPath, instruction);
  await mkdir(join(workspace.options.cwd, ".chili", "rules"), { recursive: true });
  await writeFile(join(workspace.options.cwd, ".chili", "rules", "always.md"), "QUARTZ_ALWAYS_RULE");
  const requests: ModelStreamInput[] = [];
  const model: ModelRouter = {
    resolveRequestLimits: () => ({ contextWindowTokens: 64_000, requestMaxOutputTokens: 2_048 }),
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      requests.push(input);
      if (requests.length === 2) await writeFile(instructionPath, revised);
      if (requests.length < 3) yield { type: "tool_call", name: "read", input: { file_path: "AGENTS.md" } };
      else yield { type: "text_delta", text: "done" };
      yield { type: "finish", reason: requests.length < 3 ? "tool_use" : "stop" };
    },
  };
  const host = await createChiliHost({ ...workspace.options, modelRouter: model });
  try {
    const directories = await resolveChiliMemoryDirectories(memoryOptionsForHost(host));
    const saved = "Quartz memory remains background data";
    await mkdir(directories.project, { recursive: true });
    await writeFile(join(directories.project, "background.md"), saved);
    const { sessionId } = await host.service.createSession();
    expect((await host.service.submitPrompt({ sessionId, text: "Read the project guidance, then re-read it." })).status).toBe("completed");
    expect(requests).toHaveLength(3);
    expect(historyText(requests[0]!)).not.toContain(instruction);
    expect(latestToolOutput(requests[1]!)).toContain(instruction);
    expect(latestToolOutput(requests[2]!)).toContain(revised);
    expect(latestToolOutput(requests[2]!)).not.toContain(instruction);
    const prepared = await preparedRequests(host, sessionId);
    for (const [index, request] of requests.entries()) {
      expectPreparedMatches(prepared[index]!, request);
      expect(referenceText(request)).not.toContain("QUARTZ_");
      expect(historyText(request)).not.toContain("QUARTZ_ALWAYS_RULE");
      expect(historyText(request)).not.toContain(saved);
      expect(request.system.join("\n") + (request.developer ?? []).join("\n")).not.toContain("QUARTZ_");
      expect(prepared[index]!.sources.some((source) => source.kind === "contextual_user" && source.metadata?.path === instructionPath)).toBe(false);
      expect(prepared[index]!.budget.estimatedRequestTokens!).toBeLessThanOrEqual(64_000);
    }
    expect(JSON.stringify(prepared[1]!.messages)).toContain(instruction);
    expect(JSON.stringify(prepared[1]!.messages)).not.toContain(revised);
    const resultMessage = requests[2]!.messages.find((message) => message.parts.some((part) => part.type === "tool_result" && part.output.includes(revised)))!;
    expect(prepared[2]!.sources.find((source) => source.id === resultMessage.id)?.status).not.toBe("omitted");
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

test("unread Memory and project files do not consume the model request budget", async () => {
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
    const directories = await resolveChiliMemoryDirectories(memoryOptionsForHost(host));
    await mkdir(directories.project, { recursive: true });
    for (let index = 0; index < 6; index++) {
      await writeFile(join(directories.project, `optional-${index}.md`), `Quartz optional memory ${index}: ${"界".repeat(1_500)}`);
    }
    const currentRequest = "Quartz current task: preserve the parser tests.";
    const result = await host.service.submitPrompt({ sessionId, text: currentRequest });
    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(2);
    const actual = requests[1]!;
    expect(referenceText(actual)).not.toContain(rule);
    const conversation = actual.messages.flatMap((message) => message.parts).flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    expect(conversation).toContain(currentRequest);
    expect(conversation).toContain("Quartz initial requirement: keep the parser public API.");
    const prepared = (await preparedRequests(host, sessionId)).at(-1)!;
    expectPreparedMatches(prepared, actual);
    const memorySources = prepared.sources.filter((source) => source.metadata?.memoryId);
    expect(memorySources).toEqual([]);
    expect(prepared.budget.fixedInputTokens).toBe(baseline!.budget.fixedInputTokens);
    expect(historyText(actual)).not.toContain("Quartz optional memory");
    expect(prepared.sources.some((source) => String(source.metadata?.path).endsWith("/AGENTS.md"))).toBe(false);
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

function historyText(request: ModelStreamInput): string {
  return JSON.stringify(request.messages);
}

function latestToolOutput(request: ModelStreamInput): string {
  return request.messages.flatMap((message) => message.parts).findLast((part) => part.type === "tool_result")?.output ?? "";
}

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
