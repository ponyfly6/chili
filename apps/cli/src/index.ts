#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import type { AgentTreeNode } from "@chili/core";
import type { SessionId, TaskId, TeamId } from "@chili/protocol";
import { ROOT_AGENT_PATH } from "@chili/protocol";
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

    if (args.command === "tasks-reconcile-stale") {
      const input: { staleAfterMs?: number } = {};
      if (args.staleAfterMs !== undefined) input.staleAfterMs = args.staleAfterMs;
      const result = await harness.tasks.reconcileStaleTasks(input);
      console.log(`[tasks] scanned=${result.scanned} closed=${result.closed.length}`);
      for (const task of result.closed) {
        console.log(`[task] ${task.id}\t${task.status}\t${task.summary ?? ""}`);
      }
      return;
    }

    if (args.command === "agents") {
      await printAgentTree(harness);
      return;
    }

    if (args.command === "teams") {
      await printTeams(harness);
      return;
    }

    if (args.command === "team") {
      if (!args.teamId) throw new Error("team requires a team id");
      await printTeam(harness, args.teamId as TeamId);
      return;
    }

    if (args.command === "team-members") {
      if (!args.teamId) throw new Error("team-members requires a team id");
      await printTeamMembers(harness, args.teamId as TeamId);
      return;
    }

    if (args.command === "team-tasks") {
      if (!args.teamId) throw new Error("team-tasks requires a team id");
      await printTeamTasks(harness, args.teamId as TeamId);
      return;
    }

    if (args.command === "team-messages") {
      if (!args.teamId) throw new Error("team-messages requires a team id");
      await printTeamMessages(harness, args.teamId as TeamId);
      return;
    }

    if (args.command === "team-dispatch") {
      if (!args.teamId || !args.taskId) throw new Error("team-dispatch requires a team id and task id");
      await dispatchTeamTask(harness, args.teamId as TeamId, args.taskId as TaskId, "background");
      return;
    }

    if (args.command === "team-run") {
      if (!args.teamId || !args.taskId) throw new Error("team-run requires a team id and task id");
      await dispatchTeamTask(harness, args.teamId as TeamId, args.taskId as TaskId, "one_shot");
      return;
    }

    if (args.command === "team-sync") {
      if (!args.teamId || !args.taskId) throw new Error("team-sync requires a team id and task id");
      const result = await harness.teamDispatcher.syncTask({
        teamId: args.teamId as TeamId,
        taskId: args.taskId as TaskId,
      });
      console.log(jsonStringify(result));
      return;
    }

    if (args.command === "team-reconcile") {
      const input: Parameters<typeof harness.teamDispatcher.reconcileTasks>[0] = {};
      if (args.teamId) input.teamId = args.teamId as TeamId;
      const result = await harness.teamDispatcher.reconcileTasks(input);
      console.log(jsonStringify(result));
      return;
    }

    if (args.command === "mailbox") {
      await printMailbox(harness);
      return;
    }

    if (args.command === "mailbox-consume") {
      if (!args.messageId) throw new Error("consume requires a mailbox message id");
      const message = await harness.agents.consumeMailbox({ messageId: args.messageId });
      console.log(`[mailbox] ${message.id}\t${message.status}`);
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
    await harness.close();
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
    agents: input.harness.agents,
    teams: input.harness.teams,
    teamDispatcher: input.harness.teamDispatcher,
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

async function printAgentTree(harness: Awaited<ReturnType<typeof createCliHarness>>): Promise<void> {
  const snapshot = await harness.agents.snapshot({ rootPath: ROOT_AGENT_PATH });
  if (snapshot.nodes.length === 0) {
    console.log("No agents yet.");
    return;
  }
  for (const node of snapshot.nodes) {
    printAgentTreeNode(node, 0);
  }
}

async function printTeams(harness: Awaited<ReturnType<typeof createCliHarness>>): Promise<void> {
  const teams = await harness.teams.listTeams();
  if (teams.length === 0) {
    console.log("No teams yet.");
    return;
  }
  for (const team of teams) {
    console.log(
      [
        team.id,
        team.status,
        team.leadPath,
        team.updatedAt ? new Date(team.updatedAt).toISOString() : "",
        team.name,
        team.description ?? "",
      ].join("\t"),
    );
  }
}

async function printTeam(harness: Awaited<ReturnType<typeof createCliHarness>>, teamId: TeamId): Promise<void> {
  const team = (await harness.teams.listTeams()).find((item) => item.id === teamId);
  if (!team) throw new Error(`Team not found: ${teamId}`);
  const [members, tasks, messages] = await Promise.all([
    harness.teams.members(teamId),
    harness.teams.tasks(teamId),
    harness.teams.messages(teamId),
  ]);
  console.log(JSON.stringify({ team, members, tasks, messages }, null, 2));
}

async function printTeamMembers(harness: Awaited<ReturnType<typeof createCliHarness>>, teamId: TeamId): Promise<void> {
  const members = await harness.teams.members(teamId);
  if (members.length === 0) {
    console.log("No team members.");
    return;
  }
  for (const member of members) {
    console.log(
      [
        member.path,
        member.status,
        member.currentTaskId ?? "",
        member.childSessionId ?? "",
        member.name,
        member.role,
      ].join("\t"),
    );
  }
}

async function printTeamTasks(harness: Awaited<ReturnType<typeof createCliHarness>>, teamId: TeamId): Promise<void> {
  const tasks = await harness.teams.tasks(teamId);
  if (tasks.length === 0) {
    console.log("No team tasks.");
    return;
  }
  for (const task of tasks) {
    console.log(
      [
        task.id,
        task.status,
        task.ownerPath ?? "",
        task.dependsOn.length > 0 ? task.dependsOn.join(",") : "",
        task.updatedAt ? new Date(task.updatedAt).toISOString() : "",
        task.title,
        task.summary ?? "",
      ].join("\t"),
    );
  }
}

async function printTeamMessages(harness: Awaited<ReturnType<typeof createCliHarness>>, teamId: TeamId): Promise<void> {
  const messages = await harness.teams.messages(teamId);
  if (messages.length === 0) {
    console.log("No team messages.");
    return;
  }
  for (const message of messages) {
    console.log(
      [
        message.id,
        message.kind,
        message.fromPath,
        message.toPath,
        message.taskId ?? "",
        message.createdAt ? new Date(message.createdAt).toISOString() : "",
        message.summary ?? message.content,
      ].join("\t"),
    );
  }
}

async function dispatchTeamTask(
  harness: Awaited<ReturnType<typeof createCliHarness>>,
  teamId: TeamId,
  taskId: TaskId,
  mode: "background" | "one_shot",
): Promise<void> {
  const team = (await harness.teams.listTeams()).find((item) => item.id === teamId);
  if (!team) throw new Error(`Team not found: ${teamId}`);
  const task = (await harness.teams.tasks(teamId)).find((item) => item.id === taskId);
  if (!task) throw new Error(`Team task not found: ${taskId}`);

  let sessionId = task.sessionId ?? team.sessionId;
  let threadId: import("@chili/protocol").ThreadId | undefined;
  if (!sessionId) {
    const session = await harness.service.createSession({ cwd: harness.cwd });
    sessionId = session.sessionId;
    threadId = session.threadId;
  }

  const result = await harness.teamDispatcher.dispatchTask({
    teamId,
    taskId,
    mode,
    cwd: harness.cwd,
    sessionId,
    ...(threadId ? { threadId } : {}),
  });
  console.log(jsonStringify(result));
}

async function printMailbox(harness: Awaited<ReturnType<typeof createCliHarness>>): Promise<void> {
  const messages = await harness.agents.mailbox({ status: "queued" });
  if (messages.length === 0) {
    console.log("No mailbox messages.");
    return;
  }
  for (const message of messages) {
    const content = message.message && "content" in message.message ? message.message.content : "";
    console.log([message.id, message.status, message.fromPath, message.path, content].join("\t"));
  }
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => {
      if (item instanceof Error) return item.message;
      return item;
    },
    2,
  );
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
            "/agents               Show agent tree",
            "/mailbox              List queued mailbox messages",
            "/tasks                List subagent tasks",
            "/recover-tasks        Mark stale background tasks cancelled",
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
      if (line === "/agents") {
        await printAgentTree(input.harness);
        continue;
      }
      if (line === "/mailbox") {
        await printMailbox(input.harness);
        continue;
      }
      if (line === "/tasks") {
        await printTasks(input.harness);
        continue;
      }
      if (line === "/recover-tasks") {
        const result = await input.harness.tasks.reconcileStaleTasks();
        console.log(`[tasks] scanned=${result.scanned} closed=${result.closed.length}`);
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

function printAgentTreeNode(node: AgentTreeNode, depth: number): void {
  const indent = "  ".repeat(depth);
  const runs = node.runIds.length > 0 ? ` runs=${node.runIds.length}` : "";
  const mailbox = node.mailbox.length > 0 ? ` mailbox=${node.mailbox.length}` : "";
  console.log(`${indent}${node.path}\t${node.status}\t${node.taskName || "(agent)"}${runs}${mailbox}`);
  for (const child of node.children) {
    printAgentTreeNode(child, depth + 1);
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
