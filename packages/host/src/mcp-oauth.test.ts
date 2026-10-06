import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryToolRegistry } from "@chili/tools";
import { createHostMcpRuntime } from "./mcp-control.js";

test("Host OAuth login reconnects target aliases and logout removes all their executable tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-mcp-oauth-host-"));
  const cwd = join(root, "workspace"); const chiliHome = join(root, "profile");
  await mkdir(cwd); await mkdir(chiliHome);
  const authorizationHeaders: Array<string | null> = [];
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    authorizationHeaders.push(request.headers.get("authorization"));
    if (request.headers.get("authorization") !== "Bearer signed-in") return new Response(null, { status: 401 });
    const body = await request.json() as { id: number; method: string };
    const result = body.method === "server/discover"
      ? { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
      : { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [{ name: "run", inputSchema: { type: "object" } }] };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  } });
  const target = { type: "http", url: remote.url.href, oauth: { clientId: "test-client" } };
  await writeFile(join(chiliHome, "mcp.json"), JSON.stringify({ servers: { secure: target, alias: target } }));
  const registry = new InMemoryToolRegistry();
  const runtime = await createHostMcpRuntime({ cwd, chiliHome, registries: [registry], oauthFetch: (async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.includes("oauth-protected-resource")) return Response.json({ resource: remote.url.href, authorization_servers: ["https://issuer.test"] });
    if (url.pathname.includes(".well-known")) return Response.json({ issuer: "https://issuer.test", authorization_endpoint: "https://issuer.test/authorize",
      token_endpoint: "https://issuer.test/token", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (url.pathname === "/token") return Response.json({ access_token: "signed-in", token_type: "Bearer", expires_in: 3600 });
    return new Response(null, { status: 404 });
  }) as typeof fetch }, { list: async () => ({ roots: [], diagnostics: [] }), reload: async () => ({ roots: [], diagnostics: [] }), run: async () => { throw new Error("unused"); } });
  try {
    expect(await runtime.control.get!("secure")).toMatchObject({ status: "auth_required", auth: { authenticated: false } });
    const login = await runtime.control.auth!("secure");
    expect(login.status).toBe("pending");
    const authorization = new URL(login.url!);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ code: "code", state: authorization.searchParams.get("state")!, iss: "https://issuer.test" }).toString();
    expect((await fetch(callback)).status).toBe(200);
    expect(await runtime.control.get!("secure")).toMatchObject({ status: "running", toolCount: 1, auth: { authenticated: true } });
    expect(await runtime.control.get!("alias")).toMatchObject({ status: "running", toolCount: 1, auth: { authenticated: true } });
    expect(authorizationHeaders).toContain("Bearer signed-in");
    expect(await runtime.control.logout!("secure")).toEqual({ server: "secure", loggedOut: true });
    expect(await runtime.control.get!("secure")).toMatchObject({ status: "stopped", toolCount: 0, auth: { authenticated: false } });
    expect(await runtime.control.get!("alias")).toMatchObject({ status: "stopped", toolCount: 0, auth: { authenticated: false } });
  } finally { await runtime.close(); remote.stop(true); await rm(root, { recursive: true, force: true }); }
});
