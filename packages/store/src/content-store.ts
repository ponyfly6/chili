import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface ContentReference {
  $chiliContent: { key: string; bytes: number; jsonBytes: number; encoding: "text" | "json" };
}
interface JsonContent { value: unknown; references: Array<Array<string | number>>; }
const CONTENT_FIELDS = new Set(["part", "text", "displayText", "data", "output", "error", "summary", "input", "structuredData", "content", "modelOutput", "files", "request"]);
const OMITTED = "\n[Snapshot display truncated; full content remains in storage.]";

/** Content is immutable; SQLite publishes references only after these writes complete. */
export class StoredContentCodec {
  private readonly memory = new Map<string, Buffer>();
  readonly directory: string | undefined;

  constructor(databasePath: string) {
    this.directory = databasePath === ":memory:" ? undefined : resolve(join(dirname(databasePath), "contents", basename(databasePath)));
  }

  storeText(text: string, sessionId?: string): string {
    return JSON.stringify({ __chiliStoredValue: 1, value: this.textReference(text, sessionId) });
  }

  readText(stored: string): string {
    const wrapper = this.storedTextWrapper(stored);
    return wrapper ? this.resolve(wrapper) as unknown as string : stored;
  }

  textBytes(stored: string): number {
    const wrapper = this.storedTextWrapper(stored);
    return wrapper ? wrapper.value.$chiliContent.bytes : Buffer.byteLength(stored);
  }

  private storedTextWrapper(stored: string): { __chiliStoredValue: 1; value: ContentReference } | undefined {
    if (!stored.startsWith('{"__chiliStoredValue":1,')) return undefined;
    let value: unknown;
    try { value = JSON.parse(stored); } catch { return undefined; }
    if (value && typeof value === "object" && isContentReference((value as { value?: unknown }).value)) {
      return value as { __chiliStoredValue: 1; value: ContentReference };
    }
    return undefined;
  }

  textReference(text: string, sessionId?: string): ContentReference {
    return this.put(text, "text", Buffer.byteLength(JSON.stringify(text)), sessionId);
  }

