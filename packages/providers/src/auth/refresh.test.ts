import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAuthPath, FileAuthStorage, type OAuthCredentials } from "./storage.js";
import { OpenAICodexResponsesModel } from "../vendors/openai/index.js";
import { OPENAI_CODEX_TOKEN_URL, refreshOpenAICodexToken } from "../vendors/openai/oauth.js";
import { OPENAI_CODEX_PROVIDER_ID } from "../models.js";
import type { ModelStreamInput } from "../types.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const fakeCredentials: OAuthCredentials = { access: "fake-access", refresh: "fake-refresh", accountId: "fake-account", expires: 0 };

async function storage(): Promise<FileAuthStorage> {
  const dir = await mkdtemp(join(tmpdir(), "chili-oauth-contract-"));
  dirs.push(dir);
  const result = new FileAuthStorage(join(dir, "auth.json"));
  await result.setOAuthCredentials(OPENAI_CODEX_PROVIDER_ID, fakeCredentials);
  return result;
}

function gate<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}
function tokenResponse(): Response { return Response.json({ access_token: "fake-fresh-access", refresh_token: "fake-fresh-refresh", expires_in: 3600 }); }
function completedResponse(): Response { return new Response('data: {"type":"response.completed","response":{"id":"fake","status":"completed"}}\n\n', { headers: { "content-type": "text/event-stream" } }); }
async function consume(model: OpenAICodexResponsesModel, input: Partial<ModelStreamInput> = {}): Promise<void> {
  for await (const _ of model.stream({ messages: [], ...input })) { /* collect through terminal */ }
}

function controlledModel(authStorage: FileAuthStorage) {
  const started = gate();
  const release = gate();
  let refreshCalls = 0;
  let modelCalls = 0;
  let refreshSignal: AbortSignal | null | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === OPENAI_CODEX_TOKEN_URL) {
      refreshCalls++;
      refreshSignal = init?.signal;
      started.resolve();
      await release.promise; // Intentionally ignores abort to exercise late completion fencing.
      return tokenResponse();
    }
    modelCalls++;
    return completedResponse();
  }) as unknown as typeof fetch;
  return { model: new OpenAICodexResponsesModel({ authStorage, fetch: fetchImpl }), started, release,
    state: () => ({ refreshCalls, modelCalls, refreshSignal }), fetchImpl };
}

test("same-account concurrent refresh is shared and cancelling one request preserves other consumers", async () => {
  const auth = await storage();
  const fixture = controlledModel(auth);
  const controller = new AbortController();
  const first = consume(fixture.model, { signal: controller.signal }).catch((error: Error) => error);
  const second = consume(new OpenAICodexResponsesModel({ authStorage: new FileAuthStorage(auth.authPath), fetch: fixture.fetchImpl }));
  await fixture.started.promise;
  await Bun.sleep(15);
  controller.abort();
  expect(await first).toMatchObject({ name: "AbortError" });
  expect(fixture.state().refreshSignal?.aborted).toBe(false);
  fixture.release.resolve();
  await second;
  expect(fixture.state().refreshCalls).toBe(1);
  expect(fixture.state().modelCalls).toBe(1);
  expect((await auth.getOAuthCredentials(OPENAI_CODEX_PROVIDER_ID))?.access).toBe("fake-fresh-access");
});

test("all consumers cancelling settles promptly, aborts refresh, and prevents late writes", async () => {
  const auth = await storage();
  const original = await auth.read();
  const fixture = controlledModel(auth);
  const controllers = [new AbortController(), new AbortController()];
  const requests = controllers.map((controller) => consume(fixture.model, { signal: controller.signal }).catch((error: Error) => error));
  await fixture.started.promise;
  controllers.forEach((controller) => controller.abort());
  expect(await Promise.all(requests)).toEqual([expect.objectContaining({ name: "AbortError" }), expect.objectContaining({ name: "AbortError" })]);
  await Bun.sleep(5);
  expect(fixture.state().refreshSignal?.aborted).toBe(true);
  fixture.release.resolve();
  await Bun.sleep(10);
  expect(await auth.read()).toEqual(original);
  expect(fixture.state().modelCalls).toBe(0);
});

