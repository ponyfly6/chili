import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sqliteJournalPolicy } from "./sqlite-journal-policy.js";

export interface MemoryScope {
  kind: "user" | "project";
  /** User scope is local to this profile database; project scope has a stable project identity. */
  id: string;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  /** Compatibility ordinal. Never renumbered or reused after deletion. */
  ordinal: number;
  revision: number;
  text: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryPutInput {
  scope: MemoryScope;
  text: string;
  source: string;
  id?: string;
  /** Required when replacing an existing record; 0 creates an explicit ID. */
  expectedRevision?: number;
}

export class MemoryRevisionConflictError extends Error {
  constructor(readonly id: string) {
    super(`Memory revision conflict for ${id}; read the current entry before updating or deleting it`);
    this.name = "MemoryRevisionConflictError";
  }
}

interface MemoryRow {
  id: string;
  scope_kind: MemoryScope["kind"];
  scope_id: string;
  ordinal: number;
  revision: number;
  text: string;
  source: string;
  created_at: number;
  updated_at: number;
}

/** Profile-local authority for durable memories. Session facts remain in the event store. */
export class SqliteMemoryRepository {
  private readonly db: Database;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA busy_timeout = 5000");
    const version = this.db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()?.version ?? "unknown";
    this.db.exec(`PRAGMA journal_mode = ${sqliteJournalPolicy(version).journalMode}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL CHECK(scope_kind IN ('user', 'project')),
        scope_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        UNIQUE(scope_kind, scope_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS memory_scope ON memory_entries(scope_kind, scope_id, deleted_at);
      CREATE TABLE IF NOT EXISTS memory_legacy_imports (
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        source TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        original_content TEXT,
        imported_at INTEGER NOT NULL,
        PRIMARY KEY(scope_kind, scope_id)
      );
    `);
  }

  close(): void { this.db.close(); }

  get(scope: MemoryScope, id: string): MemoryRecord | undefined {
    const row = this.db.query<MemoryRow, [string, string, string]>(
      "SELECT * FROM memory_entries WHERE scope_kind = ? AND scope_id = ? AND id = ? AND deleted_at IS NULL",
    ).get(scope.kind, scope.id, id);
    return row ? record(row) : undefined;
  }

  getByOrdinal(scope: MemoryScope, ordinal: number): MemoryRecord | undefined {
    const row = this.db.query<MemoryRow, [string, string, number]>(
      "SELECT * FROM memory_entries WHERE scope_kind = ? AND scope_id = ? AND ordinal = ? AND deleted_at IS NULL",
    ).get(scope.kind, scope.id, ordinal);
    return row ? record(row) : undefined;
  }

  list(scope: MemoryScope): MemoryRecord[] {
    return this.db.query<MemoryRow, [string, string]>(
      "SELECT * FROM memory_entries WHERE scope_kind = ? AND scope_id = ? AND deleted_at IS NULL ORDER BY ordinal",
    ).all(scope.kind, scope.id).map(record);
  }

  search(scope: MemoryScope, query = "", limit = 24): MemoryRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Memory search limit must be between 1 and 1000");
    const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].slice(0, 16);
    if (terms.length === 0) {
      return this.db.query<MemoryRow, [string, string, number]>(
        "SELECT * FROM memory_entries WHERE scope_kind = ? AND scope_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, ordinal DESC LIMIT ?",
      ).all(scope.kind, scope.id, limit).map(record);
    }
    const score = terms.map(() => "CASE WHEN lower(text) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END").join(" + ");
    const patterns = terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
    return this.db.query<MemoryRow, (string | number)[]>(
      `SELECT * FROM (SELECT *, (${score}) AS relevance FROM memory_entries WHERE scope_kind = ? AND scope_id = ? AND deleted_at IS NULL) WHERE relevance > 0 ORDER BY relevance DESC, updated_at DESC, ordinal DESC LIMIT ?`,
    ).all(...patterns, scope.kind, scope.id, limit).map(record);
  }

  put(input: MemoryPutInput): MemoryRecord {
    if (!input.text.trim()) throw new Error("Memory text must not be empty");
    return this.db.transaction(() => this.putWithinTransaction(input)).immediate();
  }

  delete(scope: MemoryScope, id: string, expectedRevision: number): MemoryRecord {
    return this.db.transaction(() => {
      const current = this.get(scope, id);
      if (!current || current.revision !== expectedRevision) throw new MemoryRevisionConflictError(id);
      this.db.query("UPDATE memory_entries SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(Date.now(), Date.now(), id);
      return current;
    }).immediate();
  }

  hasLegacyImport(scope: MemoryScope): boolean {
    return Boolean(this.db.query("SELECT 1 FROM memory_legacy_imports WHERE scope_kind = ? AND scope_id = ?").get(scope.kind, scope.id));
  }

  /** Both the import receipt and all imported entries commit together, including an absent legacy file. */
  importLegacy(scope: MemoryScope, source: string, content: string | undefined, entries: readonly string[]): boolean {
    return this.db.transaction(() => {
      if (this.hasLegacyImport(scope)) return false;
      for (const text of entries) {
        if (text.trim()) this.putWithinTransaction({ scope, text, source: `legacy:${source}` });
      }
      this.db.query("INSERT INTO memory_legacy_imports VALUES (?, ?, ?, ?, ?, ?)").run(
        scope.kind, scope.id, source, createHash("sha256").update(content ?? "").digest("hex"), content ?? null, Date.now(),
      );
      return true;
    }).immediate();
  }

  exportMarkdown(scope: MemoryScope): string {
    return `# Chili Memory\n\n${this.list(scope).map((entry) =>
      `<!-- id: ${entry.id}; revision: ${entry.revision}; source: ${entry.source.replace(/-->/g, "")} -->\n${entry.text}`,
    ).join("\n\n")}\n`;
  }

  private putWithinTransaction(input: MemoryPutInput): MemoryRecord {
    const id = input.id ?? `memory_${randomUUID()}`;
    const now = Date.now();
    if (input.id && input.expectedRevision !== 0) {
      const current = this.get(input.scope, id);
      if (!current || current.revision !== input.expectedRevision) throw new MemoryRevisionConflictError(id);
      this.db.query("UPDATE memory_entries SET text = ?, source = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(input.text, input.source, now, id);
    } else {
      if (input.expectedRevision !== undefined && input.expectedRevision !== 0) throw new MemoryRevisionConflictError(id);
      const ordinal = this.db.query<{ next: number }, [string, string]>(
        "SELECT coalesce(max(ordinal), 0) + 1 AS next FROM memory_entries WHERE scope_kind = ? AND scope_id = ?",
      ).get(input.scope.kind, input.scope.id)?.next ?? 1;
      if (this.db.query("SELECT 1 FROM memory_entries WHERE id = ?").get(id)) throw new MemoryRevisionConflictError(id);
      this.db.query("INSERT INTO memory_entries (id, scope_kind, scope_id, ordinal, revision, text, source, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)")
        .run(id, input.scope.kind, input.scope.id, ordinal, input.text, input.source, now, now);
    }
    return this.get(input.scope, id)!;
  }
}

function record(row: MemoryRow): MemoryRecord {
  return {
    id: row.id, scope: { kind: row.scope_kind, id: row.scope_id }, ordinal: row.ordinal,
    revision: row.revision, text: row.text, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
