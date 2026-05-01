import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthCredentials } from "../auth.js";
import { generatePKCE } from "./pkce.js";

export const OPENAI_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const OPENAI_CODEX_SCOPE = "openid profile email offline_access";
export const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";

const CALLBACK_HOST = process.env.CHILI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 1455;

export interface OAuthPrompt {
  message: string;
}

export interface OpenAICodexLoginOptions {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt?: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  originator?: string;
  fetch?: typeof fetch;
}

interface TokenSuccess {
  type: "success";
  credentials: OAuthCredentials;
}

interface TokenFailure {
  type: "failed";
  message: string;
}

type TokenResult = TokenSuccess | TokenFailure;

interface LocalOAuthServer {
  close: () => void;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
}

interface OpenAICodexRefreshOptions {
  fetch?: typeof fetch;
  previous?: Partial<OAuthCredentials>;
}

type TokenResponseJson = Record<string, unknown>;

const DEFAULT_TOKEN_EXPIRES_MS = 60 * 60 * 1000;

export function createOpenAICodexAuthorizationFlow(originator: string = "chili"): { verifier: string; state: string; url: string } {
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString("hex");
  const url = new URL(OPENAI_CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_CODEX_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", OPENAI_CODEX_REDIRECT_URI);
  url.searchParams.set("scope", OPENAI_CODEX_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return { verifier, state, url: url.toString() };
}

export async function loginOpenAICodex(options: OpenAICodexLoginOptions): Promise<OAuthCredentials> {
  const { verifier, state, url } = createOpenAICodexAuthorizationFlow(options.originator);
  const server = await startLocalOAuthServer(state);
  options.onAuth({ url, instructions: "Complete ChatGPT login in the browser to finish Chili Codex authentication." });

  try {
    const code = await waitForAuthorizationCode(server, state, options);
    if (!code) throw new Error("Missing authorization code");
    const result = await exchangeOpenAICodexAuthorizationCode(code, verifier, options.fetch);
    if (result.type === "failed") throw new Error(result.message);
    return result.credentials;
  } finally {
    server.close();
  }
}

export async function refreshOpenAICodexToken(
  refreshToken: string,
  options: OpenAICodexRefreshOptions = {},
): Promise<OAuthCredentials> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
    }),
  });
  const previous: Partial<OAuthCredentials> = { ...(options.previous ?? {}) };
  if (!previous.refresh) previous.refresh = refreshToken;
  const result = await readTokenResponse(response, previous);
  if (result.type === "failed") throw new Error(result.message);
  return result.credentials;
}

export async function exchangeOpenAICodexAuthorizationCode(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResult> {
  const response = await fetchImpl(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: OPENAI_CODEX_REDIRECT_URI,
    }),
  });
  return readTokenResponse(response);
}

export function extractOpenAICodexAccountId(token: string): string {
  const payload = decodeJwt(token);
  const auth = payload?.[OPENAI_CODEX_JWT_CLAIM_PATH];
  const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
  if (typeof accountId !== "string" || !accountId) throw new Error("Failed to extract ChatGPT account id from token");
  return accountId;
}

export function parseOpenAICodexAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return authorizationInput(url.searchParams.get("code"), url.searchParams.get("state"));
  } catch {
    // Continue with plain code or query-string parsing.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return authorizationInput(code, state);
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return authorizationInput(params.get("code"), params.get("state"));
  }

  return { code: value };
}

function authorizationInput(code: string | null | undefined, state: string | null | undefined): { code?: string; state?: string } {
  const result: { code?: string; state?: string } = {};
  if (code) result.code = code;
  if (state) result.state = state;
  return result;
}

async function waitForAuthorizationCode(
  server: LocalOAuthServer,
  state: string,
  options: OpenAICodexLoginOptions,
): Promise<string | undefined> {
  let manualCode: string | undefined;
  let manualError: Error | undefined;
  const manualPromise = options.onManualCodeInput?.()
    .then((input) => {
      manualCode = input;
      server.cancelWait();
    })
    .catch((error) => {
      manualError = error instanceof Error ? error : new Error(String(error));
      server.cancelWait();
    });

  const result = await server.waitForCode();
  if (manualError) throw manualError;
  if (result?.code) return result.code;

  if (manualPromise) await manualPromise;
  if (manualError) throw manualError;
  if (manualCode) return parseManualAuthorizationCode(manualCode, state);

  if (!options.onPrompt) {
    throw new Error("Authorization callback did not complete and no manual code prompt is available");
  }
  const input = await options.onPrompt({ message: "Paste the authorization code or full redirect URL:" });
  return parseManualAuthorizationCode(input, state);
}

