import { expect, test } from "bun:test";
import type { SessionId, ToolCallId, ToolResult, TurnId } from "@chili/protocol";
import { createCodeModeTool } from "../builtins/code-mode.js";
import type { ChiliToolDefinition, ChiliToolExecutionContext } from "../types.js";
import { CODE_MODE_LIMITS } from "./runtime.js";

function tool(name: string, codeMode?: boolean): ChiliToolDefinition {
  return {
    name,
    description: name,
    risk: "read",
    inputSchema: { type: "object" },
    ...(codeMode === undefined ? {} : { codeMode }),
    execute: async () => ({ title: name, output: "" }),
  };
}

function context(tools: ChiliToolDefinition[], invoke: NonNullable<ChiliToolExecutionContext["invokeTool"]>): ChiliToolExecutionContext {
  return {
    sessionId: "session-code-mode" as SessionId,
    turnId: "turn-code-mode" as TurnId,
    callId: "call-code-mode" as ToolCallId,
    outputArtifactId: "call-code-mode" as ToolCallId,
    signal: new AbortController().signal,
    cwd: process.cwd(),
    metadata: async () => {},
    streamOutput: async () => {},
    registerPersistedOutput: async () => {},
    visibleTools: () => tools,
    invokeTool: invoke,
  };
}

test("code_mode exposes only explicitly eligible non-orchestrator tools", async () => {
  const invoked: string[] = [];
  const ctx = context([
    tool("read", true), tool("write", false), tool("unknown"),
    { ...tool("other_orchestrator", true), isOrchestrator: true },
    { ...createCodeModeTool(), codeMode: true },
  ], async (name) => { invoked.push(name); return { title: name, output: "read data" }; });
  const result = await createCodeModeTool().execute({ code: 'text(ALL_TOOLS.map(t => t.name)); text((await tools.read({})).output);' }, ctx);
  expect(result.output).toBe('["read"]\nread data');
  expect(invoked).toEqual(["read"]);
});

test("code_mode preserves ToolResult envelope and truncation metadata", async () => {
  const results: Record<string, ToolResult> = {
    read: { title: "file", output: "preview", structuredData: { full: "contents" }, metadata: { truncated: true } },
    plain: { title: "plain", output: "display-only result", metadata: { outputTruncated: false } },
  };
  const ctx = context([tool("read", true), tool("plain", true)], async (name) => results[name]!);
  const result = await createCodeModeTool().execute({ code: 'const a = await tools.read({}); const b = await tools.plain({}); text([a.structuredData.full, a.output, a.metadata.truncated, b.output, b.structuredData === undefined]);' }, ctx);
  expect(result.output).toBe('["contents","preview",true,"display-only result",true]');
});

test("code_mode reports partial output and failure without pretending earlier calls were undone", async () => {
  const ctx = context([tool("read", true)], async () => ({ title: "read", output: "x" }));
  await expect(createCodeModeTool().execute({ code: 'await tools.read({}); text("partial"); throw new Error("boom");' }, ctx)).rejects.toThrow("Output before failure:\npartial\nTool calls (earlier effects are not undone): read (ok)");
});

test("code_mode validates bounded input and is an exclusive orchestrator", async () => {
  const builtin = createCodeModeTool();
  expect(builtin.codeMode).toBe(false);
  expect(builtin.isOrchestrator).toBe(true);
  expect(builtin.isConcurrencySafe).toBe(false);
  expect(builtin.resourcePolicy).toBe("internal");
  expect(builtin.resources?.({ code: "text(1)" })).toBe(false);
  for (const input of [null, [], {}, { code: " " }, { code: "text(1)", extra: true }, { code: "text(1)", timeoutMs: 0 }, { code: "text(1)", timeoutMs: CODE_MODE_LIMITS.maxTimeoutMs + 1 }, { code: "中".repeat(CODE_MODE_LIMITS.scriptBytes) }]) {
    expect((await builtin.validate?.(input))?.ok).toBe(false);
  }
  expect((await builtin.validate?.({ code: "text(1)", timeoutMs: 500 }))?.ok).toBe(true);
});
