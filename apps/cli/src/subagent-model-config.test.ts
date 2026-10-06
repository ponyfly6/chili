import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import type { RuntimeModelDescriptor, SessionId } from "@chili/protocol";
import { createCliHarness, type CliHarness } from "./harness.js";

test("CLI initial child and followup use the same resolved session model configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-child-model-config-"));
  const cwd = join(root, "repo");
  const sessionId = "session_parent_model_config" as SessionId;
  const inputs: ModelStreamInput[] = [];
  let delegated = false;
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
      if (input.sessionId === sessionId && !delegated) {
        if (!input.tools.some((tool) => tool.name === "agent_spawn")) {
          yield { type: "tool_call", name: "tool_search", input: { query: "select:agent_spawn" } };
          yield { type: "finish", reason: "tool_use" };
          return;
        }
        delegated = true;
        yield {
          type: "tool_call",
          name: "agent_spawn",
          input: { description: "check configuration", prompt: "Confirm the task configuration.", mode: "resumable" },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
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
    expect((await harness.service.submitPrompt({ sessionId, text: "Delegate a configuration check." })).status)
      .toBe("completed");

    const tasks = await harness.store.agentTasks({ parentSessionId: sessionId });
    expect(tasks).toHaveLength(1);
    const child = tasks[0];
    if (!child) throw new Error("Expected an initial child task");
    expect(child.status).toBe("completed");
    expect((await harness.tasks.followupTask({ taskId: child.id, text: "Confirm the result again." })).result.status)
      .toBe("completed");

    const childInputs = inputs.filter((input) => input.sessionId === child.childSessionId);
    expect(childInputs).toHaveLength(2);
    for (const input of childInputs) {
      expect(input).toMatchObject({
        modelSelection: { provider: "fixture", model: "selected" },
        reasoningLevel: "high",
        serviceTier: "fast",
      });
      expect(input.tools.some((tool) => tool.name === "agent_spawn")).toBe(false);
    }
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
});
