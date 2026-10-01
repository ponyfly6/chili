import { expect, test } from "bun:test";
import type { McpServerConfig } from "./config.js";
import { createSdkMcpClient } from "./sdk-client.js";

const VERSION = "2026-07-28";

test("an already-aborted initialization sends no discovery or handshake request", async () => {
  const remote = fixture();
  const client = createSdkMcpClient(remote.config);
  const controller = new AbortController();
  controller.abort(new Error("fixture cancelled before initialization"));
  try {
    await expect(client.initialize({ signal: controller.signal })).rejects.toBeInstanceOf(Error);
    expect(remote.requests).toEqual([]);
  } finally {
    remote.release.resolve();
    await client.close();
    remote.close();
  }
});

test("closing during discovery rejects its initialization and cannot send later tools requests", async () => {
  const remote = fixture(true);
  const client = createSdkMcpClient(remote.config);
  const opening = client.initialize();
  void opening.catch(() => undefined);
  try {
    await deadline(remote.entered.promise);
    await deadline(client.close());
    remote.release.resolve();
    await expect(opening).rejects.toBeInstanceOf(Error);
    // Some SDK list methods return an empty list when capabilities are absent;
    // either that result or a closed-client error must remain entirely local.
    await client.listTools().catch(() => undefined);
    expect(remote.requests).toEqual(["server/discover"]);
  } finally {
    remote.release.resolve();
    await opening.catch(() => undefined);
    await client.close();
    remote.close();
  }
});

test("concurrent initialize calls share one in-flight discovery", async () => {
  const remote = fixture(true);
  const client = createSdkMcpClient(remote.config);
  const first = client.initialize();
  const second = client.initialize();
  void first.catch(() => undefined);
  void second.catch(() => undefined);
  try {
    await deadline(remote.entered.promise);
    // Both calls have reached their first await; allow the second HTTP request,
    // if incorrectly created, to reach the local server before releasing it.
    await Bun.sleep(25);
    expect(remote.requests).toEqual(["server/discover"]);
    remote.release.resolve();
    expect(await first).toMatchObject({ protocolVersion: VERSION });
    expect(await second).toMatchObject({ protocolVersion: VERSION });
    expect(remote.requests).toEqual(["server/discover"]);
  } finally {
    remote.release.resolve();
    await Promise.allSettled([first, second]);
    await client.close();
    remote.close();
  }
});

function fixture(blockDiscovery = false) {
  const requests: string[] = [];
  const entered = deferred();
  const release = deferred();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.json() as { id: number | string; method: string };
      requests.push(body.method);
      if (body.method === "server/discover") {
        entered.resolve();
        if (blockDiscovery) await release.promise;
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {
          resultType: "complete", supportedVersions: [VERSION], capabilities: { tools: {} },
        } });
      }
      if (body.method === "tools/list") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {
          resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [],
        } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    },
  });
  const config: McpServerConfig = {
    name: "connection-lifecycle-fixture", type: "http", url: server.url.href,
    headers: {}, enabled: true, required: false, trust: false, source: "user", raw: {},
  };
  return { config, requests, entered, release, close: () => server.stop(true) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Connection lifecycle fixture did not reach its barrier")), 1_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
