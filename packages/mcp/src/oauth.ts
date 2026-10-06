import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {
  auth, extractWWWAuthenticateParams, type AuthProvider, type OAuthClientProvider, type OAuthClientMetadata, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { McpServerConfig } from "./config.js";
import { createBoundedMcpFetch } from "./http-ingress.js";
import { mcpServerIdentity } from "./identity.js";

type RemoteServer = Exclude<McpServerConfig, { type: "stdio" }>;
type IssuerContext = { issuer: string };
interface CredentialEntry {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  expiresAt?: number;
}
interface SavedCredentials {
  currentIssuer?: string;
  issuers: Record<string, CredentialEntry>;
  discovery?: OAuthDiscoveryState;
}
export interface McpOAuthOptions {
  directory: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onAuthenticated?: (server: McpServerConfig, assertCurrent: () => void) => Promise<void>;
}

/** One provider per effective target. Issuer credentials never cross targets. */
export class McpOAuthManager {
  private readonly providers = new Map<string, McpOAuthProvider>();
  private closed = false;

  constructor(private readonly options: McpOAuthOptions) {}

  provider(server: McpServerConfig): McpOAuthProvider | undefined {
    if (this.closed) throw new Error("MCP OAuth manager is closed");
    if (server.type === "stdio") return undefined;
    const identity = mcpServerIdentity(server);
    let provider = this.providers.get(identity);
    if (!provider) {
      provider = new McpOAuthProvider(server, this.options);
      this.providers.set(identity, provider);
    }
    return provider;
  }

  async logout(server: McpServerConfig): Promise<boolean> {
    const provider = this.provider(server);
    if (!provider) return false;
    const hadCredentials = (await provider.status()).authenticated || provider.pending;
    await provider.clear();
    this.providers.delete(mcpServerIdentity(server));
    return hadCredentials;
  }

  async reset(): Promise<void> {
    if (this.closed) throw new Error("MCP OAuth manager is closed");
    await Promise.all([...this.providers.values()].map((provider) => provider.close()));
    this.providers.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.providers.values()].map((provider) => provider.close()));
    this.providers.clear();
  }
}

