import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ApiKeyCredential {
  type: "api_key";
  key: string;
  revision?: string;
}

export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

export type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  /** Opaque write version. Older auth.json entries are upgraded on their next write. */
  revision?: string;
};

export type AuthCredential = ApiKeyCredential | OAuthCredential;
export type AuthStorageData = Record<string, AuthCredential>;

export interface AuthStatus {
  configured: boolean;
  authPath: string;
  type?: AuthCredential["type"];
  accountId?: string;
  expires?: number;
  expired?: boolean;
}

export function defaultChiliHome(): string {
  return process.env.CHILI_HOME || join(homedir(), ".chili");
}

export function defaultAuthPath(chiliHome?: string): string {
  return chiliHome === undefined
    ? process.env.CHILI_AUTH_FILE || join(defaultChiliHome(), "auth.json")
    : join(chiliHome, "auth.json");
}

export class FileAuthStorage {
  constructor(readonly authPath: string = defaultAuthPath()) {}

  async read(): Promise<AuthStorageData> {
    try {
      const content = await readFile(this.authPath, "utf8");
      if (!content.trim()) return {};
      const parsed = JSON.parse(content) as unknown;
      if (!isRecord(parsed)) throw new Error("auth.json must contain a JSON object");
      return parsed as AuthStorageData;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return {};
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async write(data: AuthStorageData): Promise<void> {
    await this.transaction((db) => {
      this.persist(Object.fromEntries(
        Object.entries(data).map(([provider, credential]) => [provider, { ...credential, revision: randomUUID() }]),
      ));
      db.exec("DELETE FROM oauth_refresh");
    });
  }

  async get(provider: string): Promise<AuthCredential | undefined> {
    return (await this.read())[provider];
  }

  async getOAuthCredentials(provider: string): Promise<OAuthCredential | undefined> {
    const credential = await this.get(provider);
    return credential?.type === "oauth" ? credential : undefined;
  }

  async set(provider: string, credential: AuthCredential): Promise<void> {
    await this.transaction((db) => {
      const data = this.readSync();
      data[provider] = { ...credential, revision: randomUUID() };
      this.persist(data);
      db.query("DELETE FROM oauth_refresh WHERE provider = ?").run(provider);
    });
  }

  async setOAuthCredentials(provider: string, credentials: OAuthCredentials): Promise<void> {
    await this.set(provider, { type: "oauth", ...credentials });
  }

  async remove(provider: string): Promise<boolean> {
    return this.transaction((db) => {
      const data = this.readSync();
      const existed = data[provider] !== undefined;
      delete data[provider];
      this.persist(data);
      db.query("DELETE FROM oauth_refresh WHERE provider = ?").run(provider);
      return existed;
    });
  }

  /** Refresh never owns the storage write lock while doing network I/O. */
  async claimOAuthRefresh(provider: string, expected: OAuthCredential, owner: string, expiresAt: number, signal?: AbortSignal): Promise<"claimed" | "busy" | "changed"> {
    return this.transaction((db) => {
      if (!sameOAuthCredential(this.readSync()[provider], expected)) return "changed";
      const lease = db.query("SELECT owner, pid, expires_at FROM oauth_refresh WHERE provider = ?")
        .get(provider) as { owner: string; pid: number; expires_at: number } | null;
      if (lease && lease.expires_at > Date.now() && processAlive(lease.pid)) return "busy";
      db.query("INSERT OR REPLACE INTO oauth_refresh(provider, owner, pid, expires_at) VALUES (?, ?, ?, ?)")
        .run(provider, owner, process.pid, expiresAt);
      return "claimed";
    }, signal);
  }

  async commitOAuthRefresh(provider: string, expected: OAuthCredential, credentials: OAuthCredentials, owner: string, signal?: AbortSignal): Promise<boolean> {
    return this.transaction((db) => {
      const lease = db.query("SELECT owner, expires_at FROM oauth_refresh WHERE provider = ?").get(provider) as { owner: string; expires_at: number } | null;
      const data = this.readSync();
      if (!lease || lease.owner !== owner || lease.expires_at <= Date.now() || !sameOAuthCredential(data[provider], expected)) return false;
      data[provider] = { type: "oauth", ...credentials, revision: randomUUID() };
      this.persist(data);
      return true;
    }, signal);
  }

  async releaseOAuthRefresh(provider: string, owner: string): Promise<void> {
    await this.transaction((db) => { db.query("DELETE FROM oauth_refresh WHERE provider = ? AND owner = ?").run(provider, owner); });
  }

  private readSync(): AuthStorageData {
    try {
      const content = readFileSync(this.authPath, "utf8");
      if (!content.trim()) return {};
      const parsed = JSON.parse(content) as unknown;
      if (!isRecord(parsed)) throw new Error("auth.json must contain a JSON object");
      return parsed as AuthStorageData;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return {};
      throw error;
    }
  }

  private persist(data: AuthStorageData): void {
    const tempPath = `${this.authPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tempPath, this.authPath);
      chmodSync(this.authPath, 0o600);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }

  private async transaction<T>(operation: (db: Database) => T, signal?: AbortSignal): Promise<T> {
    mkdirSync(dirname(this.authPath), { recursive: true, mode: 0o700 });
    const coordinationPath = `${this.authPath}.coord.sqlite`;
    const lockDeadline = Date.now() + 5_000;
    while (true) {
      signal?.throwIfAborted();
      const db = new Database(coordinationPath, { create: true });
      try {
        chmodSync(coordinationPath, 0o600);
        // A busy_timeout would block the JS event loop, including Stop/deadline.
        // Only the short read/modify/write transaction is synchronous.
        db.exec("PRAGMA busy_timeout = 0");
        db.exec("CREATE TABLE IF NOT EXISTS oauth_refresh(provider TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
        return db.transaction(() => { signal?.throwIfAborted(); return operation(db); }).immediate();
      } catch (error) {
        const code = errorCode(error);
        if ((code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") || Date.now() >= lockDeadline) throw error;
      } finally {
        db.close();
      }
      await waitForAuthLock(signal);
    }
  }

  async status(provider: string, now: number = Date.now()): Promise<AuthStatus> {
    const credential = await this.get(provider);
    if (!credential) return { configured: false, authPath: this.authPath };
    if (credential.type === "api_key") {
      return { configured: true, authPath: this.authPath, type: "api_key" };
    }
    return {
      configured: true,
      authPath: this.authPath,
      type: "oauth",
      accountId: credential.accountId,
      expires: credential.expires,
      expired: credential.expires <= now,
    };
  }
}

export function sameOAuthCredential(value: AuthCredential | undefined, expected: OAuthCredential): boolean {
  return value?.type === "oauth"
    && value.revision === expected.revision
    && value.accountId === expected.accountId
    && value.refresh === expected.refresh
    && value.access === expected.access
    && value.expires === expected.expires;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) !== "ESRCH"; }
}

function waitForAuthLock(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Auth storage wait aborted", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 10);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