for (const change of ["logout", "switch", "same-account-login"] as const) {
  test(`a late OAuth refresh cannot overwrite ${change}`, async () => {
    const auth = await storage();
    const fixture = controlledModel(auth);
    const request = consume(fixture.model).catch((error: Error) => error);
    await fixture.started.promise;
    if (change === "logout") await new FileAuthStorage(auth.authPath).remove(OPENAI_CODEX_PROVIDER_ID);
    else await new FileAuthStorage(auth.authPath).setOAuthCredentials(OPENAI_CODEX_PROVIDER_ID, {
      ...fakeCredentials,
      accountId: change === "switch" ? "fake-account-other" : fakeCredentials.accountId,
    });
    const afterChange = await auth.read();
    fixture.release.resolve();
    expect(await request).toMatchObject({ message: expect.stringContaining("credentials changed") });
    expect(await auth.read()).toEqual(afterChange);
    expect(fixture.state().modelCalls).toBe(0);
  });
}

test("refresh deadline settles even if transport ignores abort and cannot persist its late result", async () => {
  const auth = await storage();
  const fixture = controlledModel(auth);
  const model = new OpenAICodexResponsesModel({ authStorage: auth, fetch: fixture.fetchImpl, authRefreshTimeoutMs: 25 });
  await expect(consume(model)).rejects.toMatchObject({ name: "TimeoutError", retryable: false });
  expect(fixture.state().refreshSignal?.aborted).toBe(true);
  fixture.release.resolve();
  await Bun.sleep(10);
  expect((await auth.getOAuthCredentials(OPENAI_CODEX_PROVIDER_ID))?.access).toBe(fakeCredentials.access);
});

test("a contended cross-process auth lock cannot block request cancellation or allow a late commit", async () => {
  const auth = await storage();
  const original = await auth.read();
  const fixture = controlledModel(auth);
  const controller = new AbortController();
  const request = consume(fixture.model, { signal: controller.signal }).catch((error: Error) => error);
  await fixture.started.promise;
  const blocker = new Database(`${auth.authPath}.coord.sqlite`);
  blocker.exec("BEGIN IMMEDIATE");
  try {
    fixture.release.resolve();
    await Bun.sleep(10);
    controller.abort();
    expect(await request).toMatchObject({ name: "AbortError" });
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
  }
  await Bun.sleep(20);
  expect(await auth.read()).toEqual(original);
  expect(fixture.state().modelCalls).toBe(0);
});

test("refresh rejects a server returning a different account identity", async () => {
  const auth = await storage();
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-other-account" } })).toString("base64url");
  const model = new OpenAICodexResponsesModel({ authStorage: auth, fetch: (async () => Response.json({ access_token: "fake-next", refresh_token: "fake-next", id_token: `e30.${payload}.fake`, expires_in: 3600 })) as unknown as typeof fetch });
  await expect(consume(model)).rejects.toThrow("different account");
  expect((await auth.getOAuthCredentials(OPENAI_CODEX_PROVIDER_ID))?.accountId).toBe(fakeCredentials.accountId);
});

test("a fresh credential revoked during request-identity recording is not dispatched", async () => {
  const auth = await storage();
  await auth.setOAuthCredentials(OPENAI_CODEX_PROVIDER_ID, { ...fakeCredentials, expires: Date.now() + 3600_000 });
  const expected = await auth.getOAuthCredentials(OPENAI_CODEX_PROVIDER_ID);
  let modelCalls = 0;
  const model = new OpenAICodexResponsesModel({ authStorage: auth, fetch: (async () => { modelCalls++; return completedResponse(); }) as unknown as typeof fetch });
  await expect(consume(model, { onRequestIdentity: async (identity) => {
    expect(identity).toMatchObject({ provider: OPENAI_CODEX_PROVIDER_ID, accountId: fakeCredentials.accountId, credentialVersion: expected?.revision });
    expect(JSON.stringify(identity)).not.toContain(fakeCredentials.access);
    await new FileAuthStorage(auth.authPath).remove(OPENAI_CODEX_PROVIDER_ID);
  } })).rejects.toThrow("credentials changed before model dispatch");
  expect(modelCalls).toBe(0);
});

test("refresh checks account identity from access JWT even when the response omits id_token", async () => {
  const auth = await storage();
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-other-account" } })).toString("base64url");
  const model = new OpenAICodexResponsesModel({ authStorage: auth, fetch: (async () => Response.json({ access_token: `e30.${payload}.fake`, refresh_token: "fake-next", expires_in: 3600 })) as unknown as typeof fetch });
  await expect(consume(model)).rejects.toThrow("different account");
  expect((await auth.getOAuthCredentials(OPENAI_CODEX_PROVIDER_ID))?.accountId).toBe(fakeCredentials.accountId);
});

