import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "./config.js";
import { McpOAuthManager } from "./oauth.js";

async function fixture(options: { expiresIn?: number; dynamic?: boolean; onToken?: () => Promise<void> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chili-mcp-oauth-"));
  const grants: URLSearchParams[] = [];
  let registrations = 0;
  let issuer = "https://auth.example";
  const config: McpServerConfig = {
    name: "secure", type: "http", url: "https://mcp.example/mcp", headers: {},
    oauth: options.dynamic ? {} : { clientId: "chili-test", scopes: ["read"] },
    enabled: true, required: false, trust: false, source: "user", raw: {},
  };
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.includes("oauth-protected-resource")) return Response.json({ resource: config.url, authorization_servers: [issuer], scopes_supported: ["read"] });
    if (url.pathname.includes(".well-known")) return Response.json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true,
    });
    if (url.pathname === "/register") {
      registrations++;
      return Response.json({ ...JSON.parse(String(init?.body)), client_id: `registered-${registrations}` }, { status: 201 });
    }
    if (url.pathname === "/token") {
      grants.push(new URLSearchParams(String(init?.body)));
      await options.onToken?.();
      return Response.json({ access_token: `access-${grants.length}`, refresh_token: `refresh-${grants.length}`, token_type: "Bearer",
        expires_in: grants.length === 1 ? options.expiresIn ?? 3600 : 3600, scope: "read" });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const manager = new McpOAuthManager({ directory, fetch: fakeFetch });
  const provider = manager.provider(config)!;
  const callback = async (authorization: string, changes: Record<string, string> = {}) => {
    const url = new URL(authorization);
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    redirect.search = new URLSearchParams({ code: "test-code", state: url.searchParams.get("state")!, iss: issuer, ...changes }).toString();
    return fetch(redirect);
  };
  return { directory, config, manager, provider, grants, fakeFetch, callback, registrations: () => registrations,
    changeIssuer: (value: string) => { issuer = value; },
    close: async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("OAuth browser callback uses state, PKCE and issuer and persists private target-bound credentials", async () => {
  const f = await fixture();
  try {
    const login = await f.provider.begin();
    expect(login.status).toBe("pending");
    const url = new URL(login.url!);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")!.length).toBeGreaterThan(40);
    expect((await f.callback(login.url!, { state: "wrong" })).status).toBe(400);
    expect(f.grants).toHaveLength(0);
    expect((await f.callback(login.url!)).status).toBe(200);
    expect(f.grants[0]!.get("code_verifier")).toBeTruthy();
    expect(f.grants[0]!.get("grant_type")).toBe("authorization_code");
    expect(await f.provider.status()).toMatchObject({ authenticated: true });
    const files = await readdir(f.directory);
    expect(files).toHaveLength(1);
    expect((await stat(join(f.directory, files[0]!))).mode & 0o777).toBe(0o600);
    const contents = await readFile(join(f.directory, files[0]!), "utf8");
    expect(contents).not.toContain("code_verifier");
    expect(contents).not.toContain(url.searchParams.get("state")!);
    const restored = new McpOAuthManager({ directory: f.directory, fetch: f.fakeFetch });
    try { expect((await restored.provider(f.config)!.tokens())?.access_token).toBe("access-1"); } finally { await restored.close(); }
    expect(await f.manager.provider({ ...f.config, url: "https://other.example/mcp" } as McpServerConfig)!.tokens()).toBeUndefined();
  } finally { await f.close(); }
});

test("OAuth mismatched issuer cannot redeem a code", async () => {
  const f = await fixture();
  try {
    const login = await f.provider.begin();
    expect((await f.callback(login.url!, { iss: "https://wrong.example" })).status).toBe(400);
    expect(f.grants).toHaveLength(0);
    expect(await f.provider.status()).toMatchObject({ authenticated: false });
  } finally { await f.close(); }
});

test("OAuth expired-token refresh is shared and logout prevents credential reuse", async () => {
  const f = await fixture({ expiresIn: 0 });
  try {
    const login = await f.provider.begin();
    expect((await f.callback(login.url!)).status).toBe(200);
    const tokens = await Promise.all([f.provider.tokens(), f.provider.tokens(), f.provider.tokens()]);
    expect(tokens.map((token) => token?.access_token)).toEqual(["access-2", "access-2", "access-2"]);
    expect(f.grants.map((grant) => grant.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
    expect(await f.manager.logout(f.config)).toBe(true);
    expect(await readdir(f.directory)).toEqual([]);
    await expect(f.provider.saveTokens({ access_token: "late", token_type: "Bearer", issuer: "https://auth.example" })).rejects.toThrow("closed");
    expect(await f.manager.provider(f.config)!.tokens()).toBeUndefined();
  } finally { await f.close(); }
});

test("OAuth registers separately when the discovered issuer changes", async () => {
  const f = await fixture({ dynamic: true });
  try {
    const first = await f.provider.begin();
    expect((await f.callback(first.url!)).status).toBe(200);
    f.changeIssuer("https://new-auth.example");
    const second = await f.provider.begin();
    expect(new URL(second.url!).searchParams.get("client_id")).toBe("registered-2");
    expect(f.registrations()).toBe(2);
    expect((await f.callback(second.url!)).status).toBe(200);
  } finally { await f.close(); }
});

test("OAuth requires a loopback callback and shares concurrent login starts", async () => {
  const f = await fixture();
  try {
    await expect(f.provider.begin({ callbackUrl: "https://external.example/callback" })).rejects.toThrow("loopback");
    const [first, second] = await Promise.all([f.provider.begin(), f.provider.begin()]);
    expect(first.url).toBe(second.url);
    expect(await f.manager.logout(f.config)).toBe(true);
    await expect(f.callback(first.url!)).rejects.toThrow();
  } finally { await f.close(); }
});

test("a configured OAuth client is issuer-bound even before the first login completes", async () => {
  const f = await fixture();
  try {
    expect(await f.provider.clientInformation({ issuer: "https://auth.example" })).toMatchObject({ client_id: "chili-test", issuer: "https://auth.example" });
    expect(await f.provider.clientInformation({ issuer: "https://another.example" })).toBeUndefined();
  } finally { await f.close(); }
});

test("logout during code exchange fences a late token response", async () => {
  let finish!: () => void;
  const exchange = new Promise<void>((resolve) => { finish = resolve; });
  const f = await fixture({ onToken: () => exchange });
  try {
    const login = await f.provider.begin();
    const callback = f.callback(login.url!);
    for (let attempt = 0; f.grants.length === 0 && attempt < 100; attempt++) await Bun.sleep(5);
    expect(f.grants).toHaveLength(1);
    await f.manager.logout(f.config);
    finish();
    expect((await callback).status).toBe(400);
    expect(await f.manager.provider(f.config)!.tokens()).toBeUndefined();
    expect(await readdir(f.directory)).toEqual([]);
  } finally { finish(); await f.close(); }
});
