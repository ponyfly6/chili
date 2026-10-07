import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addChiliMemoryEntry,
  buildChiliMemoryPromptFragments,
  getChiliMemoryEntry,
  loadChiliMemoryContext,
  putChiliMemoryEntry,
  removeChiliMemoryEntry,
} from "./memory/index.js";
import { assemblePromptFragments } from "./prompt/index.js";
import { ContextWindowBuilder } from "./context/window.js";

test("Memory and rule provenance retains exact source before the display preview is clipped", async () => {
  const fixture = await memoryFixture();
  try {
    const memoryText = "Quartz " + "a".repeat(200) + " DO_NOT_CHANGE_PUBLIC_API";
    const entry = await addChiliMemoryEntry({ ...fixture.options, text: memoryText });
    const ruleText = "---\npaths: [src/**]\n---\n\nKeep the public API.\n" + "b".repeat(200) + "\n  ";
    const rulePath = join(fixture.rules, "api.md");
    await writeFile(rulePath, ruleText);
    const fragments = await buildChiliMemoryPromptFragments({
      ...fixture.options,
      maxDocumentChars: 12,
      targetPaths: ["src/api.ts"],
    });
    const memory = fragments.find((fragment) => fragment.metadata?.memoryId === entry.id)!;
    const rule = fragments.find((fragment) => fragment.metadata?.path === rulePath)!;

    expect(memory.content).not.toContain("DO_NOT_CHANGE_PUBLIC_API");
    expect(memory.sourceContent).toBe(memoryText);
    expect(rule.sourceContent).toBe(ruleText);
    expect(rule.content).not.toContain("paths:");
    const assembly = assemblePromptFragments(fragments);
    for (const fragment of [memory, rule]) {
      const rendered = assembly.fragments.find((candidate) => candidate.id === fragment.id)!;
      expect(rendered.metadata?.sourceContentVersion).toBe(hash(fragment.sourceContent!));
      expect(rendered.metadata?.sourceChars).toBe(fragment.sourceContent!.length);
      expect(rendered.metadata?.truncated).toBe(true);
      expect(assembly.debug.fragments.find((candidate) => candidate.id === fragment.id)?.contentVersion)
        .toBe(hash(rendered.content));
    }
  } finally { await fixture.cleanup(); }
});

test("an update outside a Memory preview changes source identity and fresh loads without mutating older snapshots", async () => {
  const fixture = await memoryFixture();
  try {
    const oldText = "Quartz prefix stays identical; use retries=2";
    const newText = "Quartz prefix stays identical; use retries=5";
    const entry = await addChiliMemoryEntry({ ...fixture.options, text: oldText });
    const load = () => buildChiliMemoryPromptFragments({ ...fixture.options, maxDocumentChars: 12 });
    const before = assemblePromptFragments(await load()).fragments.find((fragment) => fragment.metadata?.memoryId === entry.id)!;

    await putChiliMemoryEntry({ ...fixture.options, id: entry.id, expectedRevision: entry.revision, text: newText });
    const after = assemblePromptFragments(await load()).fragments.find((fragment) => fragment.metadata?.memoryId === entry.id)!;
    expect(after.content).toBe(before.content);
    expect(after.metadata?.memoryRevision).toBe(2);
    expect(after.metadata?.sourceContentVersion).toBe(hash(newText));
    expect(before.metadata?.sourceContentVersion).toBe(hash(oldText));
    expect(after.metadata?.contentVersion).not.toBe(before.metadata?.contentVersion);

    await expect(removeChiliMemoryEntry({ ...fixture.options, id: entry.id, expectedRevision: 1 })).rejects.toThrow("revision conflict");
    expect((await getChiliMemoryEntry({ ...fixture.options, scope: "project", id: entry.id }))?.text).toBe(newText);
    await removeChiliMemoryEntry({ ...fixture.options, id: entry.id, expectedRevision: 2 });
    expect((await load()).some((fragment) => fragment.metadata?.memoryId === entry.id)).toBe(false);
    expect(await getChiliMemoryEntry({ ...fixture.options, scope: "project", id: entry.id })).toBeUndefined();
    expect(before.metadata?.memoryRevision).toBe(1);
  } finally { await fixture.cleanup(); }
});

test("fresh prompt selection preserves profile, project, and user scope isolation", async () => {
  const fixture = await memoryFixture();
  try {
    const shared = await addChiliMemoryEntry({ ...fixture.options, scope: "user", text: "User prefers compact answers" });
    const project = await addChiliMemoryEntry({ ...fixture.options, scope: "project", text: "Project alpha uses Quartz" });
    const ids = async (options: typeof fixture.options) => (await loadChiliMemoryContext(options)).documents
      .filter((document) => document.memoryId).map((document) => document.memoryId);

    expect(await ids(fixture.options)).toEqual([shared.id, project.id]);
    expect(await ids({ ...fixture.options, projectId: "project-beta" })).toEqual([shared.id]);
    expect(await ids({ ...fixture.options, chiliHome: join(fixture.root, "other-profile") })).toEqual([]);
    expect(await getChiliMemoryEntry({ ...fixture.options, projectId: "project-beta", scope: "project", id: project.id })).toBeUndefined();
    expect(await getChiliMemoryEntry({ ...fixture.options, scope: "user", id: project.id })).toBeUndefined();
    await expect(putChiliMemoryEntry({ ...fixture.options, scope: "user", id: project.id, expectedRevision: 1, text: "wrong scope" })).rejects.toThrow();
    expect((await getChiliMemoryEntry({ ...fixture.options, scope: "project", id: project.id }))?.text).toBe("Project alpha uses Quartz");
  } finally { await fixture.cleanup(); }
});

