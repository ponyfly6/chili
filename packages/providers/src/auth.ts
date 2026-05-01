import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ApiKeyCredential {
  type: "api_key";
  key: string;
}

export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

export type OAuthCredential = OAuthCredentials & {
  type: "oauth";
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

export function defaultAuthPath(): string {
  return process.env.CHILI_AUTH_FILE || join(defaultChiliHome(), "auth.json");
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
    await mkdir(dirname(this.authPath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.authPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(tempPath, 0o600).catch(() => undefined);
      await rename(tempPath, this.authPath);
      await chmod(this.authPath, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(provider: string): Promise<AuthCredential | undefined> {
    return (await this.read())[provider];
  }

  async getOAuthCredentials(provider: string): Promise<OAuthCredential | undefined> {
    const credential = await this.get(provider);
    return credential?.type === "oauth" ? credential : undefined;
  }

  async set(provider: string, credential: AuthCredential): Promise<void> {
    const data = await this.read();
    data[provider] = credential;
    await this.write(data);
  }

  async setOAuthCredentials(provider: string, credentials: OAuthCredentials): Promise<void> {
    await this.set(provider, { type: "oauth", ...credentials });
  }

  async remove(provider: string): Promise<boolean> {
    const data = await this.read();
    const existed = data[provider] !== undefined;
    delete data[provider];
    await this.write(data);
    return existed;
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

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
