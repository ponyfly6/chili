import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import type { RuntimeModelDescriptor, SessionId } from "@chili/protocol";
import { createCliHarness, type CliHarness } from "./harness.js";

test("CLI Agent inputs inherit the model configuration and expose Code Mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-child-model-config-"));
  const cwd = join(root, "repo");
  const sessionId = "session_parent_model_config" as SessionId;
  const inputs: ModelStreamInput[] = [];
  const model: ModelRouter = {
    listModels(): RuntimeModelDescriptor[] {
      return [{
        provider: "fixture",
        model: "selected",
        reasoningLevels: ["low", "high"],
        serviceTiers: ["standard", "fast"],
      }];
    },
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      inputs.push(input);
      yield { type: "text_delta", text: "Checked the task configuration and recorded the result." };
      yield { type: "finish", reason: "stop" };
    },
  };
  let harness: CliHarness | undefined;
  try {
    await mkdir(cwd);
    harness = await createCliHarness({
      cwd,
      chiliHome: join(root, "home"),
      model: "fake",
      modelRouter: model,
      quiet: true,
      yes: true,
      mcpConnectMode: "manual",
      staleTurnRecoveryIntervalMs: false,
    });
    await harness.service.createSession({ sessionId });
    await harness.service.setModel({ sessionId, modelSelection: { provider: "fixture", model: "selected" } });
    await harness.service.setReasoning({ sessionId, reasoningLevel: "high" });
    await harness.service.setServiceTier({ sessionId, serviceTier: "fast" });
    await harness.service.setDelegationPolicy({ sessionId, policy: "proactive" });
    const agents = harness.agents.forSession(sessionId);
    const child = await agents.spawnAgent({ name: "configuration-check", prompt: "Confirm the configuration." });
    const initial = await agents.waitAgent({ ...child, timeoutMs: 2_000 });
    expect(initial.input.outcome).toBe("completed");
    const next = await agents.sendAgent({ agentId: child.agentId, text: "Confirm the result again." });
    expect((await agents.waitAgent({ ...next, timeoutMs: 2_000 })).input.outcome).toBe("completed");
    const listed = await agents.listAgents({});
    expect(listed.filter((agent) => agent.agentId === sessionId)).toEqual([
      expect.objectContaining({ name: "root", path: "/root" }),
    ]);
    expect(listed.filter((agent) => agent.agentId !== sessionId)).toEqual([
      expect.objectContaining({ agentId: child.agentId }),
    ]);

    const childInputs = inputs.filter((input) => input.sessionId === child.agentId);
    expect(childInputs).toHaveLength(2);
    for (const input of childInputs) {
      expect(input.tools.some((tool) => tool.name === "code_mode")).toBe(true);
      expect(input).toMatchObject({
        modelSelection: { provider: "fixture", model: "selected" },
        reasoningLevel: "high",
        serviceTier: "fast",
      });
    }
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI Agent creation retains the invoking prompt's tool policy through the Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-agent-policy-inheritance-"));
  const cwd = join(root, "repo");
  const sessionId = "session_restricted_parent" as SessionId;
  const inputs: ModelStreamInput[] = [];
  let delegated = false;
  let discovered = false;
  const policy = {
    allowedTools: ["agent_spawn", "read", "tool_search", "code_mode"],
    deniedTools: ["bash"],
    writeScope: [],
    executeScope: [],
  };
  const model: ModelRouter = {
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      inputs.push(input);
      if (input.sessionId === sessionId && !delegated) {
        if (!discovered && !input.tools.some((tool) => tool.name === "agent_spawn")) {
          discovered = true;
          yield { type: "tool_call", name: "tool_search", input: { query: "select:agent_spawn" } };
        } else {
          delegated = true;
          yield { type: "tool_call", name: "agent_spawn", input: { name: "reader", prompt: "Inspect the repository without modifying it." } };
        }
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text: "Read-only review complete." };
      yield { type: "finish", reason: "stop" };
    },
  };
  let harness: CliHarness | undefined;
  try {
    await mkdir(cwd);
    harness = await createCliHarness({
      cwd, chiliHome: join(root, "home"), model: "fake", modelRouter: model,
      quiet: true, yes: true, mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false,
    });
    await harness.service.createSession({ sessionId, cwd });
    const completed = await harness.service.submitPrompt({
      sessionId, text: "Create an Agent to read the repository.", toolPolicy: policy,
    });
    expect(completed.status).toBe("completed");
    await harness.waitForAgents();
    const children = await harness.store.childSessions(sessionId);
    expect(children).toHaveLength(1);
    const child = children[0];
    if (!child) throw new Error("The scoped prompt did not create an Agent");
    expect(child.agent?.policy).toEqual({ ...policy, allowedTools: [...policy.allowedTools].sort() });
    const childInputs = inputs.filter((input) => input.sessionId === child.id);
    expect(childInputs).toHaveLength(1);
    for (const input of childInputs) {
      expect(input.tools.some((tool) => tool.name === "write")).toBe(false);
      expect(input.tools.some((tool) => tool.name === "bash")).toBe(false);
      expect(input.tools.some((tool) => tool.name === "code_mode")).toBe(true);
    }
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});
