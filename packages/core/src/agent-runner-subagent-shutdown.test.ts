import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  Message,
  MessageId,
  MessagePart,
  SessionId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type {
  AgentRunner,
  AppendUserMessageInput,
  CreateSessionInput,
  RunTurnInput,
  RunTurnResult,
} from "./runner.js";
import {
  AgentRunnerSubagentRunner,
  LocalSubagentManager,
  type LocalSubagentRunInput,
} from "./subagent.js";

test("AgentRunnerSubagentRunner abort after prompt assembly prevents a ghost child turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-runner-subagent-prompt-fence-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const promptAssemblyEntered = deferred<void>();
  const allowPromptAssembly = deferred<void>();
  const runner = new RecordingChildRunner(store);
  const subagentRunner = new AgentRunnerSubagentRunner({
    runner,
    store,
    promptFragments: async () => {
      promptAssemblyEntered.resolve();
      await allowPromptAssembly.promise;
      return [];
    },
  });
  const manager = new LocalSubagentManager({
    store,
    runner: subagentRunner,
    createId: createSequentialId(),
    now: () => 100 as TimestampMs,
  });
  const task = await manager.spawnTask({
    parentSessionId: "session_parent" as SessionId,
    cwd: "/repo",
    taskName: "prompt fence",
    prompt: "Read README",
    mode: "background",
  });
  let shutdown: Promise<void> | undefined;

  try {
    await promptAssemblyEntered.promise;
    expect(runner.createInputs).toHaveLength(1);
    expect(runner.userMessages).toHaveLength(1);
    expect(runner.turnInputs).toHaveLength(0);

    shutdown = manager.shutdown("cancelled during prompt assembly");
    allowPromptAssembly.resolve();
    await shutdown;

    expect(await store.agentTask(task.taskId)).toMatchObject({ status: "cancelled" });
    expect(runner.turnInputs).toHaveLength(0);
    expect(await store.events({ type: "turn.started" })).toHaveLength(0);
  } finally {
    allowPromptAssembly.resolve();
    await Promise.allSettled([
      shutdown ?? manager.shutdown("prompt fence cleanup"),
      manager.waitForBackgroundTasks(),
    ]);
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentRunnerSubagentRunner abort after completion assessment prevents repair and another child turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-runner-subagent-assessment-fence-"));
  const store = new MessagesBarrierStore(join(dir, "events.sqlite"));
  const runner = new RecordingChildRunner(store, "I'll inspect the repository next.");
  const subagentRunner = new AgentRunnerSubagentRunner({ runner, store, maxTurns: 2 });
  const controller = new AbortController();
  const abort = abortTestError("cancelled during completion assessment");
  const run = subagentRunner.run(localRunInput(controller.signal));
  const settlement = settle(run);

  try {
    await store.messagesEntered.promise;
    expect(runner.turnInputs).toHaveLength(1);
    expect(runner.userMessages).toHaveLength(1);

    controller.abort(abort);
    store.allowMessages.resolve();

    expect(await settlement).toMatchObject({
      status: "rejected",
      reason: {
        name: "AbortError",
        message: abort.message,
      },
    });
    expect(runner.userMessages).toHaveLength(1);
    expect(runner.turnInputs).toHaveLength(1);
  } finally {
    store.allowMessages.resolve();
    await settlement;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class RecordingChildRunner implements AgentRunner {
  readonly createInputs: CreateSessionInput[] = [];
  readonly userMessages: AppendUserMessageInput[] = [];
  readonly turnInputs: RunTurnInput[] = [];

  constructor(
    private readonly store: SqliteEventStore,
    private readonly assistantText?: string,
  ) {}

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    this.createInputs.push(input);
    const sessionId = input.sessionId ?? ("session_child" as SessionId);
    await this.store.append({
      id: `event_child_session_${this.createInputs.length}`,
      type: "session.created",
      time: 0 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: input.cwd },
    });
    return sessionId;
  }

  async appendUserMessage(input: AppendUserMessageInput): Promise<MessageId> {
    this.userMessages.push(input);
    return `message_user_${this.userMessages.length}` as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.turnInputs.push(input);
    const index = this.turnInputs.length;
    const messageId = `message_assistant_${index}` as MessageId;
    if (this.assistantText !== undefined) {
      const part: MessagePart = {
        id: `part_assistant_${index}` as never,
        messageId,
        sessionId: input.sessionId,
        type: "text",
        text: this.assistantText,
      };
      await this.store.append({
        id: `event_assistant_message_${index}`,
        type: "message.created",
        time: index as TimestampMs,
        sessionId: input.sessionId,
        payload: { messageId, role: "assistant" },
      });
      await this.store.append({
        id: `event_assistant_part_${index}`,
        type: "message.part_added",
        time: index as TimestampMs,
        sessionId: input.sessionId,
        payload: { messageId, part },
      });
    }
    return {
      status: "completed",
      turnId: `turn_child_${index}` as TurnId,
      assistantMessageId: messageId,
      finishReason: "stop",
    };
  }
}

class MessagesBarrierStore extends SqliteEventStore {
  readonly messagesEntered = deferred<void>();
  readonly allowMessages = deferred<void>();

  override async messages(sessionId: SessionId): Promise<Message[]> {
    const messages = await super.messages(sessionId);
    // Context preparation can read history before the first model turn. The
    // cancellation fence under test is the later completion assessment read.
    if (messages.some((message) => message.role === "assistant")) {
      this.messagesEntered.resolve();
      await this.allowMessages.promise;
    }
    return messages;
  }
}

function localRunInput(signal: AbortSignal): LocalSubagentRunInput {
  return {
    taskId: "task_child" as never,
    runId: "agent_child" as never,
    path: "/root/task_child",
    parentPath: "/root",
    parentSessionId: "session_parent" as SessionId,
    childSessionId: "session_child" as SessionId,
    cwd: "/repo",
    taskName: "reader",
    prompt: "Read README",
    generation: 1,
    signal,
  };
}

function abortTestError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

function settle<T>(promise: Promise<T>): Promise<
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
} {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise(value as T | PromiseLike<T>);
    },
  };
}
