import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { AgentMailboxDeliveryPump, type ModelStreamEvent } from "@chili/core";
import type { ChiliEvent, RuntimePermissionProfileId, SessionId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { ApprovalBrokerRequest, BashRunner } from "@chili/tools";
import { createHostApprovalBroker } from "./approval.js";
import { createChiliHost, type ChiliHost, type ChiliHostOptions } from "./host.js";
import { createHostMcpRuntime } from "./mcp-control.js";

const sessionId = "session_host_boundary" as SessionId;

test("headless Host denies an approval-required tool without an approval interface", async () => {
  await withWorkspace(async (options) => {
    let executions = 0;
    const events: ChiliEvent[] = [];
    const host = await createChiliHost({
      ...options,
      bashRunner: fakeRunner(() => { executions += 1; }),
      onEvent: (event) => { events.push(event); },
    });
    try {
      await runApprovalFixture(host);
      expect(executions).toBe(0);
      expect(events.find((event) => event.type === "approval.resolved")?.payload).toMatchObject({
        decision: "deny",
        feedback: "No approval interface available.",
      });
      expect(await host.store.pendingApprovals(sessionId)).toHaveLength(0);
    } finally {
      await host.close();
    }
  });
});

test("Host sends approval to its injected interface and executes only after acceptance", async () => {
  await withWorkspace(async (options) => {
    let executions = 0;
    const requests: ApprovalBrokerRequest[] = [];
    const host = await createChiliHost({
      ...options,
      bashRunner: fakeRunner(() => { executions += 1; }),
      askApproval: async (request, signal) => {
        expect(executions).toBe(0);
        expect(signal?.aborted).toBe(false);
        requests.push(request);
        return { action: "allow_once" };
      },
    });
    try {
      await runApprovalFixture(host);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ sessionId, permission: "bash.unsandboxed", maxApprovalScope: "once" });
      expect(executions).toBe(1);
    } finally {
      await host.close();
    }
  });
});

test("Host Full Access continues to enforce explicit project denies", async () => {
  await withWorkspace(async (options) => {
    const configDir = join(options.cwd, ".chili");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.toml"), '[permissions]\ndeny = ["bash.unsandboxed(*)"]\n');
    let executions = 0;
    let asks = 0;
    const host = await createChiliHost({
      ...options,
      permissionProfile: "full-access",
      bashRunner: fakeRunner(() => { executions += 1; }),
      askApproval: async () => {
        asks += 1;
        return { action: "allow_once" };
      },
    });
    try {
      await runApprovalFixture(host);
      expect(executions).toBe(0);
      expect(asks).toBe(0);
    } finally {
      await host.close();
    }
  });
});

test("Host observes committed startup events and isolates an observer failure", async () => {
  await withWorkspace(async (options) => {
    const diagnostic: ChiliEvent = {
      id: "event_host_startup_observer",
      type: "mcp.diagnostic",
      time: Date.now() as TimestampMs,
      payload: { serverName: "test", level: "warning", code: "fixture", source: "runtime", message: "startup fixture" },
    };
    const observed: string[] = [];
    const host = await createChiliHost({
      ...options,
      onEvent(event) {
        observed.push(event.id);
        throw new Error("UI observer failure");
      },
      async mcpRuntimeFactory(runtimeOptions, baseCommands) {
        await runtimeOptions.events?.publish(diagnostic);
        return createHostMcpRuntime(runtimeOptions, baseCommands);
      },
    });
    try {
      expect(observed).toContain(diagnostic.id);
      expect((await host.store.events({ type: "mcp.diagnostic" })).map((event) => event.id)).toContain(diagnostic.id);
      await host.service.createSession({ sessionId, cwd: host.cwd });
      expect((await host.service.submitPrompt({ sessionId, text: "hello" })).status).toBe("completed");
    } finally {
      await host.close();
    }
  });
});

test("Host initialization failure stops its mailbox pump and closes SQLite", async () => {
  await withWorkspace(async (options) => {
    const close = spyOn(SqliteEventStore.prototype, "close");
    const stop = spyOn(AgentMailboxDeliveryPump.prototype, "stop");
    const error = new Error("MCP fixture failed during initialization");
    try {
      await expect(createChiliHost({
        ...options,
        mcpRuntimeFactory: async () => { throw error; },
      })).rejects.toBe(error);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      stop.mockRestore();
    }
    const restarted = await createChiliHost(options);
    try {
      await restarted.service.createSession({ sessionId, cwd: restarted.cwd });
      expect((await restarted.service.submitPrompt({ sessionId, text: "reopened" })).status).toBe("completed");
    } finally {
      await restarted.close();
    }
  });
});

test("Host rejects the unavailable auto-review profile at construction and runtime", async () => {
  await withWorkspace(async (options) => {
    await expect(createChiliHost({ ...options, permissionProfile: "auto-review" })).rejects.toThrow("not implemented");
    expect(() => createHostApprovalBroker({ permissionProfile: "auto-review" })).toThrow("not implemented");
    const unknownProfile = "unrecognized" as RuntimePermissionProfileId;
    await expect(createChiliHost({ ...options, permissionProfile: unknownProfile })).rejects.toThrow("Unsupported permission profile");
    expect(() => createHostApprovalBroker({ permissionProfile: unknownProfile })).toThrow("Unsupported permission profile");
    const host = await createChiliHost(options);
    try {
      expect(() => host.permissions.set("auto-review")).toThrow("not implemented");
      expect(() => host.permissions.set(unknownProfile)).toThrow("Unsupported permission profile");
      expect(host.permissions.get().profile).toBe("default");
    } finally {
      await host.close();
    }
  });
});

