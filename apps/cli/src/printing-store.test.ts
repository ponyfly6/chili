import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { TeamControlService, TeamTaskDispatchService, type TeamTaskSubagentRunner } from "@chili/core";
import type { AgentPath, AgentRunId, ChiliEvent, SessionId, TaskId, TeamId, ThreadId } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { CliPrinter, PrintingEventStore } from "./printing-store.js";

test("printing store forwards team task claims through the observable store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-printing-team-claim-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const printer = { event: (_event: ChiliEvent) => undefined } as CliPrinter;
  const store = new ObservableEventStore(new PrintingEventStore(sqlite, printer));
  const teams = new TeamControlService({ store });
  const sessionId = "session_printing_claim" as SessionId;
  const teamId = "team_printing_claim" as TeamId;
  const taskId = "task_printing_claim" as TaskId;
  const workerPath = "/agents/worker" as AgentPath;

  try {
    await teams.createTeam({ sessionId, teamId, name: "printing claim", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId, path: workerPath, name: "worker", role: "implementer" });
    await teams.createTask({ sessionId, teamId, taskId, title: "Claim me", ownerPath: workerPath });

    const claimed = await teams.claimTask({ sessionId, teamId, taskId, ownerPath: workerPath });

    expect(claimed.applied).toBe(true);
    expect(claimed.task).toMatchObject({
      id: taskId,
      status: "in_progress",
      ownerPath: workerPath,
    });
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("team dispatcher can claim through printing store before spawning a worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-printing-team-dispatch-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const printer = { event: (_event: ChiliEvent) => undefined } as CliPrinter;
  const store = new ObservableEventStore(new PrintingEventStore(sqlite, printer));
  const teams = new TeamControlService({ store });
  const spawned: string[] = [];
  const subagents: TeamTaskSubagentRunner = {
    async spawnTask(input) {
      spawned.push(input.prompt);
      return {
        taskId: "agent_task_printing_dispatch" as TaskId,
        runId: "run_printing_dispatch" as AgentRunId,
        path: "/agents/worker/task" as AgentPath,
        parentPath: input.parentPath ?? ("/root" as AgentPath),
        childSessionId: "session_child_printing_dispatch" as SessionId,
        childThreadId: "thread_child_printing_dispatch" as ThreadId,
        status: "completed",
        summary: "worker completed",
      };
    },
  };
  const dispatcher = new TeamTaskDispatchService({ teams, subagents, store, cwd: dir });
  const sessionId = "session_printing_dispatch" as SessionId;
  const teamId = "team_printing_dispatch" as TeamId;
  const taskId = "task_printing_dispatch" as TaskId;
  const workerPath = "/agents/worker" as AgentPath;

  try {
    await teams.createTeam({ sessionId, teamId, name: "printing dispatch", leadPath: "/root" as AgentPath });
    await teams.addMember({ sessionId, teamId, path: workerPath, name: "worker", role: "implementer" });
    await teams.createTask({ sessionId, teamId, taskId, title: "Dispatch me", ownerPath: workerPath });

    const dispatched = await dispatcher.dispatchTask({ sessionId, teamId, taskId, mode: "one_shot" });

    expect(dispatched.status).toBe("completed");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain(`Team task: ${teamId}/${taskId}`);
    expect(dispatched.teamTask).toMatchObject({
      id: taskId,
      status: "completed",
      summary: "worker completed",
    });
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});