function parseManualAuthorizationCode(input: string, expectedState: string): string | undefined {
  const parsed = parseOpenAICodexAuthorizationInput(input);
  if (parsed.state && parsed.state !== expectedState) throw new Error("OAuth state mismatch");
  return parsed.code;
}

async function readTokenResponse(response: Response, previous: Partial<OAuthCredentials> = {}): Promise<TokenResult> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { type: "failed", message: `OpenAI Codex token request failed with HTTP ${response.status}: ${text}` };
  }

  const json = await response.json().catch(() => undefined) as unknown;
  if (!isRecord(json)) {
    return { type: "failed", message: "OpenAI Codex token response was not a JSON object" };
  }

  const accessToken = stringField(json, "access_token");
  if (!accessToken) {
    return { type: "failed", message: "OpenAI Codex token response was missing access_token" };
  }

  const idToken = stringField(json, "id_token");
  const refreshToken = stringField(json, "refresh_token") ?? previous.refresh;
  if (!refreshToken) {
    return { type: "failed", message: "OpenAI Codex token response was missing refresh_token" };
  }

  const accountId = resolveAccountId(idToken, previous.accountId, accessToken);
  if (!accountId) {
    return { type: "failed", message: "OpenAI Codex token response was missing ChatGPT account id" };
  }

  return {
    type: "success",
    credentials: {
      access: accessToken,
      refresh: refreshToken,
      expires: resolveExpiration(json, idToken ?? accessToken, accessToken, previous.expires),
      accountId,
    },
  };
}

function stringField(record: TokenResponseJson, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: TokenResponseJson, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveAccountId(idToken: string | undefined, previousAccountId: string | undefined, accessToken: string): string | undefined {
  return extractAccountId(idToken) ?? previousAccountId ?? extractAccountId(accessToken);
}

function extractAccountId(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    return extractOpenAICodexAccountId(token);
  } catch {
    return undefined;
  }
}

function resolveExpiration(
  json: TokenResponseJson,
  primaryToken: string,
  accessToken: string,
  previousExpires: number | undefined,
): number {
  const expiresIn = numberField(json, "expires_in");
  if (expiresIn !== undefined) return Date.now() + expiresIn * 1000;

  const expiresAt = numberField(json, "expires_at");
  if (expiresAt !== undefined) return expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt;

  return jwtExpiration(primaryToken)
    ?? jwtExpiration(accessToken)
    ?? futurePreviousExpiration(previousExpires)
    ?? Date.now() + DEFAULT_TOKEN_EXPIRES_MS;
}

function futurePreviousExpiration(expires: number | undefined): number | undefined {
  return expires !== undefined && expires > Date.now() ? expires : undefined;
}

function jwtExpiration(token: string): number | undefined {
  const exp = decodeJwt(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
}

function startLocalOAuthServer(state: string): Promise<LocalOAuthServer> {
  let settleWait: ((value: { code: string } | null) => void) | undefined;
  const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
    let settled = false;
    settleWait = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  let server: Server | undefined;
  const fallbackServer = (): LocalOAuthServer => ({
    close: () => undefined,
    cancelWait: () => settleWait?.(null),
    waitForCode: async () => null,
  });

  return new Promise((resolve) => {
    server = createServer((request, response) => {
      try {
        const url = new URL(request.url || "", OPENAI_CODEX_REDIRECT_URI);
        if (url.pathname !== "/auth/callback") {
          response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
          response.end(authHtml("OpenAI Codex Login", "Callback route not found."));
          return;
        }
        if (url.searchParams.get("state") !== state) {
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end(authHtml("OpenAI Codex Login", "State mismatch."));
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end(authHtml("OpenAI Codex Login", "Missing authorization code."));
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(authHtml("OpenAI Codex Login", "Authentication completed. You can close this window."));
        settleWait?.({ code });
      } catch {
        response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
        response.end(authHtml("OpenAI Codex Login", "Internal error while processing OAuth callback."));
      }
    });

    server.once("error", () => {
      settleWait?.(null);
      resolve(fallbackServer());
    });
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      const activeServer = server;
      resolve({
        close: () => {
          try {
            activeServer?.close();
          } catch {
            // Ignore close errors after the callback has settled.
          }
        },
        cancelWait: () => settleWait?.(null),
        waitForCode: () => waitForCodePromise,
      });
    });
  });
}

function decodeJwt(token: string): Record<string, unknown> | undefined {
  const [, payload] = token.split(".");
  if (!payload) return undefined;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function authHtml(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
