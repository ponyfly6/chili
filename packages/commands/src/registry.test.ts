import { expect, test } from "bun:test";
import { completeCommands } from "./completion.js";
import { defineCommand } from "./registry.js";
import { resolveCommand } from "./resolve.js";

test("resolve matches multi-token prompt commands with arguments", () => {
  const command = defineCommand({
    name: "review security",
    category: "project",
    description: "Review security",
    source: "project",
  });

  const result = resolveCommand([command], "/review security src/auth.ts");

  expect(result.status).toBe("matched");
  if (result.status !== "matched") return;
  expect(result.path).toEqual(["review", "security"]);
  expect(result.invocation).toBe("/review security");
  expect(result.args.raw).toBe("src/auth.ts");
});

test("resolve reports ambiguous matches when a flat command set conflicts", () => {
  const left = defineCommand({
    name: "review",
    category: "test",
    description: "Review one",
    source: "project",
  });
  const right = defineCommand({
    name: "review",
    category: "test",
    description: "Review two",
    source: "user",
  });

  const result = resolveCommand([left, right], "/review");

  expect(result.status).toBe("ambiguous");
  if (result.status !== "ambiguous") return;
  expect(result.candidates).toHaveLength(2);
});

test("hidden commands are omitted from completion by default", () => {
  const hidden = defineCommand({
    name: "secret",
    category: "project",
    description: "Hidden command",
    source: "project",
    hidden: true,
  });
  const visible = defineCommand({
    name: "show",
    category: "project",
    description: "Visible command",
    source: "project",
  });

  const completions = completeCommands([hidden, visible], {}, "/");

  expect(completions.map((completion) => completion.value)).toEqual(["/show"]);
});

test("completion supports multi-token commands", () => {
  const command = defineCommand({
    name: "review security",
    category: "project",
    description: "Review security",
    source: "project",
  });

  const completions = completeCommands([command], {}, "/review s");

  expect(completions.map((completion) => completion.value)).toEqual(["/review security"]);
});

test("completion stops suggesting the command after a full invocation and space", () => {
  const command = defineCommand({
    name: "review security",
    category: "project",
    description: "Review security",
    source: "project",
  });

  const completions = completeCommands([command], {}, "/review security ");

  expect(completions).toEqual([]);
});
