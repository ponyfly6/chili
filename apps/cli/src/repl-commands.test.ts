import { expect, test } from "bun:test";
import type { RuntimeCommandCatalog, SessionId } from "@chili/protocol";
import { createCliReplCommandRegistry, dispatchCliReplCommand, type CliReplCommandContext } from "./repl-commands.js";

const currentSessionId = "session_current" as SessionId;

function context(calls: string[], sessionId = currentSessionId): CliReplCommandContext {
  return {
    sessionId,
    cwd: "/repo",
    listSessions: async () => { calls.push("sessions"); },
    setModel: async (id, selection) => { calls.push(`model:${id}:${selection.provider}/${selection.model}`); },
    setReasoning: async (id, level) => { calls.push(`reasoning:${id}:${level}`); },
    setServiceTier: async (id, tier) => { calls.push(`service:${id}:${tier}`); },
    compactSession: async (id, focus) => { calls.push(`compact:${id}:${focus}`); },
    revertSession: async (id, snapshotId) => { calls.push(`revert:${id}:${snapshotId}`); },
    showDelegation: async (id, policy) => { calls.push(`delegation:${id}:${policy ?? "status"}`); },
    showAgents: async (id) => { calls.push(`agents:${id}`); },
    stopAgent: async (id, agentId) => { calls.push(`stop:${id}:${agentId}`); },
    resumeAgent: async (id, agentId) => { calls.push(`resume:${id}:${agentId}`); },
    showMemory: async (cwd, scope) => { calls.push(`memory-show:${cwd}:${scope}`); },
    addMemory: async (cwd, input) => { calls.push(`memory-add:${cwd}:${input}`); },
    reloadMemory: async (cwd, scope) => { calls.push(`memory-reload:${cwd}:${scope}`); },
    runPromptCommand: async (id, commandId, args) => { calls.push(`prompt:${id}:${commandId}:${args}`); },
  };
}

test("CLI dispatcher scopes session and agent commands to the active session", async () => {
  const calls: string[] = [];
  const registry = createCliReplCommandRegistry();
  const ctx = context(calls);

  expect((await dispatchCliReplCommand(registry, ctx, "/session list")).status).toBe("handled");
  await dispatchCliReplCommand(registry, ctx, "/session compact keep decisions");
  await dispatchCliReplCommand(registry, ctx, "/session revert snap_1");
  await dispatchCliReplCommand(registry, ctx, "/session delegation");
  await dispatchCliReplCommand(registry, ctx, "/agents");
  await dispatchCliReplCommand(registry, ctx, "/agents list");
  await dispatchCliReplCommand(registry, ctx, "/agents stop session_worker");
  await dispatchCliReplCommand(registry, ctx, "/agents resume session_worker");
  await dispatchCliReplCommand(registry, ctx, "/memory show --all");
  await dispatchCliReplCommand(registry, ctx, "/memory add --project remember this");
  await dispatchCliReplCommand(registry, ctx, "/memory reload --user");

  expect(calls).toEqual([
    "sessions",
    "compact:session_current:keep decisions",
    "revert:session_current:snap_1",
    "delegation:session_current:status",
    "agents:session_current",
    "agents:session_current",
    "stop:session_current:session_worker",
    "resume:session_current:session_worker",
    "memory-show:/repo:--all",
    "memory-add:/repo:--project remember this",
    "memory-reload:/repo:--user",
  ]);
});

test("model, reasoning, service, and delegation changes use persisted session controls", async () => {
  const calls: string[] = [];
  const registry = createCliReplCommandRegistry();
  const ctx = context(calls, "session_model" as SessionId);

  await dispatchCliReplCommand(registry, ctx, "/model select xai/grok-4.6");
  await dispatchCliReplCommand(registry, ctx, "/thinking effort ultra");
  await dispatchCliReplCommand(registry, ctx, "/model service fast");
  await dispatchCliReplCommand(registry, ctx, "/session delegation proactive");

  expect(calls).toEqual([
    "model:session_model:xai/grok-4.6",
    "reasoning:session_model:ultra",
    "service:session_model:fast",
    "delegation:session_model:proactive",
  ]);
});

test("CLI help includes canonical session-scoped recovery", async () => {
  const registry = createCliReplCommandRegistry();
  const ctx = context([]);
  const help = await dispatchCliReplCommand(registry, ctx, "/help");
  expect(help.status).toBe("handled");
  expect(help.output).toContain("/model select <provider/model>");
  expect(help.output).toContain("/session compact [focus]");
  expect(help.output).toContain("/session delegation [off|explicit|proactive|status]");
  expect(help.output).toContain("/agents list");
  expect(help.output).toContain("/agents resume");
  expect(help.output).toContain("/app exit");

  for (const legacy of ["/exit", "/quit", "/sessions", "/team", "/tasks", "/recover-tasks", "/compact", "/revert"]) {
    const result = await dispatchCliReplCommand(registry, ctx, legacy);
    expect(result.status).toBe("error");
  }
});

test("CLI dispatcher reports invalid, incomplete, and non-command input without fuzzy execution", async () => {
  const registry = createCliReplCommandRegistry();
  const ctx = context([]);
  const incomplete = await dispatchCliReplCommand(registry, ctx, "/agents stop");
  expect(incomplete).toMatchObject({ status: "error" });
  expect(incomplete.output).toContain("Usage: /agents stop <agent-id>");

  const unknown = await dispatchCliReplCommand(registry, ctx, "/sesion list");
  expect(unknown).toMatchObject({ status: "error" });
  expect(unknown.output).toContain("Did you mean /session");

  const invalidReasoning = await dispatchCliReplCommand(registry, ctx, "/thinking effort enormous");
  expect(invalidReasoning).toMatchObject({ status: "error" });
  expect(invalidReasoning.output).toContain("reasoning level must be one of");

  expect((await dispatchCliReplCommand(registry, ctx, "ordinary prompt")).status).toBe("not_command");
  expect((await dispatchCliReplCommand(registry, ctx, "/tmp/worktree")).status).toBe("not_command");
});

test("runtime prompt leaves dispatch by canonical command ID and current session", async () => {
  const calls: string[] = [];
  const catalog: RuntimeCommandCatalog = {
    roots: [{
      id: "prompt",
      name: "prompt",
      path: "/prompt",
      title: "Prompts",
      description: "Reusable prompts",
      group: "prompt",
      source: "builtin",
      argumentMode: "none",
      argumentHint: "",
      selectionMode: "drilldown",
      concurrency: "allow",
      hidden: false,
      enabled: true,
      executionTarget: "prompt",
      children: [{
        id: "prompt.project.review",
        name: "review",
        path: "/prompt review",
        title: "Review",
        description: "Review code",
        group: "prompt",
        source: "project",
        argumentMode: "optional",
        argumentHint: "[focus]",
        selectionMode: "execute",
        concurrency: "allow",
        hidden: false,
        enabled: true,
        executionTarget: "prompt",
        children: [],
      }],
    }],
    diagnostics: [],
  };
  const registry = createCliReplCommandRegistry(catalog);
  const result = await dispatchCliReplCommand(registry, context(calls), "/prompt review auth");

  expect(result.status).toBe("handled");
  expect(calls).toEqual(["prompt:session_current:prompt.project.review:auth"]);
});

test("/app exit returns a structured exit result", async () => {
  const result = await dispatchCliReplCommand(createCliReplCommandRegistry(), context([]), "/app exit");
  expect(result).toEqual({ status: "exit" });
});
