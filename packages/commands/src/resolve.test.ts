import { expect, test } from "bun:test";
import { createCommandRegistry, defineCommand } from "./registry.js";
import { parseCommandInput, resolveCommand } from "./resolve.js";
import type { CommandContext } from "./types.js";

interface TestContext extends CommandContext {
  busy: boolean;
}

function commandTree() {
  return createCommandRegistry<TestContext, string>([
    defineCommand<TestContext, string>({
      id: "builtin.model",
      name: "model",
      title: "Model",
      description: "Configure model",
      group: "model",
      source: "builtin",
      executionTarget: "client",
      children: [
        {
          id: "builtin.model.select",
          name: "select",
          title: "Select model",
          description: "Select provider/model",
          group: "model",
          source: "builtin",
          argumentMode: "required",
          argumentHint: "<provider/model>",
          executionTarget: "client",
          run: (_context, input) => input.raw,
        },
      ],
    }),
    defineCommand<TestContext, string>({
      id: "builtin.session",
      name: "session",
      title: "Session",
      description: "Manage sessions",
      group: "session",
      source: "builtin",
      executionTarget: "client",
      children: [
        {
          id: "builtin.session.new",
          name: "new",
          title: "New session",
          description: "Start fresh",
          group: "session",
          source: "builtin",
          concurrency: "deny",
          executionTarget: "client",
          available: (context) => context.busy
            ? { enabled: false, reason: "Active turn is still running." }
            : { enabled: true },
          run: () => "new",
        },
      ],
    }),
  ]);
}

test("resolver traverses exact nodes and preserves raw arguments", () => {
  const result = resolveCommand(commandTree(), { busy: false }, "/model select OpenAI/GPT-5  high");

  expect(result.status).toBe("matched");
  if (result.status !== "matched") return;
  expect(result.command.id).toBe("builtin.model.select");
  expect(result.invocation).toBe("/model select");
  expect(result.args.raw).toBe("OpenAI/GPT-5  high");
  expect(result.args.argv).toEqual(["OpenAI/GPT-5", "high"]);
});

test("resolver reports incomplete parents and missing required arguments", () => {
  const parent = resolveCommand(commandTree(), { busy: false }, "/model");
  const leaf = resolveCommand(commandTree(), { busy: false }, "/model select");

  expect(parent).toMatchObject({
    status: "incomplete",
    path: "/model",
    reason: "children_required",
  });
  expect(leaf).toMatchObject({
    status: "incomplete",
    path: "/model select",
    reason: "arguments_required",
    usage: "/model select <provider/model>",
  });
});

test("resolver never executes prefixes or fuzzy matches", () => {
  expect(resolveCommand(commandTree(), { busy: false }, "/mo")).toMatchObject({
    status: "unknown",
    token: "mo",
    suggestions: ["/model"],
  });
  expect(resolveCommand(commandTree(), { busy: false }, "/modle")).toMatchObject({
    status: "unknown",
    token: "modle",
    suggestions: ["/model"],
  });
});

test("resolver preserves unmistakable absolute paths as ordinary prompts", () => {
  expect(resolveCommand(commandTree(), { busy: false }, "/Users/pony/src/index.ts explain this")).toEqual({
    status: "not_command",
    input: "/Users/pony/src/index.ts explain this",
  });
  expect(resolveCommand(commandTree(), { busy: false }, "/tmp explain this")).toEqual({
    status: "not_command",
    input: "/tmp explain this",
  });
  expect(resolveCommand(commandTree(), { busy: false }, "C:\\src\\index.ts explain this")).toEqual({
    status: "not_command",
    input: "C:\\src\\index.ts explain this",
  });
});

test("resolver returns disabled state before exposing a runnable match", () => {
  expect(resolveCommand(commandTree(), { busy: true }, "/session new")).toMatchObject({
    status: "disabled",
    path: "/session new",
    reason: "Active turn is still running.",
  });
});

test("parser retains token offsets and trailing space", () => {
  expect(parseCommandInput("  /model   select  gpt ")).toMatchObject({
    body: "model   select  gpt ",
    hasTrailingSpace: true,
    tokens: [
      { value: "model", normalized: "model", start: 0, end: 5 },
      { value: "select", normalized: "select", start: 8, end: 14 },
      { value: "gpt", normalized: "gpt", start: 16, end: 19 },
    ],
  });
});
