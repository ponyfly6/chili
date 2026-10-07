import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { type ModelRouter, type ModelStreamInput, type ModelStreamEvent } from "@chili/core";
import type { ChiliEvent, RuntimePermissionProfileId, SessionId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { BashRunner } from "@chili/tools";
import { createChiliHost, type ChiliHost, type ChiliHostOptions } from "./host.js";
import { createHostMcpRuntime } from "./mcp-control.js";

const sessionId = "session_host_boundary" as SessionId;

test("headless Host reviews a tool without a human approval interface", async () => {
  await withWorkspace(async (options) => {
    let executions = 0;
    const events: ChiliEvent[] = [];
    const host = await createChiliHost({ ...options, permissionProfile: "auto-review",
      reviewerModelRouter: reviewer(() => ({ decision: "deny", reason: "Outside the requested task." })),
      bashRunner: fakeRunner(() => { executions++; }), onEvent: (event) => { events.push(event); } });
    try {
      await runApprovalFixture(host);
      expect(executions).toBe(0);
      expect(events.some((event) => event.type.startsWith("approval."))).toBe(false);
      expect(JSON.stringify(events)).toContain("Outside the requested task.");
      expect(await host.store.pendingApprovals(sessionId)).toHaveLength(0);
    } finally { await host.close(); }
  });
});

test("Host reviews the exact action before executing it", async () => {
  await withWorkspace(async (options) => {
    let executions = 0;
    const requests: ModelStreamInput[] = [];
    const host = await createChiliHost({ ...options, permissionProfile: "auto-review",
      bashRunner: fakeRunner(() => { executions++; }),
      reviewerModelRouter: reviewer((input) => {
        expect(executions).toBe(0);
        expect(input.tools).toEqual([]);
        expect(input.signal?.aborted).toBe(false);
        requests.push(input);
        return { decision: "allow", reason: "Requested fixture command." };
      }),
    });
    try {
      await runApprovalFixture(host);
      expect(requests).toHaveLength(1);
      expect(reviewAction(requests[0]!)).toMatchObject({ sessionId, toolName: "bash" });
      expect(reviewAction(requests[0]!).input).toHaveProperty("command");
      expect(executions).toBe(1);
    } finally { await host.close(); }
  });
});

test("Host Full Access ignores retired project rules and never invokes the reviewer", async () => {
  await withWorkspace(async (options) => {
    await mkdir(join(options.cwd, ".chili"), { recursive: true });
    await writeFile(join(options.cwd, ".chili", "config.toml"), '[permissions]\ndeny = ["bash(*)"]\n');
    let executions = 0;
    let reviews = 0;
    const host = await createChiliHost({ ...options, permissionProfile: "full-access",
      bashRunner: fakeRunner(() => { executions++; }),
      reviewerModelRouter: reviewer(() => { reviews++; throw new Error("Reviewer must not run"); }),
    });
    try {
      await runApprovalFixture(host);
      expect(executions).toBe(1);
      expect(reviews).toBe(0);
    } finally { await host.close(); }
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

test("Host initialization failure drains runtimes and closes SQLite", async () => {
  await withWorkspace(async (options) => {
    const close = spyOn(SqliteEventStore.prototype, "close");
    const error = new Error("MCP fixture failed during initialization");
    try {
      await expect(createChiliHost({
        ...options,
        mcpRuntimeFactory: async () => { throw error; },
      })).rejects.toBe(error);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
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

test("Host exposes exactly two modes and rejects retired or unknown live modes", async () => {
  await withWorkspace(async (options) => {
    for (const value of ["default", "unrecognized"]) {
      await expect(createChiliHost({ ...options, permissionProfile: value as RuntimePermissionProfileId }))
        .rejects.toThrow("Unsupported permission profile");
    }
    const host = await createChiliHost({ ...options, permissionProfile: "auto-review" });
    try {
      expect(host.permissions.get().profiles.map((profile) => profile.id).sort()).toEqual(["auto-review", "full-access"]);
      expect((await host.permissions.set("full-access")).profile).toBe("full-access");
      expect((await host.permissions.set("auto-review")).profile).toBe("auto-review");
      await expect(host.permissions.set("default" as RuntimePermissionProfileId)).rejects.toThrow("Unsupported permission profile");
    } finally { await host.close(); }
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
            expect(input.developer?.join("\n")).toContain("Host execution review and worker scope still apply");
            yield { type: "tool_call_start", toolCallId: "provider_code_mode_call", name: "code_mode" };
            yield {
              type: "tool_call_end",
              toolCallId: "provider_code_mode_call",
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
      expect(outer?.payload.providerCallId).toBe("provider_code_mode_call");
      expect(outer?.payload.callId).not.toBe("provider_code_mode_call");
      expect(started.filter((event) => event.payload.toolName === "read")).toMatchObject([
        { payload: { parentCallId: outer?.payload.callId } },
        { payload: { parentCallId: outer?.payload.callId } },
      ]);
      expect(started.filter((event) => event.payload.parentCallId).every((event) => event.payload.providerCallId === undefined)).toBe(true);
    } finally {
      await host.close();
    }
  });
});

test("Host code mode sends nested shell execution through independent automatic review", async () => {
  await withWorkspace(async (options) => {
    let executions = 0;
    const actions: ReturnType<typeof reviewAction>[] = [];
    const host = await createChiliHost({ ...options, permissionProfile: "auto-review",
      bashRunner: fakeRunner(() => { executions++; }),
      reviewerModelRouter: reviewer((input) => {
        const action = reviewAction(input);
        actions.push(action);
        return action.toolName === "bash"
          ? { decision: "deny", reason: "Denied nested command for this test." }
          : { decision: "allow", reason: "Review nested calls separately." };
      }),
      modelRouter: { async *stream(): AsyncIterable<ModelStreamEvent> {
        yield { type: "tool_call", name: "code_mode", input: { code: 'await tools.bash({command:"/usr/bin/true"});' } };
        yield { type: "finish", reason: "tool_use" };
      } },
    });
    try {
      await host.runtime.createSession({ sessionId, cwd: host.cwd });
      await host.runtime.runTurn({ sessionId, cwd: host.cwd });
      expect(executions).toBe(0);
      expect(actions.some((action) => action.toolName === "bash")).toBe(true);
      const completed = (await host.store.events({ sessionId, type: "tool.call_finished" }))
        .filter((event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished");
      expect(completed).toHaveLength(2);
      expect(completed.every((event) => event.payload.status === "failed")).toBe(true);
    } finally { await host.close(); }
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

test("Host code mode shares file observations within a session without granting them to another session", async () => {
  await withWorkspace(async (options) => {
    const path = join(options.cwd, "observed.txt");
    await writeFile(path, "alpha");
    let requests = 0;
    const host = await createChiliHost({
      ...options,
      permissionProfile: "full-access",
      modelRouter: {
        async *stream(): AsyncIterable<ModelStreamEvent> {
          const code = requests++ === 0
            ? 'await tools.read({filePath:"observed.txt"}); text((await tools.edit({filePath:"observed.txt",oldString:"alpha",newString:"bravo"})).structuredData);'
            : 'await tools.edit({filePath:"observed.txt",oldString:"bravo",newString:"charlie"});';
          yield { type: "tool_call", name: "code_mode", input: { code } };
          yield { type: "finish", reason: "tool_use" };
        },
      },
    });
    try {
      const first = await host.runtime.createSession({ cwd: host.cwd });
      const second = await host.runtime.createSession({ cwd: host.cwd });
      await host.runtime.runTurn({ sessionId: first, cwd: host.cwd });
      expect(await readFile(path, "utf8")).toBe("bravo");
      const firstFinished = (await host.store.events({ sessionId: first, type: "tool.call_finished" }))
        .filter((event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished");
      expect(firstFinished).toHaveLength(3);
      expect(firstFinished.every((event) => event.type === "tool.call_finished" && event.payload.status === "completed")).toBe(true);

      await host.runtime.runTurn({ sessionId: second, cwd: host.cwd });
      expect(await readFile(path, "utf8")).toBe("bravo");
      const secondFinished = (await host.store.events({ sessionId: second, type: "tool.call_finished" }))
        .filter((event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished");
      expect(secondFinished).toHaveLength(2);
      expect(secondFinished.every((event) => event.type === "tool.call_finished" && event.payload.status === "failed")).toBe(true);
      expect(JSON.stringify(secondFinished)).toContain("Read observed.txt before modifying it");
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
    await run({ cwd, chiliHome: join(root, "home"), model: "fake", permissionProfile: "full-access", mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
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

function reviewer(decide: (input: ModelStreamInput) => { decision: "allow" | "deny"; reason: string }): ModelRouter {
  return { async *stream(input) {
    yield { type: "text_delta", text: JSON.stringify(decide(input)) };
    yield { type: "finish", reason: "stop" };
  } };
}

function reviewAction(input: ModelStreamInput): { toolName: string; sessionId: string; input: unknown } {
  const message = input.messages.findLast((message) => message.role === "user");
  const text = message?.parts.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
  return JSON.parse(text).action;
}
