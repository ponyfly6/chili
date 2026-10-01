import { expect, test } from "bun:test";
import { createCommandRegistry, defineCommand, serializeCommandCatalog } from "./registry.js";

test("registry materializes recursive canonical paths from single-token nodes", () => {
  const registry = createCommandRegistry([
    defineCommand({
      id: "builtin.model",
      name: "model",
      title: "Model",
      description: "Configure the active model",
      group: "model",
      source: "builtin",
      selectionMode: "drilldown",
      executionTarget: "client",
      children: [
        {
          id: "builtin.model.select",
          name: "select",
          title: "Select model",
          description: "Choose a provider and model",
          group: "model",
          source: "builtin",
          argumentMode: "required",
          argumentHint: "<provider/model>",
          executionTarget: "client",
        },
      ],
    }),
  ]);

  expect(registry.roots().map((command) => command.path)).toEqual(["/model"]);
  expect(registry.roots()[0]?.children.map((command) => command.path)).toEqual(["/model select"]);
  expect(registry.diagnostics()).toEqual([]);
});

test("registry rejects duplicate siblings and reports both command origins", () => {
  const registry = createCommandRegistry([
    defineCommand({
      id: "builtin.prompt",
      name: "prompt",
      title: "Prompts",
      description: "Run reusable prompts",
      group: "prompt",
      source: "builtin",
      executionTarget: "prompt",
      children: [
        {
          id: "project.review.first",
          name: "review",
          title: "Review",
          description: "First review prompt",
          group: "prompt",
          source: "project",
          executionTarget: "prompt",
          origin: ".chili/commands/review.md",
        },
        {
          id: "project.review.second",
          name: "review",
          title: "Review again",
          description: "Second review prompt",
          group: "prompt",
          source: "project",
          executionTarget: "prompt",
          origin: ".chili/commands/nested/../review.md",
        },
      ],
    }),
  ]);

  expect(registry.roots()[0]?.children.map((command) => command.id)).toEqual(["project.review.first"]);
  expect(registry.diagnostics()).toEqual([
    {
      level: "error",
      code: "duplicate_command_path",
      message: "Rejected project.review.second because /prompt review is already owned by project.review.first.",
      path: "/prompt review",
      commandIds: ["project.review.first", "project.review.second"],
      origins: [".chili/commands/review.md", ".chili/commands/nested/../review.md"],
    },
  ]);
});

test("runtime serialization evaluates availability and removes executable fields", () => {
  const registry = createCommandRegistry([
    defineCommand<{ busy: boolean }, string>({
      id: "builtin.session.new",
      name: "session",
      title: "Session",
      description: "Manage sessions",
      group: "session",
      source: "builtin",
      selectionMode: "drilldown",
      executionTarget: "client",
      children: [
        {
          id: "builtin.session.new.action",
          name: "new",
          title: "New session",
          description: "Start a new session",
          group: "session",
          source: "builtin",
          concurrency: "deny",
          executionTarget: "client",
          available: (context) => context.busy
            ? { enabled: false, reason: "Wait for the active turn to finish." }
            : { enabled: true },
          run: () => "new_session",
        },
      ],
    }),
  ]);

  const catalog = serializeCommandCatalog(registry, { busy: true });
  const leaf = catalog.roots[0]?.children[0];

  expect(leaf).toMatchObject({
    id: "builtin.session.new.action",
    name: "new",
    path: "/session new",
    enabled: false,
    disabledReason: "Wait for the active turn to finish.",
    concurrency: "deny",
  });
  expect(JSON.stringify(catalog)).not.toContain("available");
  expect(JSON.stringify(catalog)).not.toContain("run");
  expect(JSON.stringify(catalog)).not.toContain("aliases");
});

test("hidden commands remain registered but are omitted from visible roots", () => {
  const registry = createCommandRegistry([
    defineCommand({
      id: "builtin.visible",
      name: "visible",
      title: "Visible",
      description: "Visible command",
      group: "general",
      source: "builtin",
      executionTarget: "client",
    }),
    defineCommand({
      id: "builtin.secret",
      name: "secret",
      title: "Secret",
      description: "Hidden command",
      group: "general",
      source: "builtin",
      hidden: true,
      executionTarget: "client",
    }),
  ]);

  expect(registry.roots().map((command) => command.id)).toEqual(["builtin.visible", "builtin.secret"]);
  expect(registry.visibleRoots().map((command) => command.id)).toEqual(["builtin.visible"]);
});
