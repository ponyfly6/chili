#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import type { SessionId, TaskId } from "@chili/protocol";
import { startRuntimeHttpServer } from "@chili/server";
import { DeferredApprovalQueue } from "@chili/tools";
import { parseArgs, usage } from "./args.js";
import { createCliHarness } from "./harness.js";
import { runPrompt } from "./runner.js";
import { resolveSession } from "./session.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    console.log(usage());
    return;
  }

  const approvalQueue = args.command === "serve" ? new DeferredApprovalQueue() : undefined;
  const harness = await createCliHarness({
    cwd: args.cwd,
    model: args.model,
    yes: args.yes,
    quiet: args.command === "sessions",
    ...(approvalQueue ? { approvalQueue } : {}),
  });

  try {
    if (args.command === "serve") {
      if (!approvalQueue) throw new Error("approval queue was not initialized");
      await serve({ harness, approvalQueue, host: args.host, port: args.port });
      return;
    }

    if (args.command === "sessions") {
      await printSessions(harness.store);
      return;
    }

    if (args.command === "tasks") {
      await printTasks(harness);
      return;
    }

    if (args.command === "task") {
      if (!args.taskId) throw new Error("task requires a task id");
      await printTask(harness, args.taskId as TaskId);
      return;
    }

    if (args.command === "task-followup") {
      if (!args.taskId) throw new Error("followup requires a task id");
      if (!args.prompt) throw new Error("followup requires prompt text");
      const controller = installInterruptHandler();
      const result = await harness.tasks.followupTask({
        taskId: args.taskId as TaskId,
        text: args.prompt,
        maxTurns: args.maxTurns,
        signal: controller.signal,
      });
      console.log(`[task] ${result.task.id}\t${result.task.status}\t${result.task.summary ?? ""}`);
      return;
    }

    if (args.command === "task-wait") {
      if (!args.taskId) throw new Error("wait requires a task id");
      const input: { taskId: TaskId; timeoutMs?: number } = { taskId: args.taskId as TaskId };
      if (args.timeoutMs !== undefined) input.timeoutMs = args.timeoutMs;
      const task = await harness.tasks.waitForTask(input);
      console.log(`[task] ${task.id}\t${task.status}\t${task.summary ?? ""}`);
      return;
    }

    if (args.command === "task-close") {
      if (!args.taskId) throw new Error("close requires a task id");
      const input: { taskId: TaskId; status?: "completed" | "failed" | "cancelled"; summary?: string } = {
        taskId: args.taskId as TaskId,
      };
      if (args.taskStatus) input.status = args.taskStatus;
      if (args.prompt) input.summary = args.prompt;
      const task = await harness.tasks.closeTask(input);
      console.log(`[task] ${task.id}\t${task.status}\t${task.summary ?? ""}`);
      return;
    }

    if (args.command === "revert") {
      if (!args.resume) throw new Error("revert requires --resume <session-id>");
      if (!args.snapshotId) throw new Error("revert requires a snapshot id");
      const sessionId = args.resume as SessionId;
      await harness.recovery.revert({ sessionId, snapshotId: args.snapshotId as never });
      console.log(`Reverted snapshot ${args.snapshotId}`);
      return;
    }

    const sessionInput = {
      service: harness.service,
      store: harness.store,
      cwd: harness.cwd,
    };
    const session = await resolveSession(args.resume ? { ...sessionInput, resume: args.resume } : sessionInput);

    console.log(`[session] ${session.sessionId}${session.isNew ? " (new)" : " (resumed)"}`);
    if (args.prompt) {
      const controller = installInterruptHandler();
      await runPrompt({
        harness,
        sessionId: session.sessionId,
        threadId: session.threadId,
        prompt: args.prompt,
        maxTurns: args.maxTurns,
        signal: controller.signal,
      });
      return;
    }

    await repl({
      harness,
      sessionId: session.sessionId,
      threadId: session.threadId,
      maxTurns: args.maxTurns,
    });
  } finally {
    harness.close();
  }
}

