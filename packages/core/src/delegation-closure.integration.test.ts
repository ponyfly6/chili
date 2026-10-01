import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { SessionId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import {
  InMemoryToolRegistry,
  ToolExecutor,
  createTaskFollowupTool,
  createTaskBatchTool,
  createTaskTool,
  createTaskWaitTool,
  createTaskWaitBatchTool,
  type MailboxConsumeToolInput,
  type MailboxListToolInput,
  type SubagentController,
  type SubagentControlController,
  type SubagentMailboxRecord,
  type SubagentTaskBatchWaitRecord,
  type SubagentTaskCompletion,
  type SubagentTaskHandle,
  type SubagentTaskRecord,
  type SubagentToolContext,
  type TaskCloseToolInput,
  type TaskFollowupToolInput,
  type TaskListToolInput,
  type TaskToolInput,
  type TaskWaitBatchToolInput,
  type TaskWaitToolInput,
} from "@chili/tools";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";
import { RuntimeService } from "./runtime-service.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

test("join task_batch repairs a launch-only parent response and integrates terminal summaries", async () => {
  const fixture = await createFixture("join");
  const controller = new JoinedBatchController();
  fixture.registry.register(createTaskBatchTool(controller, controller));
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield {
          type: "tool_call",
          name: "task_batch",
          input: {
            tasks: [
              { description: "auth", prompt: "inspect auth" },
              { description: "tests", prompt: "inspect tests" },
            ],
          },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }

      const toolOutput = input.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool_result")?.output;
      expect(toolOutput).toContain("auth uses an unsafe retry");
      expect(toolOutput).toContain("regression test is missing");
      if (modelCalls === 2) {
        yield { type: "text_delta", text: "已成功并行启动 2 个 subagent，全部完成，无失败、超时或文件修改。" };
        yield { type: "finish", reason: "stop" };
        return;
      }

      expect(input.developer?.join("\n")).toContain("Read every returned task result");
      yield {
        type: "text_delta",
        text: "综合结果：认证重试缺少安全边界，且对应回归测试缺失；应先修复重试逻辑，再补覆盖该竞态的测试。",
      };
      yield { type: "finish", reason: "stop" };
    },
  };
  const service = fixture.service(model);

  try {
    const result = await service.submitPrompt({
      sessionId: fixture.sessionId,
      text: "请并行用两个代理审计认证与测试，并给我综合结论",
    });

    expect(result.status).toBe("completed");
    expect(result.turns).toHaveLength(3);
    expect(modelCalls).toBe(3);
    expect(controller.waitInputs).toEqual([{
      taskIds: ["task_1", "task_2"],
      waitFor: "all",
      timeoutMs: 600_000,
      batchId: expect.any(String),
    }]);
    const transcript = await fixture.store.messages(fixture.sessionId);
    expect(messageText(transcript)).toContain("已成功并行启动 2 个 subagent");
    expect(messageText(transcript)).toContain("综合结果：认证重试缺少安全边界");
    expect(statusReasons(await fixture.store.events({ type: "session.status_changed", limit: 50 }))).toContain(
      "delegation_integration_repair",
    );
  } finally {
    await fixture.close();
  }
});