test("direct token refresh honours pre-abort without contacting its transport", async () => {
  let called = false;
  await expect(refreshOpenAICodexToken("fake", { signal: AbortSignal.abort(), fetch: (async () => { called = true; return tokenResponse(); }) as unknown as typeof fetch })).rejects.toMatchObject({ name: "AbortError" });
  expect(called).toBe(false);
});

test("legacy auth.json upgrades on write and explicit profile paths ignore global auth overrides", async () => {
  const auth = await storage();
  await writeFile(auth.authPath, JSON.stringify({ [OPENAI_CODEX_PROVIDER_ID]: { type: "oauth", ...fakeCredentials } }));
  const model = new OpenAICodexResponsesModel({ chiliHome: auth.authPath.slice(0, -"/auth.json".length), fetch: (async (url: string | URL | Request) => String(url) === OPENAI_CODEX_TOKEN_URL ? tokenResponse() : completedResponse()) as unknown as typeof fetch });
  await consume(model);
  expect((await auth.getOAuthCredentials(OPENAI_CODEX_PROVIDER_ID))?.revision).toBeString();
  expect(defaultAuthPath("/tmp/explicit-fake-profile")).toBe("/tmp/explicit-fake-profile/auth.json");
  expect(await readFile(`${auth.authPath}.coord.sqlite`, "utf8")).not.toContain("fake-fresh-access");
});

test("two real Bun processes share one refresh and persist one rotated credential", async () => {
  const auth = await storage();
  let refreshCalls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    refreshCalls++;
    await Bun.sleep(150);
    return tokenResponse();
  } });
  try {
    const source = `
      import { OpenAICodexResponsesModel } from ${JSON.stringify(join(import.meta.dir, "../vendors/openai/index.ts"))};
      import { FileAuthStorage } from ${JSON.stringify(join(import.meta.dir, "storage.ts"))};
      import { OPENAI_CODEX_TOKEN_URL } from ${JSON.stringify(join(import.meta.dir, "../vendors/openai/oauth.ts"))};
      const model = new OpenAICodexResponsesModel({ authStorage: new FileAuthStorage(${JSON.stringify(auth.authPath)}), fetch: async (url, init) => String(url) === OPENAI_CODEX_TOKEN_URL ? fetch(${JSON.stringify(server.url.href)}, init) : new Response('data: {"type":"response.completed","response":{"id":"fake","status":"completed"}}\\n\\n', {headers:{"content-type":"text/event-stream"}}) });
      for await (const event of model.stream({messages:[]})) {}
    `;
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(async (child) => ({ code: await child.exited, error: await new Response(child.stderr).text() })));
    expect(results).toEqual([{ code: 0, error: "" }, { code: 0, error: "" }]);
    expect(refreshCalls).toBe(1);
    expect((await auth.getOAuthCredentials(OPENAI_CODEX_PROVIDER_ID))?.refresh).toBe("fake-fresh-refresh");
  } finally { server.stop(true); }
});

test("cross-process credential updates preserve unrelated providers and dead refresh owners are reclaimed", async () => {
  const auth = await storage();
  const children = [0, 1, 2].map((index) => Bun.spawn([process.execPath, "--eval", `
    import { FileAuthStorage } from ${JSON.stringify(join(import.meta.dir, "storage.ts"))};
    const storage = new FileAuthStorage(${JSON.stringify(auth.authPath)});
    for (let i = 0; i < 10; i++) await storage.set('fake-provider-${index}-' + i, {type:'api_key', key:'fake'});
    ${index === 0 ? `const value = await storage.getOAuthCredentials(${JSON.stringify(OPENAI_CODEX_PROVIDER_ID)}); await storage.claimOAuthRefresh(${JSON.stringify(OPENAI_CODEX_PROVIDER_ID)}, value, 'dead-owner', Date.now() + 30000);` : ""}
  `], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async (child) => ({ code: await child.exited, error: await new Response(child.stderr).text() })));
  expect(results).toEqual(Array.from({ length: 3 }, () => ({ code: 0, error: "" })));
  expect(Object.keys(await auth.read())).toHaveLength(31);
  await consume(new OpenAICodexResponsesModel({ authStorage: auth, fetch: (async (url: string | URL | Request) => String(url) === OPENAI_CODEX_TOKEN_URL ? tokenResponse() : completedResponse()) as unknown as typeof fetch }));
  expect((await auth.getOAuthCredentials(OPENAI_CODEX_PROVIDER_ID))?.access).toBe("fake-fresh-access");
});
