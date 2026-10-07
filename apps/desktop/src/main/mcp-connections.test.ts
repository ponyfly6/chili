import { describe, expect, test } from "bun:test";
import type { RuntimeMcpServerDescriptor, SessionId } from "@chili/protocol";
import type { RuntimeClient } from "@chili/sdk";
import { DesktopControlService } from "./control-service.js";

type McpInput = Parameters<RuntimeClient["connectMcpServer"]>[0];
type McpOperation = "mcp.connect" | "mcp.disconnect";
type McpCall = { type: McpOperation; input: McpInput };

describe("desktop MCP connection controls", () => {
  for (const type of ["mcp.connect", "mcp.disconnect"] as const) {
    const status = type === "mcp.connect" ? "running" : "stopped";

    test(`${type} forwards server, session and cancellation while exposing only connection metadata`, async () => {
      const calls: McpCall[] = [];
      const client = clientFor(calls, async () => ({
        name: "tools/private", status, enabled: true, transport: "stdio", toolCount: 0,
        command: "/private/tool", args: ["--token", "private-token"],
        url: "https://private.example/?key=private-key", error: "private diagnostic",
        description: "private configuration", updatedAt: 123,
        auth: { required: true, authenticated: false },
      }));
      const { service } = serviceFor(client);

      expect(await service.invoke({ type, server: "tools/private", sessionId: "task_one", projectId: "project_one" }))
        .toEqual({ name: "tools/private", status, enabled: true, transport: "stdio", toolCount: 0 });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        type,
        input: { server: "tools/private", sessionId: "task_one" as SessionId, signal: expect.any(AbortSignal) },
      });
      expect(calls[0]?.input.signal?.aborted).toBe(false);
      service.beginShutdown();
      expect(calls[0]?.input.signal?.aborted).toBe(true);
    });

    test(`${type} permits project-wide control without inventing optional response fields`, async () => {
      const calls: McpCall[] = [];
      const client = clientFor(calls, async () => ({ name: "tools", status, enabled: false }));
      const { service } = serviceFor(client);

      const result = await service.invoke({ type, server: "tools", projectId: "project_one" });
      expect(result).toEqual({ name: "tools", status, enabled: false });
      expect(Object.keys(result).sort()).toEqual(["enabled", "name", "status"]);
      expect(calls).toEqual([{ type, input: { server: "tools", signal: expect.any(AbortSignal) } }]);
    });

    for (const sessionId of [undefined, "task_one"]) {
      test(`${type} keeps its captured project lease across ${sessionId ? "session" : "workspace"} queue waits`, async () => {
        const started = deferred<void>();
        const release = deferred<void>();
        const originalCalls: McpCall[] = [];
        const replacementCalls: McpCall[] = [];
        const originalClient = clientFor(originalCalls, async () => {
          started.resolve();
          await release.promise;
          return { name: "tools", status, enabled: true };
        });
        const replacementClient = clientFor(replacementCalls, async () => ({ name: "tools", status, enabled: true }));
        const { service, replaceSidecar } = serviceFor(originalClient);
        const request = { type, server: "tools", projectId: "project_one", ...(sessionId ? { sessionId } : {}) };
        const active = service.invoke(request);
        await started.promise;
        const queued = service.invoke(request);
        // Observe both rejections before releasing the held write. Neither may
        // resolve against, or be dispatched to, the replacement project's client.
        const outcomes = Promise.allSettled([active, queued]);
        replaceSidecar(replacementClient);
        release.resolve();

        for (const outcome of await outcomes) {
          expect(outcome.status).toBe("rejected");
          if (outcome.status === "rejected") {
            expect(outcome.reason).toBeInstanceOf(Error);
            expect(outcome.reason.message).toContain("Workspace changed");
          }
        }
        expect(originalCalls).toHaveLength(1);
        expect(replacementCalls).toHaveLength(0);
      });
    }

    test(`${type} rejects a closed desktop before mutating its server`, async () => {
      const calls: McpCall[] = [];
      const client = clientFor(calls, async () => ({ name: "tools", status, enabled: true }));
      const { service } = serviceFor(client);
      service.beginShutdown();

      await expect(service.invoke({ type, server: "tools", sessionId: "task_one", projectId: "project_one" }))
        .rejects.toThrow("Desktop is closing");
      expect(calls).toHaveLength(0);
    });

    test(`${type} cancels the active lease and rejects queued mutations when shutdown begins`, async () => {
      const started = deferred<void>();
      const release = deferred<void>();
      const calls: McpCall[] = [];
      const client = clientFor(calls, async () => {
        started.resolve();
        await release.promise;
        return { name: "tools", status, enabled: true };
      });
      const { service } = serviceFor(client);
      const request = { type, server: "tools", sessionId: "task_one", projectId: "project_one" };
      const active = service.invoke(request);
      await started.promise;
      const queued = service.invoke(request);
      const outcomes = Promise.allSettled([active, queued]);
      service.beginShutdown();
      expect(calls[0]?.input.signal?.aborted).toBe(true);
      release.resolve();

      expect((await outcomes).map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      expect(calls).toHaveLength(1);
    });
  }
});

function clientFor(
  calls: McpCall[],
  respond: () => Promise<RuntimeMcpServerDescriptor>,
): RuntimeClient {
  return {
    connectMcpServer: async (input: McpInput) => {
      calls.push({ type: "mcp.connect", input });
      return respond();
    },
    disconnectMcpServer: async (input: McpInput) => {
      calls.push({ type: "mcp.disconnect", input });
      return respond();
    },
  } as unknown as RuntimeClient;
}

function serviceFor(initialClient: RuntimeClient): {
  service: DesktopControlService;
  replaceSidecar(client: RuntimeClient): void;
} {
  let client = initialClient;
  let generation = 1;
  const sidecar = {
    state: () => ({ sidecar: { phase: "healthy" as const, attempt: 0 }, queuedBySession: {} }),
    getClient: () => client,
    getClientContext: () => ({ client, generation }),
    currentGeneration: () => generation,
    currentWorkspace: () => "/repo",
    setQueuedCount: () => undefined,
  };
  const service = new DesktopControlService({
    sidecar: sidecar as never,
    selectWorkspace: async () => undefined,
    persistWorkspace: async () => undefined,
    emitQueue: () => undefined,
    onError: () => undefined,
  });
  return {
    service,
    replaceSidecar(nextClient) {
      client = nextClient;
      generation += 1;
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
