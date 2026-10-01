import { expect, test } from "bun:test";
import type { RuntimeCommandCatalog } from "@chili/protocol";
import { completeCommandsSync, resolveCommand } from "@chili/commands";
import { createTuiCommandRegistry } from "./catalog.js";
import type { TuiCommandContext } from "./types.js";

const context = {
  model: {},
  busy: false,
  modelCandidates: [
    { provider: "openai-codex", model: "gpt-5.5", displayName: "GPT-5.5" },
    { provider: "kimi", model: "kimi-k2.6", displayName: "Kimi K2.6", default: true },
  ],
  skills: [],
  allSkills: [],
  mcpServers: [],
} as unknown as TuiCommandContext;

test("TUI bindings execute auth and session paths", async () => {
  const registry = createTuiCommandRegistry();

  expect(resolveCommand(registry, context, "/login").status).toBe("unknown");
  expect(resolveCommand(registry, context, "/new").status).toBe("unknown");

  const login = resolveCommand(registry, context, "/auth login");
  expect(login.status).toBe("matched");
  if (login.status !== "matched" || !login.command.run) return;
  expect(await login.command.run(context, login.args)).toEqual({
    type: "auth_action",
    action: "login",
    provider: "openai-codex",
  });

  const fresh = resolveCommand(registry, context, "/session new");
  expect(fresh.status).toBe("matched");
  if (fresh.status !== "matched" || !fresh.command.run) return;
  expect(await fresh.command.run(context, fresh.args)).toEqual({
    type: "confirm",
    title: "Start a new session?",
    result: { type: "new_session" },
  });

  const rename = resolveCommand(registry, context, "/rename");
  expect(rename.status).toBe("matched");
  if (rename.status !== "matched" || !rename.command.run) return;
  expect(await rename.command.run(context, rename.args)).toEqual({
    type: "open_rename_prompt",
  });

  const renameWithTitle = resolveCommand(registry, context, "/rename  Release   planning ");
  expect(renameWithTitle.status).toBe("matched");
  if (renameWithTitle.status !== "matched" || !renameWithTitle.command.run) return;
  expect(await renameWithTitle.command.run(context, renameWithTitle.args)).toEqual({
    type: "rename_session",
    title: "Release planning",
  });
});

test("TUI model, thinking, and goal bindings preserve exact arguments", async () => {
  const registry = createTuiCommandRegistry();
  const model = resolveCommand(registry, context, "/model select openai-codex/gpt-5.5:high");
  const thinking = resolveCommand(registry, context, "/thinking effort xhigh");
  const goal = resolveCommand(registry, context, "/goal set --budget 50k Ship The Goal");

  expect(model.status).toBe("matched");
  expect(thinking.status).toBe("matched");
  expect(goal.status).toBe("matched");
  if (model.status !== "matched" || thinking.status !== "matched" || goal.status !== "matched") return;
  if (!model.command.run || !thinking.command.run || !goal.command.run) return;

  expect(await model.command.run(context, model.args)).toEqual({
    type: "set_model",
    selection: { provider: "openai-codex", model: "gpt-5.5" },
    reasoningLevel: "high",
  });
  expect(await thinking.command.run(context, thinking.args)).toEqual({ type: "set_reasoning", level: "xhigh" });
  expect(await goal.command.run(context, goal.args)).toEqual({
    type: "goal_action",
    action: "set",
    objective: "Ship The Goal",
    tokenBudget: 50_000,
  });
});

test("TUI reasoning and service bindings honor active model capabilities", async () => {
  const registry = createTuiCommandRegistry();
  const capable = { ...context, availableReasoningLevels: ["max", "ultra"] as const };
  const completions = completeCommandsSync(registry, capable, "/thinking effort ");
  expect(completions.map((item) => item.value)).toEqual([
    "/thinking effort max",
    "/thinking effort ultra",
  ]);

  const ultra = resolveCommand(registry, capable, "/thinking effort ultra");
  expect(ultra.status).toBe("matched");
  if (ultra.status !== "matched" || !ultra.command.run) return;
  expect(await ultra.command.run(capable, ultra.args)).toEqual({ type: "set_reasoning", level: "ultra" });

  const unsupported = resolveCommand(registry, capable, "/thinking effort high");
  expect(unsupported.status).toBe("matched");
  if (unsupported.status !== "matched" || !unsupported.command.run) return;
  expect(await unsupported.command.run(capable, unsupported.args)).toEqual({
    type: "local_message",
    level: "error",
    text: "high reasoning is not available for the selected model.",
  });

  const service = resolveCommand(registry, { ...context, serviceTierConfigurable: false }, "/model service fast");
  expect(service.status).toBe("matched");
  if (service.status !== "matched" || !service.command.run) return;
  expect(await service.command.run({ ...context, serviceTierConfigurable: false }, service.args)).toEqual({
    type: "local_message",
    level: "error",
    text: "Service tiers are not available for the selected model.",
  });
});

test("TUI session delegation uses the canonical session-scoped command", async () => {
  const registry = createTuiCommandRegistry();
  expect(resolveCommand(registry, context, "/agents proactive").status).toBe("unknown");

  const status = resolveCommand(registry, context, "/session delegation");
  const proactive = resolveCommand(registry, context, "/session delegation proactive");
  expect(status.status).toBe("matched");
  expect(proactive.status).toBe("matched");
  if (status.status !== "matched" || proactive.status !== "matched") return;
  if (!status.command.run || !proactive.command.run) return;
  expect(await status.command.run(context, status.args)).toEqual({ type: "delegation_action", action: "status" });
  expect(await proactive.command.run(context, proactive.args)).toEqual({
    type: "delegation_action",
    action: "set",
    policy: "proactive",
  });
});

test("TUI destructive app exit is explicit and confirmed", async () => {
  const resolved = resolveCommand(createTuiCommandRegistry(), context, "/app exit");
  expect(resolved.status).toBe("matched");
  if (resolved.status !== "matched" || !resolved.command.run) return;
  expect(await resolved.command.run(context, resolved.args)).toEqual({
    type: "confirm",
    title: "Exit Chili?",
    result: { type: "exit_app" },
  });
});

test("busy context disables unsafe commands before execution", () => {
  const registry = createTuiCommandRegistry();

  expect(resolveCommand(registry, { ...context, busy: true }, "/team run")).toMatchObject({
    status: "disabled",
    reason: "Wait for the active turn to finish.",
  });
});

test("runtime prompt catalog is imported as an ID-based TUI proxy", async () => {
  const runtimeCatalog: RuntimeCommandCatalog = {
    roots: [{
      id: "prompt.project",
      name: "project",
      path: "/project",
      title: "Project prompts",
      description: "Project prompt namespace",
      group: "prompt",
      source: "project",
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
        path: "/project review",
        title: "Review",
        description: "Review code",
        group: "prompt",
        source: "project",
        argumentMode: "variadic",
        argumentHint: "[files]",
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
  const registry = createTuiCommandRegistry(runtimeCatalog);
  const resolved = resolveCommand(registry, context, "/project review src/index.ts");

  expect(resolved.status).toBe("matched");
  if (resolved.status !== "matched" || !resolved.command.run) return;
  expect(await resolved.command.run(context, resolved.args)).toEqual({
    type: "submit_command",
    commandId: "prompt.project.review",
    args: "src/index.ts",
  });
});