async function serve(input: {
  harness: Awaited<ReturnType<typeof createCliHarness>>;
  approvalQueue: DeferredApprovalQueue;
  host: string;
  port: number;
}): Promise<void> {
  const server = startRuntimeHttpServer({
    service: input.harness.service,
    store: input.harness.events,
    tasks: input.harness.tasks,
    approvals: input.approvalQueue,
    hostname: input.host,
    port: input.port,
  });
  console.log(`[server] ${server.url}`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      input.approvalQueue.denyAll("Runtime server stopped.");
      server.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function printSessions(store: Awaited<ReturnType<typeof createCliHarness>>["store"]): Promise<void> {
  const sessions = await store.sessions();
  if (sessions.length === 0) {
    console.log("No sessions yet.");
    return;
  }
  for (const session of sessions) {
    console.log(`${session.id}\t${session.status}\t${new Date(session.updatedAt).toISOString()}\t${session.cwd}`);
  }
}

async function printTasks(harness: Awaited<ReturnType<typeof createCliHarness>>): Promise<void> {
  const tasks = await harness.tasks.listTasks();
  if (tasks.length === 0) {
    console.log("No tasks yet.");
    return;
  }
  for (const task of tasks) {
    console.log(
      [
        task.id,
        task.status,
        task.childSessionId ?? "",
        task.updatedAt ? new Date(task.updatedAt).toISOString() : "",
        task.taskName,
        task.summary ?? "",
      ].join("\t"),
    );
  }
}

async function printTask(harness: Awaited<ReturnType<typeof createCliHarness>>, taskId: TaskId): Promise<void> {
  const task = await harness.tasks.getTask(taskId);
  console.log(JSON.stringify(task, null, 2));
}

async function repl(input: {
  harness: Awaited<ReturnType<typeof createCliHarness>>;
  sessionId: SessionId;
  threadId: import("@chili/protocol").ThreadId;
  maxTurns: number;
}): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Type /help for commands, /exit to quit.");
  try {
    while (true) {
      const line = (await rl.question("chili> ")).trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") return;
      if (line === "/help") {
        console.log(
          [
            "/help                 Show commands",
            "/sessions             List sessions",
            "/tasks                List subagent tasks",
            "/task <taskId>        Show a subagent task",
            "/revert <snapshotId>  Revert a snapshot in this session",
            "/exit                 Quit",
          ].join("\n"),
        );
        continue;
      }
      if (line === "/sessions") {
        await printSessions(input.harness.store);
        continue;
      }
      if (line === "/tasks") {
        await printTasks(input.harness);
        continue;
      }
      if (line.startsWith("/task ")) {
        await printTask(input.harness, line.slice("/task ".length).trim() as TaskId);
        continue;
      }
      if (line.startsWith("/revert ")) {
        const snapshotId = line.slice("/revert ".length).trim();
        await input.harness.recovery.revert({ sessionId: input.sessionId, threadId: input.threadId, snapshotId: snapshotId as never });
        console.log(`Reverted snapshot ${snapshotId}`);
        continue;
      }

      const controller = installInterruptHandler();
      await runPrompt({
        harness: input.harness,
        sessionId: input.sessionId,
        threadId: input.threadId,
        prompt: line,
        maxTurns: input.maxTurns,
        signal: controller.signal,
      });
    }
  } finally {
    rl.close();
  }
}

function installInterruptHandler(): AbortController {
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    console.log("\n[interrupt] cancelling current turn...");
    controller.abort();
  };
  process.once("SIGINT", onSigint);
  controller.signal.addEventListener(
    "abort",
    () => {
      process.removeListener("SIGINT", onSigint);
    },
    { once: true },
  );
  return controller;
}

main().catch((error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`chili: ${err.message}`);
  process.exitCode = 1;
});
