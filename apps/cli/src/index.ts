#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import type { AgentTreeNode, TeamExecutionRunSummary, TeamSnapshot } from "@chili/core";
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
    quiet: args.command === "sessions" || args.json,
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
      await printTeams(harness, args.json);
      return;
    }

    if (args.command === "team") {
      if (!args.teamId) throw new Error("team requires a team id");
      await printTeam(harness, args.teamId as TeamId, args.json);
      return;
    }

    if (args.command === "team-members") {
      if (!args.teamId) throw new Error("team-members requires a team id");
      await printTeamMembers(harness, args.teamId as TeamId, args.json);
      return;
    }

    if (args.command === "team-tasks") {
      if (!args.teamId) throw new Error("team-tasks requires a team id");
      await printTeamTasks(harness, args.teamId as TeamId, args.json);
      return;
    }

    if (args.command === "team-messages") {
      if (!args.teamId) throw new Error("team-messages requires a team id");
      await printTeamMessages(harness, args.teamId as TeamId, args.json);
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

    if (args.command === "team-run-loop") {
      if (!args.teamId) throw new Error("team-run-loop requires a team id");
      const controller = installInterruptHandler();
      const input: Parameters<typeof harness.teamRunner.run>[0] = {
        teamId: args.teamId as TeamId,
        cwd: harness.cwd,
        once: args.once,
        signal: controller.signal,
      };
      if (args.maxCycles !== undefined) input.maxCycles = args.maxCycles;
      if (args.timeoutMs !== undefined) input.timeoutMs = args.timeoutMs;
      const result = await harness.teamRunner.run(input);
      if (args.json) console.log(jsonStringify(result));
      else printTeamRunLoopSummary(result);
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
    teamRunner: input.harness.teamRunner,
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

async function printTeams(harness: Awaited<ReturnType<typeof createCliHarness>>, asJson: boolean): Promise<void> {
  const teams = await harness.teams.listTeams();
  if (teams.length === 0) {
    console.log(asJson ? "[]" : "No teams yet.");
    return;
  }
  const snapshots = await Promise.all(teams.map((team) => harness.teams.snapshot(team.id)));
  if (asJson) {
    console.log(jsonStringify(snapshots));
    return;
  }
  for (const team of teams) {
    const snapshot = snapshots.find((item) => item.team.id === team.id);
    console.log(
      [
        team.id,
        team.status,
        team.leadPath,
        snapshot ? `members=${snapshot.stats.memberCount}` : "members=?",
        snapshot ? `tasks=${snapshot.stats.taskCount}` : "tasks=?",
        snapshot ? `ready=${snapshot.stats.readyTaskIds.length}` : "ready=?",
        snapshot ? `blocked=${snapshot.stats.blockedTaskIds.length}` : "blocked=?",
        team.updatedAt ? new Date(team.updatedAt).toISOString() : "",
        team.name,
        team.description ?? "",
      ].join("\t"),
    );
  }
}

async function printTeam(harness: Awaited<ReturnType<typeof createCliHarness>>, teamId: TeamId, asJson: boolean): Promise<void> {
  const snapshot = await harness.teams.snapshot(teamId);
  if (asJson) {
    console.log(jsonStringify(snapshot));
    return;
  }

  const stats = snapshot.stats;
  console.log(
    `[team] ${snapshot.team.name} ${snapshot.team.id} ${snapshot.team.status} lead=${snapshot.team.leadPath} updated=${formatTime(
      snapshot.team.updatedAt,
    )}`,
  );
  console.log(
    `[stats] members=${stats.memberCount} tasks=${stats.taskCount} ready=${stats.readyTaskIds.length} blocked=${stats.blockedTaskIds.length} messages=${stats.messageCount} deliveries=${stats.deliveryCount}`,
  );
  printTeamMembersFromSnapshot(snapshot);
  printTeamTasksFromSnapshot(snapshot);
  printTeamMessagesFromSnapshot(snapshot, 8);
}

async function printTeamMembers(harness: Awaited<ReturnType<typeof createCliHarness>>, teamId: TeamId, asJson: boolean): Promise<void> {
  const snapshot = await harness.teams.snapshot(teamId);
  if (asJson) {
    console.log(jsonStringify(snapshot.members));
    return;
  }
  printTeamMembersFromSnapshot(snapshot);
}

async function printTeamTasks(harness: Awaited<ReturnType<typeof createCliHarness>>, teamId: TeamId, asJson: boolean): Promise<void> {
  const snapshot = await harness.teams.snapshot(teamId);
  if (asJson) {
    console.log(jsonStringify(snapshot.tasks));
    return;
  }
  printTeamTasksFromSnapshot(snapshot);
}

async function printTeamMessages(harness: Awaited<ReturnType<typeof createCliHarness>>, teamId: TeamId, asJson: boolean): Promise<void> {
  const snapshot = await harness.teams.snapshot(teamId);
  if (asJson) {
    console.log(jsonStringify(snapshot.messages));
    return;
  }
  printTeamMessagesFromSnapshot(snapshot);
}

function printTeamMembersFromSnapshot(snapshot: TeamSnapshot): void {
  if (snapshot.members.length === 0) {
    console.log("[members] none");
    return;
  }
  console.log("[members]");
  for (const member of snapshot.members) {
    console.log(
      [
        `  ${member.path}`,
        member.status,
        `task=${member.currentTaskId ?? "-"}`,
        `queued=${member.deliveryIds.length}`,
        member.childSessionId ? `session=${member.childSessionId}` : "session=-",
        member.name,
        member.role,
      ].join("\t"),
    );
  }
}

function printTeamTasksFromSnapshot(snapshot: TeamSnapshot): void {
  if (snapshot.tasks.length === 0) {
    console.log("[tasks] none");
    return;
  }
  console.log("[tasks]");
  for (const task of snapshot.tasks) {
    console.log(
      [
        `  ${task.id}`,
        taskStatusLabel(task),
        `owner=${task.ownerPath ?? "-"}`,
        `depends=${formatList(task.dependsOn)}`,
        `blocks=${formatList(task.blocks)}`,
        `messages=${task.messageIds.length}`,
        task.dispatch ? "dispatched" : "not_dispatched",
        task.title,
        task.summary ?? "",
      ].join("\t"),
    );
  }
}

function printTeamMessagesFromSnapshot(snapshot: TeamSnapshot, limit?: number): void {
  const messages = limit === undefined ? snapshot.messages : snapshot.messages.slice(-limit);
  if (messages.length === 0) {
    console.log("[messages] none");
    return;
  }
  console.log(limit === undefined || snapshot.messages.length <= limit ? "[messages]" : `[messages] latest ${messages.length}/${snapshot.messages.length}`);
  for (const message of messages) {
    console.log(
      [
        `  ${message.id}`,
        message.kind,
        `delivery=${message.deliveryStatus ?? "none"}`,
        `deliveries=${message.deliveries.length}`,
        `from=${message.fromPath}`,
        `to=${message.toPath}`,
        message.taskId ? `task=${message.taskId}` : "task=-",
        formatTime(message.createdAt),
        message.summary ?? preview(message.content),
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

function printTeamRunLoopSummary(summary: TeamExecutionRunSummary): void {
  console.log(
    [
      `[team-run-loop] ${summary.teamId}`,
      `stop=${summary.stopReason}`,
      `cycles=${summary.cycles}`,
      `dispatched=${summary.dispatched.length}`,
      `completed=${summary.completed.length}`,
      `failed=${summary.failed.length}`,
      `blocked=${summary.blocked.length}`,
      `skipped=${summary.skipped.length}`,
      `running=${summary.stillRunning.length}`,
      `errors=${summary.errors.length}`,
    ].join("\t"),
  );
  for (const item of summary.dispatched) {
    console.log(["[dispatch]", item.taskId, item.status, item.ownerPath ?? "-", item.agentTaskId ?? "-"].join("\t"));
  }
  for (const item of summary.completed) {
    console.log(["[complete]", item.taskId, item.status, item.ownerPath ?? "-", item.summary ?? ""].join("\t"));
  }
  for (const item of summary.failed) {
    console.log(["[failed]", item.taskId, item.status, item.ownerPath ?? "-", item.error ?? item.summary ?? ""].join("\t"));
  }
  for (const item of summary.blocked) {
    console.log(["[blocked]", item.taskId, item.reason, item.ownerPath ?? "-", item.blockedBy ? `blocked_by=${item.blockedBy.join(",")}` : ""].join("\t"));
  }
  for (const item of summary.skipped) {
    console.log(["[skipped]", item.taskId, item.reason, item.ownerPath ?? "-"].join("\t"));
  }
  for (const item of summary.stillRunning) {
    console.log(["[running]", item.taskId, item.ownerPath ?? "-", item.agentTaskId ?? "-", item.title].join("\t"));
  }
  for (const item of summary.errors) {
    console.log(["[error]", item.taskId ?? "-", item.error].join("\t"));
  }
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
            "/compact [focus]      Compress conversation context",
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
      if (line === "/compact" || line.startsWith("/compact ")) {
        const instructions = line.slice("/compact".length).trim();
        const controller = installInterruptHandler();
        const compactInput: {
          sessionId: SessionId;
          threadId: import("@chili/protocol").ThreadId;
          instructions?: string;
          signal: AbortSignal;
        } = {
          sessionId: input.sessionId,
          threadId: input.threadId,
          signal: controller.signal,
        };
        if (instructions) compactInput.instructions = instructions;
        const result = await input.harness.service.compactSession(compactInput);
        if (result.status === "skipped") {
          console.log(`[context] compact skipped: ${result.reason}`);
        } else if (result.status === "failed" || result.status === "cancelled") {
          console.error(`[context] compact ${result.status}: ${result.error.message}`);
        }
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

function taskStatusLabel(task: TeamSnapshot["tasks"][number]): string {
  if (task.blockedBy.length > 0) return `${task.status}:blocked_by=${task.blockedBy.join(",")}`;
  if (task.ready) return `${task.status}:ready`;
  return task.status;
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "-" : values.join(",");
}

function formatTime(value: number | undefined): string {
  return value === undefined ? "-" : new Date(value).toISOString();
}

function preview(value: string, max = 96): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
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
