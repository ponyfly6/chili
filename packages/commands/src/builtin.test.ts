import { expect, test } from "bun:test";
import { BUILTIN_COMMANDS, createBuiltinCommandRegistry } from "./builtin.js";
import { completeCommands } from "./completion.js";
import { defineCommand } from "./registry.js";
import { resolveCommand } from "./resolve.js";

test("builtin registry contains expected command surface", () => {
  const names = new Set(BUILTIN_COMMANDS.map((command) => command.name));

  expect(names).toContain("help");
  expect(names).toContain("status");
  expect(names).toContain("sessions");
  expect(names).toContain("resume");
  expect(names).toContain("new");
  expect(names).toContain("compact");
  expect(names).toContain("diff");
  expect(names).toContain("permissions");
  expect(names).toContain("memory");
  expect(names).toContain("tasks");
  expect(names).toContain("task");
  expect(names).toContain("team");
  expect(names).toContain("commands");

  const team = BUILTIN_COMMANDS.find((command) => command.name === "team");
  expect(team?.subCommands.map((command) => command.name)).toEqual([
    "status",
    "tasks",
    "members",
    "messages",
    "run",
    "merge",
  ]);
});

test("resolve finds nested subcommands with canonical invocation", () => {
  const result = resolveCommand(createBuiltinCommandRegistry(), "/team run");

  expect(result.status).toBe("matched");
  if (result.status !== "matched") return;

  expect(result.command.name).toBe("run");
  expect(result.path).toEqual(["team", "run"]);
  expect(result.invocation).toBe("/team run");
  expect(result.args.raw).toBe("");
});

test("builtin action stubs preserve the canonical command path", async () => {
  const registry = createBuiltinCommandRegistry();
  const teamRun = resolveCommand(registry, "/team run");
  const memoryReload = resolveCommand(registry, "/memory reload");
  const commandsReload = resolveCommand(registry, "/commands reload");

  expect(teamRun.status).toBe("matched");
  expect(memoryReload.status).toBe("matched");
  expect(commandsReload.status).toBe("matched");
  if (teamRun.status !== "matched" || memoryReload.status !== "matched" || commandsReload.status !== "matched") {
    return;
  }

  const teamRunResult = await teamRun.command.run({}, teamRun.args);
  const memoryReloadResult = await memoryReload.command.run({}, memoryReload.args);
  const commandsReloadResult = await commandsReload.command.run({}, commandsReload.args);

  expect(teamRunResult).toMatchObject({
    type: "action",
    action: "team_run",
    message: expect.stringContaining("/team run"),
  });
  expect(memoryReloadResult).toMatchObject({
    type: "action",
    action: "memory_reload",
    message: expect.stringContaining("/memory reload"),
  });
  expect(commandsReloadResult).toMatchObject({
    type: "action",
    action: "commands_reload",
    message: expect.stringContaining("/commands reload"),
  });
});

test("resolve supports aliases", () => {
  const result = resolveCommand(createBuiltinCommandRegistry(), "/mem show");

  expect(result.status).toBe("matched");
  if (result.status !== "matched") return;

  expect(result.command.name).toBe("show");
  expect(result.path).toEqual(["memory", "show"]);
});

test("unknown nested builtin commands do not resolve to the parent group", () => {
  const registry = createBuiltinCommandRegistry();

  expect(resolveCommand(registry, "/team nope").status).toBe("unknown");
  expect(resolveCommand(registry, "/memory nope").status).toBe("unknown");
  expect(resolveCommand(registry, "/commands nope").status).toBe("unknown");
});

test("resolve reports ambiguous matches when a flat command set conflicts", () => {
  const left = defineCommand({
    name: "review",
    category: "test",
    description: "Review one",
    source: "project",
    type: "prompt",
  });
  const right = defineCommand({
    name: "review",
    category: "test",
    description: "Review two",
    source: "user",
    type: "prompt",
  });

  const result = resolveCommand([left, right], "/review");

  expect(result.status).toBe("ambiguous");
  if (result.status !== "ambiguous") return;
  expect(result.candidates).toHaveLength(2);
});

test("hidden commands are omitted from completion by default", () => {
  const hidden = defineCommand({
    name: "secret",
    category: "debug",
    description: "Hidden command",
    source: "builtin",
    type: "local",
    hidden: true,
  });
  const visible = defineCommand({
    name: "show",
    category: "debug",
    description: "Visible command",
    source: "builtin",
    type: "local",
  });

  const completions = completeCommands([hidden, visible], {}, "/");

  expect(completions.map((completion) => completion.value)).toEqual(["/show"]);
});

test("completion supports nested subcommands", () => {
  const completions = completeCommands(createBuiltinCommandRegistry(), {}, "/team r");

  expect(completions.map((completion) => completion.value)).toContain("/team run");
});