export class McpOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  private saved: SavedCredentials = { issuers: {} };
  private readonly loaded: Promise<void>;
  private readonly abort = new AbortController();
  private readonly path: string;
  private readonly fetcher: typeof fetch;
  private writes: Promise<void> = Promise.resolve();
  private refresh: Promise<void> | undefined;
  private starting: Promise<{ status: "pending" | "authenticated"; url?: string }> | undefined;
  private listener: Server | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private redirect = "http://127.0.0.1/oauth/callback";
  private verifier: string | undefined;
  private stateValue: string | undefined;
  private authorizationUrl: string | undefined;
  private required = false;
  private authEpoch = 0;
  private readonly authFlow = new AsyncLocalStorage<number>();
  private completing = false;
  private requestedScopes: string[] | undefined;
  private callbackError: string | undefined;
  private resourceMetadataUrl: URL | undefined;
  private challengedScope: string | undefined;

  constructor(readonly server: RemoteServer, private readonly options: McpOAuthOptions) {
    if (server.oauth?.clientMetadataUrl) this.clientMetadataUrl = server.oauth.clientMetadataUrl;
    const key = createHash("sha256").update(mcpServerIdentity(server)).digest("hex");
    this.path = join(options.directory, `${key}.json`);
    this.fetcher = createBoundedMcpFetch(((input: RequestInfo | URL, init?: RequestInit) => {
      this.assertActive();
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : [])]);
      return (options.fetch ?? fetch)(input, { ...init, signal });
    }) as typeof fetch);
    this.loaded = this.load();
  }

  transportAuth(): AuthProvider {
    return {
      token: async () => (await this.tokens())?.access_token,
      onUnauthorized: async ({ response }) => {
        this.required = true;
        const challenge = extractWWWAuthenticateParams(response);
        this.resourceMetadataUrl = challenge.resourceMetadataUrl;
        this.challengedScope = challenge.scope;
        await this.loaded;
        const entry = this.saved.currentIssuer ? this.saved.issuers[this.saved.currentIssuer] : undefined;
        if (this.pending) throw new Error("MCP authorization is pending. Complete the browser sign-in first.");
        if (!entry?.tokens?.refresh_token) {
          if (entry?.tokens) await this.invalidateCredentials("tokens");
          throw new Error("MCP authorization required. Start MCP authentication to sign in.");
        }
        // A rejection may mean the issuer changed. Rediscover before refreshing.
        if (!this.refresh) {
          delete this.saved.discovery;
          this.refresh = this.refreshTokens().finally(() => { this.refresh = undefined; });
        }
        await this.refresh;
      },
    };
  }

  private async refreshTokens(): Promise<void> {
    await this.runAuth({ serverUrl: this.server.url, fetchFn: this.fetcher,
      ...(this.resourceMetadataUrl ? { resourceMetadataUrl: this.resourceMetadataUrl } : {}) });
  }

  get pending(): boolean { return this.listener !== undefined; }
  get redirectUrl(): string { return this.redirect; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Chili", application_type: "native", redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: this.server.oauth?.clientSecret ? "client_secret_post" : "none",
      ...((this.requestedScopes ?? this.server.oauth?.scopes)?.length
        ? { scope: (this.requestedScopes ?? this.server.oauth!.scopes)!.join(" ") } : {}),
    };
  }

  async status(): Promise<{ required: boolean; authenticated: boolean; error?: string }> {
    await this.loaded;
    const entry = this.saved.currentIssuer ? this.saved.issuers[this.saved.currentIssuer] : undefined;
    return {
      required: this.required || Boolean(this.server.oauth) || Boolean(entry?.tokens),
      authenticated: !this.pending && Boolean(entry?.tokens && (entry.tokens.refresh_token || entry.expiresAt === undefined || entry.expiresAt > Date.now())),
      ...(this.callbackError ? { error: this.callbackError } : {}),
    };
  }

  async clientInformation(context?: IssuerContext): Promise<StoredOAuthClientInformation | undefined> {
    await this.loaded;
    const issuer = context?.issuer ?? this.saved.currentIssuer;
    if (!issuer) return undefined;
    const stored = this.saved.issuers[issuer]?.client;
    if (stored) {
      if (this.server.oauth?.clientId === stored.client_id && this.server.oauth?.clientSecret !== stored.client_secret) {
        const { client_secret: _oldSecret, ...publicInfo } = stored;
        const updated = { ...publicInfo, ...(this.server.oauth?.clientSecret ? { client_secret: this.server.oauth.clientSecret } : {}) };
        await this.saveClientInformation(updated, { issuer });
        return updated;
      }
      return stored;
    }
    // A configured client is bound on first use; never reuse it for another issuer.
    if (this.server.oauth?.clientId && (!this.saved.currentIssuer || this.saved.currentIssuer === issuer)) {
      const client = { client_id: this.server.oauth.clientId, issuer,
        ...(this.server.oauth.clientSecret ? { client_secret: this.server.oauth.clientSecret } : {}) };
      await this.saveClientInformation(client, { issuer });
      return client;
    }
    return undefined;
  }

  async saveClientInformation(client: StoredOAuthClientInformation, context?: IssuerContext): Promise<void> {
    await this.loaded;
    const issuer = this.issuer(client.issuer, context);
    this.entry(issuer).client = { ...client, issuer };
    this.saved.currentIssuer = issuer;
    await this.persist();
  }

  async tokens(context?: IssuerContext): Promise<StoredOAuthTokens | undefined> {
    await this.loaded;
    this.assertActive();
    const issuer = context?.issuer ?? this.saved.currentIssuer;
    if (!issuer) return undefined;
    const entry = this.saved.issuers[issuer];
    if (!context && !this.pending && entry?.tokens?.refresh_token && entry.expiresAt !== undefined && entry.expiresAt <= Date.now() + 30_000) {
      if (!this.refresh) {
        this.refresh = this.refreshTokens().finally(() => { this.refresh = undefined; });
      }
      await this.refresh;
    }
    this.assertActive();
    return this.saved.issuers[issuer]?.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens, context?: IssuerContext): Promise<void> {
    await this.loaded;
    this.assertActive();
    const issuer = this.issuer(tokens.issuer, context);
    const entry = this.entry(issuer);
    entry.tokens = { ...tokens, issuer };
    if (tokens.expires_in === undefined) delete entry.expiresAt;
    else entry.expiresAt = Date.now() + tokens.expires_in * 1_000;
    this.saved.currentIssuer = issuer;
    this.required = true;
    await this.persist();
  }

  state(): string {
    if (!this.stateValue) this.stateValue = randomBytes(32).toString("hex");
    return this.stateValue;
  }
  saveCodeVerifier(value: string): void { this.assertActive(); this.verifier = value; }
  codeVerifier(): string {
    if (!this.verifier) throw new Error("MCP OAuth login has expired; start authorization again.");
    return this.verifier;
  }
  redirectToAuthorization(url: URL): void {
    this.required = true;
    if (!this.listener) throw new Error("MCP authorization required. Start MCP authentication to sign in.");
    this.authorizationUrl = url.href;
  }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    await this.loaded;
    return this.saved.discovery;
  }
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.loaded;
    this.assertActive();
    const configured = this.server.oauth;
    if (configured?.authorizationUrl && configured.authorizationUrl !== state.authorizationServerMetadata?.authorization_endpoint
      || configured?.tokenUrl && configured.tokenUrl !== state.authorizationServerMetadata?.token_endpoint) {
      throw new Error("Configured MCP OAuth endpoints do not match the authorization server metadata.");
    }
    this.saved.discovery = state;
    // Discovery and the verifier live through the same in-process redirect.
    // Persist discovery with credentials after successful registration/exchange.
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    await this.loaded;
    this.assertActive();
    const issuer = this.saved.discovery?.authorizationServerMetadata?.issuer ?? this.saved.currentIssuer;
    const entry = issuer ? this.saved.issuers[issuer] : undefined;
    if (scope === "all") this.saved = { issuers: {} };
    if (scope === "client" && entry) delete entry.client;
    if (scope === "tokens" && entry) { delete entry.tokens; delete entry.expiresAt; }
    if (scope === "discovery") delete this.saved.discovery;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    await this.persist();
  }

  async begin(input: { callbackUrl?: string; scopes?: string[] } = {}): Promise<{ status: "pending" | "authenticated"; url?: string }> {
    this.assertActive();
    if (this.starting) return this.starting;
    if (this.pending && this.authorizationUrl) return { status: "pending", url: this.authorizationUrl };
    this.starting = this.start(input).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(input: { callbackUrl?: string; scopes?: string[] }): Promise<{ status: "pending" | "authenticated"; url?: string }> {
    await this.loaded;
    await this.refresh;
    this.assertActive();
    this.callbackError = undefined;
    const callback = new URL(input.callbackUrl ?? this.server.oauth?.redirectUri ?? "http://127.0.0.1:0/oauth/callback");
    if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || callback.username || callback.password || callback.search || callback.hash) {
      throw new Error("MCP OAuth callback must be an HTTP loopback URL on 127.0.0.1 without query or fragment.");
    }
    this.requestedScopes = input.scopes;
    if (input.scopes?.some((scope) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) throw new Error("Invalid OAuth scope");
    this.stateValue = randomBytes(32).toString("hex");
    const callbackEpoch = this.authEpoch;
    this.listener = createServer((request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Referrer-Policy", "no-referrer");
      const url = new URL(request.url ?? "/", this.redirect);
      if (request.method !== "GET" || url.pathname !== callback.pathname) { response.writeHead(404).end("Not found"); return; }
      const state = url.searchParams.get("state") ?? "";
      if (callbackEpoch !== this.authEpoch || this.completing || !this.stateValue || !equalSecret(state, this.stateValue)) {
        response.writeHead(400).end("Invalid or expired authorization state."); return;
      }
      this.completing = true;
      void this.complete(url.searchParams).then(() => {
        response.end("Chili sign-in complete. You can close this window.");
      }, () => {
        if (callbackEpoch === this.authEpoch) this.callbackError = "MCP authorization failed. Start authentication again.";
        response.writeHead(400).end("MCP authorization failed. Start authentication again.");
      }).finally(() => { if (callbackEpoch === this.authEpoch) this.stopCallback(); });
    });
    try {
      const listener = this.listener;
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(Number(callback.port || 80), "127.0.0.1", () => { listener.off("error", reject); resolve(); });
      });
      this.assertActive();
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("Cannot start OAuth callback listener");
      callback.port = String(address.port);
      this.redirect = callback.href;
      this.timer = setTimeout(() => { this.callbackError = "MCP authorization timed out."; this.stopCallback(); }, this.options.timeoutMs ?? 300_000);
      this.timer.unref();
      // Fresh discovery catches authorization-server changes before credentials are reused.
      delete this.saved.discovery;
      const result = await this.runAuth({
        serverUrl: this.server.url, fetchFn: this.fetcher, forceReauthorization: true,
        ...(input.scopes ? { scope: input.scopes.join(" ") } : this.challengedScope ? { scope: this.challengedScope } : {}),
        ...(this.resourceMetadataUrl ? { resourceMetadataUrl: this.resourceMetadataUrl } : {}),
      });
      if (result === "AUTHORIZED") { this.stopCallback(); return { status: "authenticated" }; }
      if (!this.authorizationUrl) throw new Error("OAuth did not provide an authorization URL");
      return { status: "pending", url: this.authorizationUrl };
    } catch (error) {
      this.stopCallback();
      throw error;
    }
  }

  private async complete(params: URLSearchParams): Promise<void> {
    const epoch = this.authEpoch;
    const assertCurrent = () => {
      this.assertActive();
      if (epoch !== this.authEpoch) throw new Error("MCP OAuth authorization expired");
    };
    assertCurrent();
    if (params.has("error") || !params.get("code")) throw new Error("OAuth authorization was denied");
    await this.runAuth({
      serverUrl: this.server.url, authorizationCode: params.get("code")!, fetchFn: this.fetcher,
      ...(params.has("iss") ? { iss: params.get("iss")! } : {}),
    });
    assertCurrent();
    await this.options.onAuthenticated?.(this.server, assertCurrent);
    assertCurrent();
  }

  async clear(): Promise<void> {
    await this.close();
    this.saved = { issuers: {} };
    await rm(this.path, { force: true });
  }
  async close(): Promise<void> {
    this.abort.abort(new Error("MCP OAuth session closed"));
    this.stopCallback();
    await this.writes.catch(() => undefined);
  }
  private stopCallback(): void {
    if (this.listener) this.authEpoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.listener?.close();
    this.listener = undefined;
    this.verifier = undefined;
    this.stateValue = undefined;
    this.authorizationUrl = undefined;
    this.completing = false;
  }
  private issuer(value: string | undefined, context?: IssuerContext): string {
    this.assertActive();
    const issuer = context?.issuer ?? value;
    if (!issuer || value && value !== issuer) throw new Error("MCP OAuth issuer mismatch");
    return issuer;
  }
  private entry(issuer: string): CredentialEntry {
    if (!Object.hasOwn(this.saved.issuers, issuer)) Object.defineProperty(this.saved.issuers, issuer, { value: {}, writable: true, enumerable: true, configurable: true });
    return this.saved.issuers[issuer]!;
  }
  private runAuth(options: Parameters<typeof auth>[1]): ReturnType<typeof auth> {
    return this.authFlow.run(this.authEpoch, () => auth(this, options));
  }
  private assertActive(): void {
    this.abort.signal.throwIfAborted();
    const epoch = this.authFlow.getStore();
    if (epoch !== undefined && epoch !== this.authEpoch) throw new Error("MCP OAuth authorization expired");
  }
  private async load(): Promise<void> {
    try {
      const text = await readFile(this.path, "utf8");
      if (text.length > 1_048_576) throw new Error("MCP OAuth credential file is too large");
      const value = JSON.parse(text) as SavedCredentials;
      if (!value || typeof value !== "object" || !value.issuers || typeof value.issuers !== "object" || Array.isArray(value.issuers)) throw new Error("Invalid MCP OAuth credential file");
      this.saved = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private persist(): Promise<void> {
    this.assertActive();
    const contents = JSON.stringify(this.saved);
    const operation = this.writes.then(async () => {
      this.assertActive();
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
        this.assertActive();
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
