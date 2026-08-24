import { expect, test } from "bun:test";
import { commandMenuModel, completeCommands, completeCommandsSync } from "./menu.js";
import { createCommandRegistry, defineCommand } from "./registry.js";

function menuRegistry() {
  return createCommandRegistry([
    defineCommand({
      id: "builtin.help",
      name: "help",
      title: "Help",
      description: "Browse every command",
      group: "general",
      source: "builtin",
      executionTarget: "client",
    }),
    defineCommand({
      id: "builtin.model",
      name: "model",
      title: "Model",
      description: "Configure the active provider and model",
      group: "model",
      source: "builtin",
      executionTarget: "client",
      children: [
        {
          id: "builtin.model.select",
          name: "select",
          title: "Select model",
          description: "Choose provider/model",
          group: "model",
          source: "builtin",
          argumentMode: "required",
          argumentHint: "<provider/model>",
          selectionMode: "complete",
          executionTarget: "client",
          complete: async (_context, input) => [
            {
              id: "model.openai.gpt-5",
              value: `${input.invocation} openai/gpt-5`,
              label: "openai/gpt-5",
              description: "OpenAI GPT-5",
              group: "model",
              source: "builtin",
              argumentHint: "",
              hidden: false,
              enabled: true,
              intent: "execute",
            },
          ],
        },
        {
          id: "builtin.model.service",
          name: "service",
          title: "Service tier",
          description: "Choose standard or fast service",
          group: "model",
          source: "builtin",
          executionTarget: "client",
        },
      ],
    }),
    defineCommand({
      id: "builtin.commands",
      name: "commands",
      title: "Commands",
      description: "Reload or inspect command diagnostics",
      group: "system",
      source: "builtin",
      executionTarget: "client",
    }),
  ]);
}

test("strong prefix matches suppress unrelated fuzzy results", async () => {
  const completions = await completeCommands(menuRegistry(), {}, "/mo");

  expect(completions.map((item) => item.value)).toEqual(["/model"]);
});

test("fuzzy matching is a fallback when no exact or prefix result exists", async () => {
  const completions = await completeCommands(menuRegistry(), {}, "/mdl");

  expect(completions.map((item) => item.value)).toEqual(["/model"]);
});

test("trailing space descends into contextual children", async () => {
  const completions = await completeCommands(menuRegistry(), {}, "/model ");

  expect(completions.map((item) => [item.value, item.intent])).toEqual([
    ["/model select", "complete"],
    ["/model service", "execute"],
  ]);
});

test("argument completion may be asynchronous and stays in the shared model", async () => {
  const completions = await completeCommands(menuRegistry(), {}, "/model select ");

  expect(completions.map((item) => item.value)).toEqual(["/model select openai/gpt-5"]);
});

test("synchronous clients use the same menu model and skip asynchronous providers", () => {
  expect(completeCommandsSync(menuRegistry(), {}, "/model ").map((item) => item.value)).toEqual([
    "/model select",
    "/model service",
  ]);
  expect(completeCommandsSync(menuRegistry(), {}, "/model select ")).toEqual([]);
});

test("empty menu preserves semantic group and catalog order", async () => {
  const model = await commandMenuModel(menuRegistry(), {}, "/");

  expect(model.groups.map((group) => [group.id, group.items.map((item) => item.value)])).toEqual([
    ["general", ["/help"]],
    ["model", ["/model"]],
    ["system", ["/commands"]],
  ]);
  expect(model.total).toBe(3);
});

test("global palette searches descriptions as well as command paths", async () => {
  const model = await commandMenuModel(menuRegistry(), {}, "provider", { scope: "global" });

  expect(model.items.map((item) => item.value)).toEqual(["/model", "/model select"]);
});