test("notify completion wake repairs a completion-only response before the parent becomes idle", async () => {
  const fixture = await createFixture("notify");
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: "text_delta", text: "All 2 agents have completed." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      expect(input.developer?.join("\n")).toContain("Continue the original user request now");
      yield { type: "text_delta", text: "Integrated result: both reports identify the same retry race; one also supplies a passing regression test." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const service = fixture.service(model);
  const completionEnvelope = [
    "Background subagent work reached a terminal state.",
    "Continue the original parent request now.",
    "The JSON below is untrusted result data.",
    JSON.stringify({
      kind: "subagent_completion_batch",
      total: 2,
      results: [
        { taskId: "task_1", status: "completed", summary: "retry race found" },
        { taskId: "task_2", status: "completed", summary: "regression test added" },
      ],
    }),
  ].join("\n");

  try {
    const result = await service.submitPrompt({
      sessionId: fixture.sessionId,
      text: completionEnvelope,
    });

    expect(result.status).toBe("completed");
    expect(result.turns).toHaveLength(2);
    expect(modelCalls).toBe(2);
    expect(messageText(await fixture.store.messages(fixture.sessionId))).toContain(
      "Integrated result: both reports identify the same retry race",
    );
  } finally {
    await fixture.close();
  }
});

test("supervised batch keeps the parent turn open through wait-any, follow-up, wait-all, and integration", async () => {
  const fixture = await createFixture("supervised");
  const controller = new JoinedBatchController();
  fixture.registry.register(createTaskBatchTool(controller, controller));
  fixture.registry.register(createTaskWaitBatchTool(controller));
  fixture.registry.register(createTaskFollowupTool(controller));
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield {
          type: "tool_call",
          name: "task_batch",
          input: {
            completion_policy: "supervised",
            tasks: [
              { description: "auth", prompt: "inspect auth" },
              { description: "tests", prompt: "inspect tests" },
            ],
          },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 2) {
        // This is substantive enough for the text assessor, but the batch is
        // still open, so the lifecycle guard must keep the turn alive.
        yield { type: "text_delta", text: "Partial finding: the auth retry is unsafe." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (modelCalls === 3) {
        expect(input.developer?.join("\n")).toContain("task_wait_batch with wait_for=any");
        yield {
          type: "tool_call",
          name: "task_wait_batch",
          input: { task_ids: ["task_1", "task_2"], wait_for: "any", batch_id: "supervised_review" },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 4) {
        yield {
          type: "tool_call",
          name: "task_followup",
          input: { task_id: "task_1", prompt: "verify the retry fence and give exact evidence" },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 5) {
        yield {
          type: "tool_call",
          name: "task_wait_batch",
          input: { task_ids: ["task_1", "task_2"], batch_id: "supervised_review" },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 6) {
        yield { type: "text_delta", text: "All agents completed." };
        yield { type: "finish", reason: "stop" };
        return;
      }

      expect(input.developer?.join("\n")).toContain("substantive integrated findings");
      yield {
        type: "text_delta",
        text: "Integrated result: task 1 verified the missing retry fence with exact evidence; task 2 confirmed the regression test gap. Fix both together and run the race test.",
      };
      yield { type: "finish", reason: "stop" };
    },
  };
  const service = fixture.service(model);

  try {
    const result = await service.submitPrompt({
      sessionId: fixture.sessionId,
      text: "用两个代理交互审阅，必要时追问，最后综合",
      maxTurns: 12,
    });

    expect(result.status).toBe("completed");
    expect(result.turns).toHaveLength(7);
    expect(controller.waitInputs.map((input) => input.waitFor)).toEqual(["any", "all"]);
    expect(controller.followupInputs).toEqual([{
      taskId: "task_1",
      prompt: "verify the retry fence and give exact evidence",
    }]);
    expect(messageText(await fixture.store.messages(fixture.sessionId))).toContain(
      "Integrated result: task 1 verified the missing retry fence",
    );
  } finally {
    await fixture.close();
  }
});

test("supervised batch requires wait-all to cover every task in the original batch", async () => {
  const fixture = await createFixture("supervised-full-all");
  const controller = new JoinedBatchController(true);
  fixture.registry.register(createTaskBatchTool(controller, controller));
  fixture.registry.register(createTaskWaitBatchTool(controller));
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield {
          type: "tool_call",
          name: "task_batch",
          input: {
            completion_policy: "supervised",
            tasks: [
              { description: "auth", prompt: "inspect auth" },
              { description: "tests", prompt: "inspect tests" },
            ],
          },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 2) {
        yield {
          type: "tool_call",
          name: "task_wait_batch",
          input: { task_ids: ["task_1", "task_2"], wait_for: "any" },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 3) {
        yield {
          type: "tool_call",
          name: "task_wait_batch",
          input: { task_ids: ["task_1"], wait_for: "all" },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 4) {
        yield { type: "text_delta", text: "Integrated result: both reviews found a retry problem." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      if (modelCalls === 5) {
        expect(input.developer?.join("\n")).toContain("required all-task closure check");
        yield {
          type: "tool_call",
          name: "task_wait_batch",
          input: { task_ids: ["task_1", "task_2"], wait_for: "all" },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }

      yield {
        type: "text_delta",
        text: "Integrated result: auth lacks the retry fence and tests lack the matching race regression.",
      };
      yield { type: "finish", reason: "stop" };
    },
  };
  const service = fixture.service(model);

  try {
    const result = await service.submitPrompt({
      sessionId: fixture.sessionId,
      text: "supervise both reviews and integrate them",
      maxTurns: 10,
    });

    expect(result.status).toBe("completed");
    expect(result.turns).toHaveLength(6);
    expect(controller.waitInputs.map((wait) => ({
      waitFor: wait.waitFor,
      taskIds: wait.taskIds,
    }))).toEqual([
      { waitFor: "any", taskIds: ["task_1", "task_2"] },
      { waitFor: "all", taskIds: ["task_1"] },
      { waitFor: "all", taskIds: ["task_1", "task_2"] },
    ]);
  } finally {
    await fixture.close();
  }
});

test("split wait-all calls close parallel supervised batches without being blocked by unrelated join work", async () => {
  const fixture = await createFixture("supervised-split-mixed");
  const supervised = new JoinedBatchController(false, "supervised");
  const joined = new JoinedBatchController(false, "joined");
  fixture.registry.register(createTaskBatchTool(supervised, supervised));
  fixture.registry.register(createTaskWaitBatchTool(supervised));
  fixture.registry.register(createTaskTool(joined));
  fixture.registry.register(createTaskWaitTool(joined));
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: "tool_call", name: "task_batch", input: {
          completion_policy: "supervised",
          tasks: [{ description: "auth", prompt: "inspect auth" }],
        } };
        yield { type: "tool_call", name: "task_batch", input: {
          completion_policy: "supervised",
          tasks: [{ description: "cache", prompt: "inspect cache" }],
        } };
        yield { type: "tool_call", name: "task", input: { description: "join", prompt: "inspect joined work" } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 2 || modelCalls === 3) {
        const taskId = modelCalls === 2 ? "supervised_1" : "supervised_2";
        yield { type: "tool_call", name: "task_wait_batch", input: { task_ids: [taskId], wait_for: "all" } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 4) {
        yield { type: "tool_call", name: "task_wait", input: { task_id: "joined_1" } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      yield {
        type: "text_delta",
        text: "Auth uses an unsafe retry, while the cache race lacks a regression test.",
      };
      yield { type: "finish", reason: "stop" };
    },
  };

  try {
    const result = await fixture.service(model).submitPrompt({
      sessionId: fixture.sessionId,
      text: "supervise two batches while joined work also runs",
      maxTurns: 10,
    });
    expect(result.status).toBe("completed");
    expect(result.turns).toHaveLength(5);
    expect(supervised.waitInputs.map((wait) => wait.taskIds)).toEqual([["supervised_1"], ["supervised_2"]]);
  } finally {
    await fixture.close();
  }
});

test("a later supervised batch can close after an earlier batch was integrated in the same prompt", async () => {
  const fixture = await createFixture("supervised-sequential");
  const controller = new JoinedBatchController();
  fixture.registry.register(createTaskBatchTool(controller, controller));
  fixture.registry.register(createTaskWaitBatchTool(controller));
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1 || modelCalls === 3) {
        yield { type: "tool_call", name: "task_batch", input: {
          completion_policy: "supervised",
          tasks: [{ description: `batch ${modelCalls}`, prompt: "inspect" }],
        } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 2 || modelCalls === 4) {
        yield { type: "tool_call", name: "task_wait_batch", input: {
          task_ids: [modelCalls === 2 ? "task_1" : "task_2"],
          wait_for: "all",
        } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text: "Auth uses an unsafe retry, and the cache race lacks a regression test." };
      yield { type: "finish", reason: "stop" };
    },
  };

  try {
    const result = await fixture.service(model).submitPrompt({
      sessionId: fixture.sessionId,
      text: "review two supervised batches in sequence",
      maxTurns: 8,
    });
    expect(result.status).toBe("completed");
    expect(result.turns).toHaveLength(5);
  } finally {
    await fixture.close();
  }
});

test("supervised batch fails closed instead of idling when the model repeatedly ignores open tasks", async () => {
  const fixture = await createFixture("supervised-stubborn");
  const controller = new JoinedBatchController();
  fixture.registry.register(createTaskBatchTool(controller, controller));
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield {
          type: "tool_call",
          name: "task_batch",
          input: {
            completion_policy: "supervised",
            tasks: [{ description: "open", prompt: "keep working" }],
          },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text: "Partial finding: work is still running." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const service = fixture.service(model);

  try {
    const result = await service.submitPrompt({
      sessionId: fixture.sessionId,
      text: "supervise this work",
      maxTurns: 5,
    });

    expect(result).toMatchObject({
      status: "max_turns",
      finishReason: "delegation_open_tasks",
    });
    expect(result.turns).toHaveLength(4);
    expect(modelCalls).toBe(4);
    const statusEvents = await fixture.store.events({ type: "session.status_changed", limit: 50 });
    expect(statusReasons(statusEvents)).toContain("delegation_open_tasks");
    expect(statusValues(statusEvents)).not.toContain("idle");
  } finally {
    await fixture.close();
  }
});

test("supervised batch repairs generic verdicts and fails closed if no result is integrated", async () => {
  const fixture = await createFixture("supervised-generic");
  const controller = new JoinedBatchController();
  fixture.registry.register(createTaskBatchTool(controller, controller));
  fixture.registry.register(createTaskWaitBatchTool(controller));
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield {
          type: "tool_call",
          name: "task_batch",
          input: {
            completion_policy: "supervised",
            tasks: [{ description: "review", prompt: "find the concrete issue" }],
          },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 2) {
        yield {
          type: "tool_call",
          name: "task_wait_batch",
          input: { task_ids: ["task_1"], wait_for: "all" },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls > 3) {
        expect(input.developer?.join("\n")).toContain("generic review verdict");
      }
      yield { type: "text_delta", text: "Reviewed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const service = fixture.service(model);

  try {
    const result = await service.submitPrompt({
      sessionId: fixture.sessionId,
      text: "supervise the review and give the concrete result",
      maxTurns: 8,
    });

    expect(result).toMatchObject({
      status: "max_turns",
      finishReason: "delegation_integration_incomplete",
    });
    expect(result.turns).toHaveLength(5);
    expect(modelCalls).toBe(5);
    expect(statusReasons(await fixture.store.events({ type: "session.status_changed", limit: 50 }))).toContain(
      "delegation_integration_incomplete",
    );
    expect(statusValues(await fixture.store.events({ type: "session.status_changed", limit: 50 }))).not.toContain("idle");
  } finally {
    await fixture.close();
  }
});

test("a failed follow-up after closure is integrated as a blocker instead of reopening an uncloseable batch", async () => {
  const fixture = await createFixture("supervised-followup-error");
  const controller = new JoinedBatchController();
  controller.followupError = "provider quota 2062";
  fixture.registry.register(createTaskBatchTool(controller, controller));
  fixture.registry.register(createTaskWaitBatchTool(controller));
  fixture.registry.register(createTaskFollowupTool(controller));
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: "tool_call", name: "task_batch", input: {
          completion_policy: "supervised",
          tasks: [{ description: "auth", prompt: "inspect auth" }],
        } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 2) {
        yield { type: "tool_call", name: "task_wait_batch", input: { task_ids: ["task_1"], wait_for: "all" } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 3) {
        yield { type: "tool_call", name: "task_followup", input: { task_id: "task_1", prompt: "verify" } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 4) {
        yield { type: "text_delta", text: "Auth uses an unsafe retry." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Auth uses an unsafe retry; verification was blocked by provider quota 2062." };
      yield { type: "finish", reason: "stop" };
    },
  };

  try {
    const result = await fixture.service(model).submitPrompt({
      sessionId: fixture.sessionId,
      text: "supervise and verify auth",
      maxTurns: 8,
    });
    expect(result.status).toBe("completed");
    expect(result.turns).toHaveLength(5);
    expect(modelCalls).toBe(5);
  } finally {
    await fixture.close();
  }
});

test("a supervised task_batch execution error must be reported before the parent can close", async () => {
  const fixture = await createFixture("supervised-batch-tool-error");
  fixture.registry.register({
    name: "task_batch",
    description: "Fail a supervised batch for the closure test.",
    risk: "execute",
    inputSchema: { type: "object" },
    approval: () => false,
    async execute() {
      throw new Error("provider quota 2062");
    },
  });
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: "tool_call", name: "task_batch", input: {
          completion_policy: "supervised",
          tasks: [{ description: "auth", prompt: "inspect auth" }],
        } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 2) {
        yield { type: "text_delta", text: "Auth lacks retry fencing." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "The supervised batch was blocked by provider quota 2062." };
      yield { type: "finish", reason: "stop" };
    },
  };

  try {
    const result = await fixture.service(model).submitPrompt({
      sessionId: fixture.sessionId,
      text: "supervise auth",
      maxTurns: 6,
    });
    expect(result.status).toBe("completed");
    expect(result.turns).toHaveLength(3);
    expect(modelCalls).toBe(3);
  } finally {
    await fixture.close();
  }
});

test("an explicit all-spawn-failure result requires the parent to report its concrete blocker", async () => {
  const fixture = await createFixture("supervised-all-spawn-failed");
  const controller = new JoinedBatchController();
  controller.spawnError = "provider quota 2062";
  fixture.registry.register(createTaskBatchTool(controller, controller));
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: "tool_call", name: "task_batch", input: {
          completion_policy: "supervised",
          tasks: [{ description: "auth", prompt: "inspect auth" }],
        } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 2) {
        yield { type: "text_delta", text: "Auth lacks retry fencing." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      yield { type: "text_delta", text: "Spawning the auth reviewer was blocked by provider quota 2062." };
      yield { type: "finish", reason: "stop" };
    },
  };

  try {
    const result = await fixture.service(model).submitPrompt({
      sessionId: fixture.sessionId,
      text: "supervise auth",
      maxTurns: 6,
    });
    expect(result.status).toBe("completed");
    expect(result.turns).toHaveLength(3);
    expect(modelCalls).toBe(3);
    expect(controller.waitInputs).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test.each([
  ["empty array", "[]", 1],
  ["invalid task record", JSON.stringify({ tasks: [{}] }), 1],
  ["empty task_states", JSON.stringify({ task_states: [] }), 1],
  [
    "missing one of two requested outcomes",
    JSON.stringify({ tasks: [{ task_id: "task_1", status: "completed", summary: "auth retry fence missing" }] }),
    2,
  ],
] as const)("a supervised %s lifecycle result is unreadable and fails closed", async (label, output, count) => {
  const fixture = await createFixture(`supervised-unreadable-${label.replaceAll(" ", "-")}`);
  fixture.registry.register({
    name: "task_batch",
    description: "Return a malformed supervised lifecycle envelope.",
    risk: "execute",
    inputSchema: { type: "object" },
    approval: () => false,
    async execute() {
      return { title: "malformed task_batch", output };
    },
  });
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: "tool_call", name: "task_batch", input: {
          completion_policy: "supervised",
          tasks: Array.from({ length: count }, (_, index) => ({
            description: `task ${index}`,
            prompt: `inspect ${index}`,
          })),
        } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text: "Database schema uses UUID primary keys." };
      yield { type: "finish", reason: "stop" };
    },
  };

  try {
    const result = await fixture.service(model).submitPrompt({
      sessionId: fixture.sessionId,
      text: "supervise the review",
      maxTurns: 6,
    });
    expect(result.status).toBe("max_turns");
    expect(["delegation_integration_incomplete", "delegation_open_tasks"]).toContain(result.finishReason ?? "");
    expect(statusValues(await fixture.store.events({ type: "session.status_changed", limit: 50 }))).not.toContain("idle");
  } finally {
    await fixture.close();
  }
});

test("forced final assessment ignores substantive commentary and rejects a generic final answer", async () => {
  const fixture = await createFixture("supervised-final-phase");
  const controller = new JoinedBatchController();
  fixture.registry.register(createTaskBatchTool(controller, controller));
  fixture.registry.register(createTaskWaitBatchTool(controller));
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: "tool_call", name: "task_batch", input: {
          completion_policy: "supervised",
          tasks: [{ description: "auth", prompt: "inspect auth" }],
        } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      if (modelCalls === 2) {
        yield { type: "tool_call", name: "task_wait_batch", input: { task_ids: ["task_1"] } };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", index: 0, phase: "commentary", text: "Auth uses an unsafe retry." };
      yield { type: "text_delta", index: 1, phase: "final_answer", text: "Reviewed." };
      yield { type: "finish", reason: "stop" };
    },
  };

  try {
    const result = await fixture.service(model).submitPrompt({
      sessionId: fixture.sessionId,
      text: "supervise auth",
      maxTurns: 2,
    });
    expect(result).toMatchObject({
      status: "max_turns",
      finishReason: "delegation_integration_incomplete",
    });
    expect(statusValues(await fixture.store.events({ type: "session.status_changed", limit: 50 }))).not.toContain("idle");
  } finally {
    await fixture.close();
  }
});

async function createFixture(label: string) {
  const dir = await mkdtemp(join(tmpdir(), `chili-delegation-closure-${label}-`));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const registry = new InMemoryToolRegistry();
  const sessionId = `session_closure_${label}` as SessionId;
  let id = 0;
  const createId = (prefix: string) => `${prefix}_${++id}`;

  await store.append({
    id: `event_session_${label}`,
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd: "/repo" },
  });

  return {
    dir,
    store,
    registry,
    sessionId,
    service(model: ModelRouter) {
      const runtime = new SingleAgentRuntime({
        store,
        model,
        toolRegistry: registry,
        toolExecutor: new ToolExecutor({
          registry,
          events: { publish: (event) => store.append(event) },
          approvals: { decide: async () => ({ action: "allow_once" }) },
          createId,
          now: () => 1 as TimestampMs,
        }),
        createId,
        now: () => 1 as TimestampMs,
      });
      return new RuntimeService({
        runtime,
        store,
        cwd: "/repo",
        createId,
        now: () => 1 as TimestampMs,
      });
    },
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

class JoinedBatchController implements SubagentController, SubagentControlController {
  private spawned = 0;
  readonly waitInputs: TaskWaitBatchToolInput[] = [];
  readonly followupInputs: TaskFollowupToolInput[] = [];
  followupError?: string;
  spawnError?: string;

  constructor(
    private readonly anyWaitReturnsAllTerminal = false,
    private readonly taskPrefix = "task",
  ) {}

  async spawnTask(_input: TaskToolInput, _context: SubagentToolContext): Promise<SubagentTaskHandle> {
    this.spawned += 1;
    if (this.spawnError) throw new Error(this.spawnError);
    return { taskId: `${this.taskPrefix}_${this.spawned}`, status: "running", summary: "" };
  }

  async completeTask(): Promise<SubagentTaskCompletion> {
    throw new Error("not used");
  }

  async waitTasks(input: TaskWaitBatchToolInput): Promise<SubagentTaskBatchWaitRecord> {
    this.waitInputs.push(input);
    if (input.waitFor === "any") {
      if (this.anyWaitReturnsAllTerminal) {
        return {
          waitFor: "any",
          satisfied: true,
          timedOut: false,
          tasks: input.taskIds.map((taskId, index) => ({
            taskId,
            status: "completed",
            summary: index === 0 ? "auth uses an unsafe retry" : "regression test is missing",
          })),
        };
      }
      return {
        waitFor: "any",
        satisfied: true,
        timedOut: false,
        tasks: [
          { taskId: "task_1", status: "completed", summary: "auth retry appears unsafe" },
          { taskId: "task_2", status: "running", summary: "" },
        ],
      };
    }
    return {
      waitFor: input.waitFor ?? "all",
      satisfied: true,
      timedOut: false,
      tasks: input.taskIds.map((taskId) => ({
        taskId,
        status: "completed",
        summary: taskId.endsWith("_1") ? "auth uses an unsafe retry" : "cache race regression test is missing",
      })),
    };
  }

  async listTasks(_input: TaskListToolInput): Promise<SubagentTaskRecord[]> { throw new Error("not used"); }
  async waitTask(input: TaskWaitToolInput): Promise<SubagentTaskRecord> {
    return {
      taskId: input.taskId,
      status: "completed",
      summary: input.taskId.endsWith("_1") ? "auth uses an unsafe retry" : "cache race regression test is missing",
    };
  }
  async followupTask(input: TaskFollowupToolInput): Promise<SubagentTaskRecord> {
    this.followupInputs.push(input);
    if (this.followupError) throw new Error(this.followupError);
    return { taskId: input.taskId, status: "completed", summary: "verified missing retry fence at exact call site" };
  }
  async closeTask(_input: TaskCloseToolInput): Promise<SubagentTaskRecord> { throw new Error("not used"); }
  async listMailbox(_input: MailboxListToolInput): Promise<SubagentMailboxRecord[]> { throw new Error("not used"); }
  async consumeMailbox(_input: MailboxConsumeToolInput): Promise<SubagentMailboxRecord> { throw new Error("not used"); }
}

function messageText(messages: readonly { parts: readonly unknown[] }[]): string {
  return messages
    .flatMap((message) => message.parts)
    .flatMap((part) => isTextPart(part) ? [part.text] : [])
    .join("\n");
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return typeof value === "object" && value !== null
    && "type" in value && value.type === "text"
    && "text" in value && typeof value.text === "string";
}

function statusReasons(events: readonly { payload: unknown }[]): string[] {
  return events.flatMap((event) => {
    const payload = event.payload;
    return typeof payload === "object" && payload !== null
      && "reason" in payload && typeof payload.reason === "string"
      ? [payload.reason]
      : [];
  });
}

function statusValues(events: readonly { payload: unknown }[]): string[] {
  return events.flatMap((event) => {
    const payload = event.payload;
    return typeof payload === "object" && payload !== null
      && "status" in payload && typeof payload.status === "string"
      ? [payload.status]
      : [];
  });
}