test("rule edits, changed target scopes, and deletion take effect on the next load", async () => {
  const fixture = await memoryFixture();
  try {
    const path = join(fixture.rules, "scoped.md");
    const initial = "---\npaths: [src/**]\n---\nUse the old API.\n";
    await writeFile(path, initial);
    const before = await loadChiliMemoryContext({ ...fixture.options, targetPaths: ["src/api.ts"] });
    expect(before.documents.find((document) => document.path === path)?.content).toBe("Use the old API.");

    await writeFile(path, "---\npaths: [tests/**]\n---\nUse the corrected API.\n");
    const noLongerApplicable = await loadChiliMemoryContext({ ...fixture.options, targetPaths: ["src/api.ts"] });
    expect(noLongerApplicable.documents.some((document) => document.path === path)).toBe(false);
    expect(noLongerApplicable.omittedDocuments).toContainEqual({ path, reason: "rule_paths_not_applicable" });
    const updated = await loadChiliMemoryContext({ ...fixture.options, targetPaths: ["tests/api.test.ts"] });
    expect(updated.documents.find((document) => document.path === path)?.content).toBe("Use the corrected API.");
    expect(updated.documents.find((document) => document.path === path)?.contentVersion)
      .not.toBe(before.documents.find((document) => document.path === path)?.contentVersion);

    await rm(path);
    const deleted = await loadChiliMemoryContext({ ...fixture.options, targetPaths: ["tests/api.test.ts"] });
    expect(deleted.documents.some((document) => document.path === path)).toBe(false);
    expect(before.documents.find((document) => document.path === path)?.sourceContent).toBe(initial);
  } finally { await fixture.cleanup(); }
});

test("current project instructions are selected before Memory under a shared prompt budget", async () => {
  const fixture = await memoryFixture();
  try {
    const entry = await addChiliMemoryEntry({ ...fixture.options, text: "Old preference: change all APIs freely" });
    const instructionPath = join(fixture.options.cwd, "AGENTS.md");
    await writeFile(instructionPath, "Current repository rule: preserve public APIs.");
    const fragments = await buildChiliMemoryPromptFragments(fixture.options);
    const assembly = assemblePromptFragments(fragments);
    const instruction = assembly.fragments.find((fragment) => fragment.metadata?.path === instructionPath)!;
    const memory = assembly.fragments.find((fragment) => fragment.metadata?.memoryId === entry.id)!;
    expect(assembly.contextualUser[0]).toBe(instruction.content);
    const built = new ContextWindowBuilder({ maxPromptItemChars: instruction.content.length }).build([], {
      contextualUser: assembly.contextualUser,
    });
    expect(built.surface.contextualUser).toEqual([instruction.content]);
    expect(built.surface.contextualUser).not.toContain(memory.content);
    expect(assembly.developer.join("\n")).toContain("user's latest correction");
    expect(assembly.developer.join("\n")).toContain("older summary does not reinstate");
  } finally { await fixture.cleanup(); }
});

test("Memory preview limits are normalized and never split a Unicode surrogate pair", async () => {
  const fixture = await memoryFixture();
  try {
    const text = "a😀tail";
    await addChiliMemoryEntry({ ...fixture.options, text });
    await writeFile(join(fixture.options.cwd, "AGENTS.md"), text);
    for (const limit of [0, -2]) {
      const snapshot = await loadChiliMemoryContext({ ...fixture.options, maxDocumentChars: limit });
      expect(snapshot.documents.map((document) => document.content)).toEqual(["", ""]);
      expect(snapshot.documents.every((document) => document.sourceContent === text && document.truncatedAfter === 0)).toBe(true);
    }
    const clipped = await loadChiliMemoryContext({ ...fixture.options, maxDocumentChars: 2.9 });
    expect(clipped.documents.map((document) => document.content)).toEqual(["a", "a"]);
    expect(clipped.documents.every((document) => document.truncatedAfter === 2)).toBe(true);
    const fallback = await loadChiliMemoryContext({ ...fixture.options, maxDocumentChars: Number.NaN });
    expect(fallback.documents.map((document) => document.content)).toEqual([text, text]);
  } finally { await fixture.cleanup(); }
});

async function memoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "chili-memory-behavior-"));
  const repo = join(root, "repo");
  const rules = join(repo, ".chili", "rules");
  const chiliHome = join(root, "profile");
  await mkdir(rules, { recursive: true });
  await mkdir(chiliHome, { recursive: true });
  return {
    root,
    rules,
    options: { cwd: repo, projectRoot: repo, projectId: "project-alpha", chiliHome },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
