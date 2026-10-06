import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import {
  DELEGATION_OFF_DENIED_TOOL_NAMES,
  ToolExecutor,
  filterToolsByPolicy,
  type ChiliToolDefinition,
  type ToolAccessPolicyResolver,
  type ToolRegistry,
} from "@chili/tools";
import { createCliHarness, type CliHarness } from "./harness.js";

const DENIED_INPUTS: Readonly<Record<string, unknown>> = {
  agent_spawn: { name: "worker", prompt: "work" },
  agent_resume: { agentId: "session_worker" },
  agent_send: { agentId: "session_worker", text: "continue" },
};

test("off hides and rejects root delegation tools while preserving settlement and control tools", async () => {
  const fixture = await harnessFixture();
  try {
    const handle = await fixture.harness.service.createSession({ cwd: fixture.repo });
    await fixture.harness.service.setDelegationPolicy({
      ...handle,
      policy: "off",
    });
    const executor = rootToolExecutor(fixture.harness);
    const visible = await visibleToolNames(executor, handle.sessionId, fixture.repo);
    const registry = (executor as unknown as { options: { registry: ToolRegistry } }).options.registry;
    for (const toolName of ["agent_spawn", "agent_send", "agent_resume"]) {
      expect(registry.get(toolName)).toBeDefined();
    }

    for (const toolName of DELEGATION_OFF_DENIED_TOOL_NAMES) {
      expect(visible.has(toolName)).toBe(false);
      const result = await executor.execute(toolInput(
        handle.sessionId,
        fixture.repo,
        toolName,
        DENIED_INPUTS[toolName],
      ));
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error.name).toBe(registry.get(toolName) ? "ToolDeniedError" : "UnknownToolError");
      }
    }

    for (const allowed of [
      "delegation_status",
      "delegation_set",
      "agent_list",
      "agent_wait",
      "agent_stop",
      "write",
    ]) {
      expect(visible.has(allowed)).toBe(true);
    }
    expect((await fixture.harness.events.events({
      sessionId: handle.sessionId,
      type: "session.created",
      limit: 10,
    }))).toHaveLength(1);

    const aliasResult = await executor.execute(toolInput(
      handle.sessionId,
      fixture.repo,
      "agent",
      { name: "worker", prompt: "work" },
    ));
    expect(aliasResult.status).toBe("failed");
    if (aliasResult.status === "failed") expect(aliasResult.error.name).toBe("UnknownToolError");
  } finally {
    await fixture.close();
  }
});

test("child ToolExecutor inherits root off without losing the worker policy", async () => {
  const fixture = await harnessFixture();
  const rootSessionId = "session_delegation_root" as SessionId;
  const childSessionId = "session_delegation_child" as SessionId;
  try {
    await fixture.harness.service.createSession({ sessionId: rootSessionId, cwd: fixture.repo });
    await fixture.harness.events.append({
      id: "event_policy_child_created",
      type: "session.created",
      time: Date.now() as TimestampMs,
      sessionId: childSessionId,
      payload: { sessionId: childSessionId, cwd: fixture.repo, agent: {
        parentSessionId: rootSessionId, name: "worker", path: "/root/worker" as AgentPath,
        policy: { deniedTools: ["write"] },
      } },
    });
    await fixture.harness.service.setDelegationPolicy({
      sessionId: rootSessionId,
      policy: "off",
    });
    const executor = childToolExecutor(fixture.harness);
    const visibleOff = await visibleToolNames(executor, childSessionId, fixture.repo);
    expect(visibleOff.has("agent_send")).toBe(false);
    expect(visibleOff.has("agent_wait")).toBe(true);
    expect(visibleOff.has("agent_stop")).toBe(true);
    expect(visibleOff.has("write")).toBe(false);

    const denied = await executor.execute(toolInput(
      childSessionId,
      fixture.repo,
      "agent_send",
      { agentId: "session_nested_worker", text: "continue" },
    ));
    expect(denied.status).toBe("failed");
    if (denied.status === "failed") expect(denied.error.name).toBe("ToolDeniedError");

    await fixture.harness.service.setDelegationPolicy({
      sessionId: rootSessionId,
      policy: "proactive",
    });
    const visibleEnabled = await visibleToolNames(executor, childSessionId, fixture.repo);
    expect(visibleEnabled.has("agent_send")).toBe(true);
    expect(visibleEnabled.has("write")).toBe(false);
  } finally {
    await fixture.close();
  }
});

async function harnessFixture(): Promise<{ repo: string; harness: CliHarness; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "chili-delegation-policy-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  const harness = await createCliHarness({
    cwd: repo,
    model: "fake",
    quiet: true,
    yes: true,
    mcpConnectMode: "manual",
  });
  return {
    repo,
    harness,
    async close() {
      await harness.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function rootToolExecutor(harness: CliHarness): ToolExecutor {
  return (harness.runtime as unknown as { options: { toolExecutor: ToolExecutor } }).options.toolExecutor;
}

function childToolExecutor(harness: CliHarness): ToolExecutor {
  return (harness.agents as unknown as {
    options: {
      runtime: {
        options: {
          runtime: { options: { toolExecutor: ToolExecutor } };
        };
      };
    };
  }).options.runtime.options.runtime.options.toolExecutor;
}

async function visibleToolNames(
  executor: ToolExecutor,
  sessionId: SessionId,
  cwd: string,
): Promise<Set<string>> {
  const internals = executor as unknown as {
    options: {
      registry: ToolRegistry;
      policyResolver?: ToolAccessPolicyResolver;
    };
  };
  const policy = await internals.options.policyResolver?.resolve({
    sessionId,
    turnId: `turn_visible_${sessionId}` as TurnId,
    cwd,
  });
  return new Set(
    filterToolsByPolicy(
      internals.options.registry.list() as ChiliToolDefinition[],
      policy,
    ).map((tool) => tool.name),
  );
}

function toolInput(
  sessionId: SessionId,
  cwd: string,
  toolName: string,
  input: unknown,
) {
  return {
    sessionId,
    turnId: `turn_${toolName}_${sessionId}` as TurnId,
    toolName,
    input,
    cwd,
  };
}
