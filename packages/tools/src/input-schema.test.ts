import { expect, test } from "bun:test";
import type { SessionId, TurnId } from "@chili/protocol";
import { ToolExecutor } from "./executor.js";
import { validateToolSchema } from "./input-schema.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ChiliToolDefinition } from "./types.js";

const definition = (inputSchema: unknown): ChiliToolDefinition => ({
  name: "schema", description: "schema", risk: "read", inputSchema,
  execute: async () => ({ title: "schema", output: "" }),
});

for (const source of ["builtin", "external"] as const) {
  const tool = (schema: unknown): ChiliToolDefinition => ({
    ...definition(schema),
    ...(source === "external" ? { inputSchemaSource: source } : {}),
  });
  test(`${source} tool schemas support current MCP dialects and isolate reused schema IDs`, async () => {
    for (const dialect of ["https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2019-09/schema", "http://json-schema.org/draft-07/schema#"]) {
      const schema = { $schema: dialect, $id: "https://tools.example/input", type: "object", properties: { value: { type: "string" } }, required: ["value"] };
      await expect(validateToolSchema(tool(schema), { value: "yes" })).resolves.toBeUndefined();
      await expect(validateToolSchema(tool({ ...schema, properties: { value: { type: "integer" } } }), { value: 3 })).resolves.toBeUndefined();
      await expect(validateToolSchema(tool(schema), { value: 3 })).rejects.toThrow("string");
    }
  });

  test(`${source} invalid and unresolved remote schemas fail closed without network resolution`, async () => {
    await expect(validateToolSchema(tool({ $ref: "https://remote.example/missing" }), {})).rejects.toThrow("compiled");
    await expect(validateToolSchema(tool({ type: "invalid-type" }), {})).rejects.toThrow("compiled");
  });

  test(`${source} async schemas are rejected before running the validator`, async () => {
    const schema = { $async: true, type: "object", required: ["requiredValue"] };
    await expect(validateToolSchema(tool(schema), {})).rejects.toThrow("Asynchronous JSON Schema extensions are unsupported");
    await expect(validateToolSchema(tool(schema), { requiredValue: true })).rejects.toThrow("Asynchronous JSON Schema extensions are unsupported");
  });
}

test("ordinary MCP-style tools execute only after external schema validation succeeds", async () => {
  let executions = 0;
  const registry = new InMemoryToolRegistry();
  registry.register({
    name: "mcp__fixture__lookup",
    description: "Look up a fixture value.",
    risk: "read",
    inputSchemaSource: "external",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    approval: () => false,
    async execute() {
      executions++;
      return { title: "fixture", output: "found" };
    },
  });
  const executor = new ToolExecutor({
    registry,
    events: { publish: async () => undefined },
    approvals: { decide: async () => ({ action: "allow_once" }) },
  });
  const context = {
    sessionId: "schema_session" as SessionId,
    turnId: "schema_turn" as TurnId,
    toolName: "mcp__fixture__lookup",
    cwd: process.cwd(),
  };
  expect((await executor.execute({ ...context, input: { query: "valid" } })).status).toBe("completed");
  const invalid = await executor.execute({ ...context, input: { query: 12 } });
  expect(invalid.status).toBe("failed");
  if (invalid.status === "failed") expect(invalid.error.name).toBe("ToolValidationError");
  expect(executions).toBe(1);
});

test("external validation bounds schema and input bytes before starting a worker", async () => {
  await expect(validateToolSchema({
    ...definition({ type: "string", description: "a".repeat(300_000) }), inputSchemaSource: "external",
  }, "value")).rejects.toThrow("schema exceeds");
  await expect(validateToolSchema({
    ...definition({ type: "string" }), inputSchemaSource: "external",
  }, "a".repeat(1_100_000))).rejects.toThrow("input exceeds");
});

test("external regexp validation can be cancelled without blocking the host", async () => {
  const controller = new AbortController();
  let timerRan = false;
  const timer = setTimeout(() => {
    timerRan = true;
    controller.abort(new DOMException("Schema cancelled", "AbortError"));
  }, 50);
  try {
    await expect(validateToolSchema({
      ...definition({ type: "string", pattern: "^(a+)+$" }), inputSchemaSource: "external",
    }, `${"a".repeat(50)}!`, controller.signal)).rejects.toThrow("Schema cancelled");
    expect(timerRan).toBe(true);
  } finally {
    clearTimeout(timer);
  }
  await expect(validateToolSchema({
    ...definition({ type: "string" }), inputSchemaSource: "external",
  }, "after cancellation")).resolves.toBeUndefined();
});

test("external regexp validation has its own deadline when no caller signal exists", async () => {
  const started = performance.now();
  await expect(validateToolSchema({
    ...definition({ type: "string", allOf: Array.from({ length: 24 }, () => ({ not: { pattern: "^(a+)+$" } })) }),
    inputSchemaSource: "external",
  }, `${"a".repeat(50)}!`)).rejects.toThrow("timed out");
  expect(performance.now() - started).toBeLessThan(5_000);
});
