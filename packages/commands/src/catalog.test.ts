import { expect, test } from "bun:test";
import { BUILTIN_COMMAND_IDS, bindBuiltinCommands } from "./catalog.js";
import { collectCommandNodes } from "./resolve.js";

const EXPECTED_PATHS = [
  "/help",
  "/status",
  "/theme",
  "/permissions",
  "/model",
  "/model select",
  "/model service",
  "/thinking",
  "/thinking effort",
  "/thinking traces",
  "/rename",
  "/session",
  "/session new",
  "/session list",
  "/session resume",
  "/session rename",
  "/session compact",
  "/session revert",
  "/session delegation",
  "/goal",
  "/goal show",
  "/goal set",
  "/goal pause",
  "/goal resume",
  "/goal clear",
  "/agents",
  "/agents list",
  "/agents stop",
  "/agents resume",
  "/memory",
  "/memory show",
  "/memory add",
  "/memory reload",
  "/auth",
  "/auth status",
  "/auth login",
  "/auth logout",
  "/skills",
  "/skills browse",
  "/skills enable",
  "/skills disable",
  "/skills reload",
  "/mcp",
  "/mcp status",
  "/mcp tools",
  "/mcp reload",
  "/mcp add",
  "/mcp remove",
  "/mcp auth",
  "/mcp logout",
  "/commands",
  "/commands reload",
  "/commands diagnostics",
  "/app",
  "/app exit",
] as const;

test("canonical catalog exposes only the breaking command vocabulary", () => {
  const bindings = Object.fromEntries(
    BUILTIN_COMMAND_IDS.map((id) => [id, { run: () => id }]),
  );
  const commands = bindBuiltinCommands(bindings);
  const nodes = collectCommandNodes(commands);

  expect(nodes.map((command) => command.path)).toEqual([...EXPECTED_PATHS]);
  expect(nodes.map((command) => command.id)).toEqual([...BUILTIN_COMMAND_IDS]);

  const paths = new Set(nodes.map((command) => command.path));
  for (const removed of [
    "/clear",
    "/new",
    "/sessions",
    "/resume",
    "/compact",
    "/revert",
    "/team",
    "/login",
    "/logout",
    "/reasoning",
    "/fast",
    "/init",
    "/exit",
  ]) {
    expect(paths.has(removed)).toBe(false);
  }
  expect(JSON.stringify(commands)).not.toContain("aliases");
});

test("catalog carries interaction and concurrency semantics", () => {
  const commands = bindBuiltinCommands({
    "model.select": { run: () => "select" },
    "session.new": { run: () => "new" },
    "thinking.traces": { run: () => "traces" },
    "thinking.effort": { run: () => "effort" },
    "session.delegation": { run: () => "delegation" },
  });
  const nodes = collectCommandNodes(commands);

  expect(nodes.find((command) => command.id === "model.select")).toMatchObject({
    path: "/model select",
    argumentMode: "required",
    argumentHint: "<provider/model>",
    selectionMode: "complete",
  });
  expect(nodes.find((command) => command.id === "session.new")).toMatchObject({
    concurrency: "deny",
    selectionMode: "execute",
  });
  expect(nodes.find((command) => command.id === "thinking.traces")).toMatchObject({
    argumentMode: "required",
    argumentHint: "<show|hide>",
  });
  expect(nodes.find((command) => command.id === "thinking.effort")).toMatchObject({
    argumentMode: "required",
    argumentHint: "<off|minimal|low|medium|high|xhigh|max|ultra>",
  });
  expect(nodes.find((command) => command.id === "session.delegation")).toMatchObject({
    path: "/session delegation",
    argumentMode: "optional",
    argumentHint: "[off|explicit|proactive|status]",
    selectionMode: "complete",
  });
});

test("unbound leaves and now-empty parents are omitted for a surface", () => {
  const commands = bindBuiltinCommands({
    help: { run: () => "help" },
    "agents.stop": { run: () => "stop" },
  });

  expect(collectCommandNodes(commands).map((command) => command.path)).toEqual([
    "/help",
    "/agents",
    "/agents stop",
  ]);
});
