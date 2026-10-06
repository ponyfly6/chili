import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRevisionConflictError, SqliteMemoryRepository } from "./memory-repository.js";

const scope = { kind: "project", id: "project-a" } as const;

test("memory uses stable IDs, scope checks, CAS revisions and non-reusable legacy ordinals", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-memory-repository-"));
  const first = new SqliteMemoryRepository(join(root, "memory.sqlite"));
  const second = new SqliteMemoryRepository(join(root, "memory.sqlite"));
  try {
    const a = first.put({ scope, text: "first fact", source: "test" });
    const b = second.put({ scope, text: "second fact", source: "test" });
    expect(second.get({ kind: "project", id: "other-project" }, a.id)).toBeUndefined();
    const changed = second.put({ scope, id: a.id, expectedRevision: 1, text: "changed fact", source: "test" });
    expect(changed.revision).toBe(2);
    expect(() => first.put({ scope, id: a.id, expectedRevision: 1, text: "stale update", source: "test" })).toThrow(MemoryRevisionConflictError);
    expect(() => first.delete(scope, a.id, 1)).toThrow(MemoryRevisionConflictError);
    first.delete(scope, a.id, 2);
    const c = second.put({ scope, text: "third fact", source: "test" });
    expect(first.getByOrdinal(scope, a.ordinal)).toBeUndefined();
    expect(first.getByOrdinal(scope, b.ordinal)?.id).toBe(b.id);
    expect(c.ordinal).toBe(3);
    expect(() => first.put({ scope, id: a.id, expectedRevision: 0, text: "resurrect stale ID", source: "test" })).toThrow(MemoryRevisionConflictError);
  } finally {
    first.close(); second.close(); await rm(root, { recursive: true, force: true });
  }
});

test("legacy import is atomic and one-time and search reaches new entries after a long library", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-memory-search-"));
  const repository = new SqliteMemoryRepository(join(root, "memory.sqlite"));
  try {
    expect(repository.importLegacy(scope, "/legacy/memory.md", "old", ["old"])).toBe(true);
    expect(repository.importLegacy(scope, "/legacy/memory.md", "changed outside authority", ["changed outside authority"])).toBe(false);
    expect(repository.importLegacy(scope, "/other-worktree/memory.md", "same project", ["same project"])).toBe(false);
    for (let index = 0; index < 200; index++) repository.put({ scope, text: `routine ${index}`, source: "test" });
    const recent = repository.put({ scope, text: "Zebra websocket reconnect backoff", source: "test" });
    expect(repository.search(scope, "websocket backoff").map((entry) => entry.id)).toEqual([recent.id]);
    expect(repository.exportMarkdown(scope)).toContain(`id: ${recent.id}; revision: 1`);
    expect(repository.list(scope)).toHaveLength(202);
  } finally { repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("independent processes append concurrently without losing memories or duplicating migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-memory-process-"));
  const path = join(root, "memory.sqlite");
  const initialized = new SqliteMemoryRepository(path);
  initialized.close();
  try {
    const modulePath = new URL("./memory-repository.ts", import.meta.url).pathname;
    const source = `import { SqliteMemoryRepository } from ${JSON.stringify(modulePath)};
      const repository = new SqliteMemoryRepository(process.argv[1]);
      const scope = { kind: 'project', id: 'project-a' };
      repository.importLegacy(scope, 'legacy', 'original', ['original']);
      for (let index = 0; index < 40; index++) repository.put({ scope, text: process.argv[2] + ':' + index, source: 'process-test' });
      repository.close();`;
    const processes = ["a", "b", "c"].map((label) => Bun.spawn([process.execPath, "--eval", source, path, label], { stdout: "pipe", stderr: "pipe" }));
    for (const child of processes) {
      const stderr = await new Response(child.stderr).text();
      expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: "" });
    }
    const repository = new SqliteMemoryRepository(path);
    try {
      const entries = repository.list(scope);
      expect(entries).toHaveLength(121);
      expect(new Set(entries.map((entry) => entry.ordinal)).size).toBe(121);
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(121);
      expect(entries.filter((entry) => entry.text === "original")).toHaveLength(1);
    } finally { repository.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