test("Host code mode composes reads while only its selected output enters model history", async () => {
  await withWorkspace(async (options) => {
    await writeFile(join(options.cwd, "first.txt"), "first private intermediate");
    await writeFile(join(options.cwd, "second.txt"), "second private intermediate");
    let requests = 0;
    const host = await createChiliHost({
      ...options,
      modelRouter: {
        async *stream(input): AsyncIterable<ModelStreamEvent> {
          requests++;
          expect(input.tools.map((tool) => tool.name)).toContain("code_mode");
          expect(input.tools.map((tool) => tool.name)).toContain("read");
          if (requests === 1) {
            expect(input.developer?.join("\n")).toContain("Tool permissions, approvals, and worker scope still apply");
            yield {
              type: "tool_call",
              name: "code_mode",
              input: {
                code: 'const results = await Promise.allSettled([tools.read({filePath:"first.txt"}), tools.read({filePath:"second.txt"})]); text(results.map(r => r.status === "fulfilled" ? r.value.structuredData.path : "failed"));',
              },
            };
            yield { type: "finish", reason: "tool_use" };
            return;
          }
          const parts = input.messages.flatMap((message) => message.parts);
          expect(parts.filter((part) => part.type === "tool_call")).toHaveLength(1);
          expect(parts.filter((part) => part.type === "tool_result")).toMatchObject([
            { output: '["first.txt","second.txt"]' },
          ]);
          expect(JSON.stringify(input.messages)).not.toContain("private intermediate");
          yield { type: "text_delta", text: "Read both files." };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
    try {
      await host.service.createSession({ sessionId, cwd: host.cwd });
      expect((await host.service.submitPrompt({ sessionId, text: "Read and summarize two files." })).status).toBe("completed");
      expect(requests).toBe(2);
      const started = (await host.store.events({ sessionId, type: "tool.call_started" }))
        .filter((event): event is Extract<ChiliEvent, { type: "tool.call_started" }> => event.type === "tool.call_started");
      const outer = started.find((event) => event.payload.toolName === "code_mode");
      expect(outer).toBeDefined();
      expect(started.filter((event) => event.payload.toolName === "read")).toMatchObject([
        { payload: { parentCallId: outer?.payload.callId } },
        { payload: { parentCallId: outer?.payload.callId } },
      ]);
    } finally {
      await host.close();
    }
  });
});

test("Host code mode sends nested shell execution through the approval interface", async () => {
  await withWorkspace(async (options) => {
    let executions = 0;
    const requests: ApprovalBrokerRequest[] = [];
    const host = await createChiliHost({
      ...options,
      bashRunner: fakeRunner(() => { executions++; }),
      askApproval: async (request) => {
        expect(executions).toBe(0);
        requests.push(request);
        return { action: "deny", feedback: "Denied nested command for this test." };
      },
      modelRouter: {
        async *stream(): AsyncIterable<ModelStreamEvent> {
          yield {
            type: "tool_call",
            name: "code_mode",
            input: { code: 'await tools.bash({command:"/usr/bin/true",sandbox_permissions:"require_escalated",justification:"Approval fixture"});' },
          };
          yield { type: "finish", reason: "tool_use" };
        },
      },
    });
    try {
      await host.runtime.createSession({ sessionId, cwd: host.cwd });
      await host.runtime.runTurn({ sessionId, cwd: host.cwd });
      expect(executions).toBe(0);
      expect(requests).toMatchObject([{ toolName: "bash", permission: "bash.unsandboxed" }]);
      const completed = (await host.store.events({ sessionId, type: "tool.call_finished" }))
        .filter((event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished");
      expect(completed).toHaveLength(2);
      expect(completed.every((event) => event.payload.status === "failed")).toBe(true);
    } finally {
      await host.close();
    }
  });
});

test("Host code mode retains the turn allowlist for its nested tool catalog", async () => {
  await withWorkspace(async (options) => {
    const host = await createChiliHost({
      ...options,
      modelRouter: {
        async *stream(): AsyncIterable<ModelStreamEvent> {
          yield { type: "tool_call", name: "code_mode", input: { code: 'text(ALL_TOOLS.map(tool => tool.name)); text(typeof tools.write);' } };
          yield { type: "finish", reason: "tool_use" };
        },
      },
    });
    try {
      await host.runtime.createSession({ sessionId, cwd: host.cwd });
      expect((await host.runtime.runTurn({
        sessionId,
        cwd: host.cwd,
        toolPolicy: { allowedTools: ["code_mode", "read"] },
      })).status).toBe("completed");
      const parts = (await host.store.messages(sessionId)).flatMap((message) => message.parts);
      expect(parts.filter((part) => part.type === "tool_result")).toMatchObject([
        { output: '["read"]\nundefined' },
      ]);
      expect(await host.store.events({ sessionId, type: "tool.call_started" })).toHaveLength(1);
    } finally {
      await host.close();
    }
  });
});

async function runApprovalFixture(host: ChiliHost): Promise<void> {
  await host.service.createSession({ sessionId, cwd: host.cwd });
  expect((await host.service.submitPrompt({ sessionId, text: "desktop approval fixture" })).status).toBe("completed");
}

async function withWorkspace(run: (options: ChiliHostOptions) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "chili-host-"));
  try {
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    await run({ cwd, chiliHome: join(root, "home"), model: "fake", mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeRunner(onRun: () => void): BashRunner {
  return {
    async run(request) {
      onRun();
      return {
        exitCode: 0,
        signal: null,
        stdout: "ok",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutBytes: 2,
        stderrBytes: 0,
        outputLimitBytes: request.maxOutputBytes,
        durationMs: 1,
        timedOut: false,
        aborted: false,
        sandbox: "none",
      };
    },
  };
}
