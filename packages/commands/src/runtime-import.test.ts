import { expect, test } from "bun:test";
import type { RuntimeCommandCatalog } from "@chili/protocol";
import { createCommandRegistry } from "./registry.js";
import { importRuntimeCommandCatalog } from "./runtime-import.js";
import { resolveCommand } from "./resolve.js";

test("runtime catalog import preserves identity and proxies executable leaves", async () => {
  const calls: unknown[] = [];
  const catalog: RuntimeCommandCatalog = {
    roots: [{
      id: "prompt",
      name: "prompt",
      path: "/prompt",
      title: "Prompts",
      description: "Run prompts",
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
  const registry = createCommandRegistry(importRuntimeCommandCatalog(catalog, (node, _context, input) => {
    calls.push({ id: node.id, raw: input.raw });
    return node.id;
  }));
  const resolved = resolveCommand(registry, {}, "/prompt review src/index.ts");

  expect(resolved.status).toBe("matched");
  if (resolved.status !== "matched" || !resolved.command.run) return;
  expect(await resolved.command.run({}, resolved.args)).toBe("prompt.project.review");
  expect(calls).toEqual([{ id: "prompt.project.review", raw: "src/index.ts" }]);
});

test("runtime disabled state remains visible and blocks resolution", () => {
  const catalog: RuntimeCommandCatalog = {
    roots: [{
      id: "prompt.user.secret",
      name: "secret",
      path: "/secret",
      title: "Secret",
      description: "Unavailable prompt",
      group: "prompt",
      source: "user",
      argumentMode: "none",
      argumentHint: "",
      selectionMode: "execute",
      concurrency: "allow",
      hidden: false,
      enabled: false,
      disabledReason: "Prompt source failed to load.",
      executionTarget: "prompt",
      children: [],
    }],
    diagnostics: [],
  };
  const registry = createCommandRegistry(importRuntimeCommandCatalog(catalog, () => "never"));

  expect(resolveCommand(registry, {}, "/secret")).toMatchObject({
    status: "disabled",
    reason: "Prompt source failed to load.",
  });
});