  jsonReference(value: unknown, sessionId?: string): ContentReference {
    const logicalJson = JSON.stringify(value);
    const references: JsonContent["references"] = [];
    const separate = (node: unknown, path: Array<string | number>): unknown => {
      // Long string bodies reused in model requests or structured results use the
      // same text object as their conversation/tool records. Paths distinguish
      // our references from identically-shaped objects supplied by a caller.
      if (typeof node === "string" && (Buffer.byteLength(node) >= 256 || ["text", "output", "data", "displayText", "summary", "error"].includes(String(path.at(-1))))) {
        references.push(path);
        return this.textReference(node, sessionId);
      }
      if (Array.isArray(node)) return node.map((item, index) => separate(item, [...path, index]));
      if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, separate(item, [...path, key])]));
      return node;
    };
    const manifest: JsonContent = { value: separate(JSON.parse(logicalJson), []), references };
    return this.put(JSON.stringify(manifest), "json", Buffer.byteLength(logicalJson), sessionId);
  }

  storePart<T extends { sessionId?: string }>(part: T): T {
    const stored = { ...part, __chiliContentVersion: 1 } as Record<string, unknown>;
    for (const field of ["text", "displayText", "data", "output", "error", "summary"]) {
      if (typeof stored[field] === "string") stored[field] = this.textReference(stored[field] as string, part.sessionId);
    }
    for (const field of ["input", "structuredData", "content", "modelOutput", "files"]) {
      if (stored[field] !== undefined) stored[field] = this.jsonReference(stored[field], part.sessionId);
    }
    return stored as T;
  }

  storePayload(type: string, payload: unknown, sessionId?: string): unknown {
    const stored = { ...(payload as Record<string, unknown>) };
    if ((type === "message.part_added" || type === "message.part_committed") && stored.part) {
      stored.part = this.storePart(stored.part as { sessionId?: string });
    } else if ((type === "tool.call_started" || type === "tool.call_updated")) {
      if (stored.input !== undefined) stored.input = this.jsonReference(stored.input, sessionId);
    } else if (type === "tool.call_finished") {
      for (const field of ["output", "error"]) if (typeof stored[field] === "string") stored[field] = this.textReference(stored[field] as string, sessionId);
    } else if (type === "model.request_prepared") {
      if (stored.request !== undefined) {
        const version = (stored.request as { contentVersion?: unknown })?.contentVersion;
        const reference = this.jsonReference(stored.request, sessionId);
        if (typeof version === "string") Object.assign(reference.$chiliContent, { contentVersion: version });
        stored.request = reference;
      }
    }
    if (["message.part_added", "message.part_committed", "tool.call_started", "tool.call_updated", "tool.call_finished", "model.request_prepared"].includes(type)) stored.__chiliContentVersion = 1;
    return stored;
  }

  /** Exact serialized size after references resolve, without reading their files. */
  resolvedJsonBytes(value: unknown, referenceAllowed = false): number {
    if (referenceAllowed && isContentReference(value)) return value.$chiliContent.jsonBytes;
    if (isStoredValue(value)) return this.resolvedJsonBytes(value.value, true);
    if (isStoredContainer(value)) {
      const entries = Object.entries(value).filter(([key, item]) => key !== "__chiliContentVersion" && item !== undefined);
      return 2 + Math.max(0, entries.length - 1) + entries.reduce((bytes, [key, item]) => bytes + Buffer.byteLength(JSON.stringify(key)) + 1
        + (CONTENT_FIELDS.has(key) ? this.resolvedJsonBytes(item, true) : Buffer.byteLength(JSON.stringify(item))), 0);
    }
    return Buffer.byteLength(JSON.stringify(value) ?? "null");
  }

  resolve<T>(value: T, referenceAllowed = false): T {
    if (referenceAllowed && isContentReference(value)) return this.readReference(value) as T;
    if (isStoredValue(value)) return this.resolve(value.value, true) as T;
    if (isStoredContainer(value)) return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "__chiliContentVersion")
      .map(([key, item]) => [key, CONTENT_FIELDS.has(key) ? this.resolve(item, true) : item])) as T;
    return value;
  }

  resolveBounded<T>(value: T, maxBytes: number, onTruncated?: () => void): T {
    let remaining = Math.max(0, maxBytes);
    const visit = (item: unknown, referenceAllowed = false): unknown => {
      if (referenceAllowed && isContentReference(item)) {
        const ref = item.$chiliContent;
        if (ref.jsonBytes <= remaining && ref.bytes <= maxBytes + 512) {
          remaining -= ref.jsonBytes;
          return this.readReference(item);
        }
        onTruncated?.();
        if (ref.encoding === "json") return { omitted: "Snapshot input exceeded display limit" };
        // Account conservatively for JSON escaping, without loading the full file.
        const limit = Math.max(0, Math.floor((remaining - Buffer.byteLength(OMITTED) - 2) / 6));
        const prefix = this.readPrefix(ref.key, Math.min(limit, ref.bytes));
        remaining = Math.max(0, remaining - Buffer.byteLength(JSON.stringify(prefix + OMITTED)));
        return prefix + OMITTED;
      }
      if (isStoredValue(item)) return visit(item.value, true);
      if (isStoredContainer(item)) return Object.fromEntries(Object.entries(item)
        .filter(([key]) => key !== "__chiliContentVersion")
        .map(([key, field]) => [key, CONTENT_FIELDS.has(key) ? visit(field, true) : field]));
      return item;
    };
    return visit(value) as T;
  }

  private put(value: string, encoding: "text" | "json", jsonBytes: number, sessionId?: string): ContentReference {
    const bytes = Buffer.from(value);
    const scope = createHash("sha256").update(sessionId ?? "global").digest("hex").slice(0, 24);
    const hash = createHash("sha256").update(encoding).update(bytes).digest("hex");
    const key = `${scope}/${hash}.${encoding === "text" ? "txt" : "json"}`;
    if (!this.directory) this.memory.set(key, bytes);
    else {
      const path = this.path(key);
      if (!existsSync(path)) {
        const directory = dirname(path);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        // Publish a complete fsynced file atomically. Competing writers may both
        // prepare it; only the first link wins, and neither replaces contents.
        const temporary = join(directory, `.${randomUUID()}.tmp`);
        const fd = openSync(temporary, "wx", 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        try {
          try { linkSync(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        } finally { unlinkSync(temporary); }
        this.syncDirectory(directory);
        this.syncDirectory(this.directory);
        this.syncDirectory(dirname(this.directory));
        this.syncDirectory(dirname(dirname(this.directory)));
      }
    }
    return { $chiliContent: { key, bytes: bytes.length, jsonBytes, encoding } };
  }

  private readReference(value: ContentReference): unknown {
    const ref = value.$chiliContent;
    const raw = this.read(ref.key, ref.bytes).toString("utf8");
    if (ref.encoding === "text") return raw;
    const manifest = JSON.parse(raw) as JsonContent;
    let result = manifest.value;
    for (const path of manifest.references) {
      if (!path.length) { result = this.readReference(result as ContentReference); continue; }
      let owner = result as Record<string | number, unknown>;
      for (const key of path.slice(0, -1)) owner = owner[key] as Record<string | number, unknown>;
      const key = path[path.length - 1]!;
      owner[key] = this.readReference(owner[key] as ContentReference);
    }
    return result;
  }

  private read(key: string, bytes: number): Buffer {
    if (!this.directory) {
      const value = this.memory.get(key);
      if (!value || value.length !== bytes) throw new Error(`Missing or incomplete stored content: ${key}`);
      return value;
    }
    const path = this.path(key);
    if (statSync(path).size !== bytes) throw new Error(`Incomplete stored content: ${key}`);
    return readFileSync(path);
  }

  private readPrefix(key: string, maxBytes: number): string {
    let prefix: Buffer;
    if (!this.directory) {
      const value = this.memory.get(key);
      if (!value) throw new Error(`Missing stored content: ${key}`);
      prefix = value.subarray(0, maxBytes);
    } else {
      const fd = openSync(this.path(key), "r");
      try { const buffer = Buffer.alloc(maxBytes); prefix = buffer.subarray(0, readSync(fd, buffer, 0, maxBytes, 0)); }
      finally { closeSync(fd); }
    }
    return new TextDecoder().decode(prefix, { stream: true });
  }

  private path(key: string): string {
    if (!/^[a-f0-9]{24}\/[a-f0-9]{64}\.(txt|json)$/u.test(key)) throw new Error("Invalid stored content reference");
    return join(this.directory!, key);
  }

  private syncDirectory(path: string): void {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

export function isContentReference(value: unknown): value is ContentReference {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return false;
  const reference = (value as Partial<ContentReference>).$chiliContent;
  return !!reference && typeof reference.key === "string" && Number.isSafeInteger(reference.bytes) && reference.bytes >= 0
    && Number.isSafeInteger(reference.jsonBytes) && reference.jsonBytes >= 0 && (reference.encoding === "text" || reference.encoding === "json");
}

function isStoredContainer(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && (value as Record<string, unknown>).__chiliContentVersion === 1;
}
function isStoredValue(value: unknown): value is { __chiliStoredValue: 1; value: ContentReference } {
  return !!value && typeof value === "object" && (value as Record<string, unknown>).__chiliStoredValue === 1
    && isContentReference((value as Record<string, unknown>).value);
}
