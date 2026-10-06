import { expect, test } from "bun:test";
import { CODE_MODE_LIMITS, executeCodeMode } from "./runtime.js";
import type { CodeModeOptions } from "./runtime.js";

function run(code: string, rest: Partial<Omit<CodeModeOptions, "code">> = {}) {
  return executeCodeMode({ code, tools: [], invokeTool: async () => undefined, ...rest });
}

test("code mode chains JSON results and only publishes explicit text", async () => {
  const seen: unknown[] = [];
  const result = await run('const a = await tools.echo({value: 2}); const b = await tools["echo"]({value: a.value + 3}); text(b); return "hidden";', {
    tools: [{ name: "echo", description: "Echo input" }],
    invokeTool: async (_name, input) => { seen.push(input); return input; },
  });
  expect(result.ok).toBe(true);
  expect(result.output).toBe('{"value":5}');
  expect(seen).toEqual([{ value: 2 }, { value: 5 }]);
  expect(result.calls.map((call) => call.status)).toEqual(["ok", "ok"]);
});

test("code mode runs independent calls concurrently with a bounded queue", async () => {
  let active = 0;
  let maximum = 0;
  const result = await run('text(await Promise.all(Array.from({length: 16}, (_, n) => tools.echo(n))));', {
    tools: [{ name: "echo", description: "" }],
    invokeTool: async (_name, input) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return input;
    },
  });
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.output)).toEqual(Array.from({ length: 16 }, (_, n) => n));
  expect(maximum).toBe(CODE_MODE_LIMITS.concurrency);
  expect(active).toBe(0);
});

test("code mode has no host globals, import capability, or persistent JS state", async () => {
  const first = await run(`
    globalThis.shared = 1;
    let imported = false;
    try { await import("node:fs"); imported = true; } catch {}
    text([typeof process, typeof require, typeof fetch, typeof setTimeout, typeof WebAssembly, typeof Bun, imported, tools.constructor]);
    text(new Function("return typeof process")());
  `);
  expect(first.ok).toBe(true);
  expect(first.output).toBe('["undefined","undefined","undefined","undefined","undefined","undefined",false,null]\nundefined');
  expect((await run('text(typeof shared)')).output).toBe("undefined");
});

test("code mode tool errors are catchable and script failures retain partial output and line numbers", async () => {
  const caught = await run('try { await tools.fail({}); } catch (error) { text(error.message); }', {
    tools: [{ name: "fail", description: "" }],
    invokeTool: async () => { throw new Error("permission denied"); },
  });
  expect(caught.ok).toBe(true);
  expect(caught.output).toBe("permission denied");
  expect(caught.calls[0]?.status).toBe("error");
  const failed = await run('text("before");\nthrow new Error("boom");');
  expect(failed.ok).toBe(false);
  expect(failed.output).toBe("before");
  expect(failed.error?.kind).toBe("script");
  expect(failed.error?.message).toContain("code-mode.js:2");
  expect((await run("const a = 1;\nconst = 2;")).error?.message).toContain("code-mode.js:2");
});

test("code mode rejects promises that cannot settle", async () => {
  const result = await run("await new Promise(() => {});");
  expect(result.error?.kind).toBe("script");
  expect(result.error?.message).toContain("cannot settle");
});

test("code mode interrupts synchronous and microtask infinite loops on Bun", async () => {
  for (const code of ["while (true) {}", "while (true) await null;"]) {
    const start = performance.now();
    const result = await run(code, { timeoutMs: 150 });
    expect(result.error?.kind).toBe("timeout");
    expect(performance.now() - start).toBeLessThan(3000);
  }
  expect((await run("text(42)")).output).toBe("42");
});

test("code mode aborts running calls and never starts queued calls after early return", async () => {
  const signals: AbortSignal[] = [];
  const result = await run('for (let n = 0; n < 16; n++) tools.hang(n); text("done");', {
    tools: [{ name: "hang", description: "" }],
    invokeTool: async (_name, _input, signal) => {
      signals.push(signal);
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
  });
  expect(result.ok).toBe(true);
  expect(result.output).toBe("done");
  expect(signals).toHaveLength(CODE_MODE_LIMITS.concurrency);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(result.calls).toHaveLength(16);
  expect(result.calls.every((call) => call.status === "cancelled")).toBe(true);
});

test("code mode user abort does not wait forever for a noncooperative host promise", async () => {
  const controller = new AbortController();
  let nestedSignal: AbortSignal | undefined;
  const result = await run("await tools.hang();", {
    tools: [{ name: "hang", description: "" }],
    signal: controller.signal,
    invokeTool: (_name, _input, signal) => {
      nestedSignal = signal;
      controller.abort();
      return new Promise(() => {});
    },
  });
  expect(result.error?.kind).toBe("aborted");
  expect(nestedSignal?.aborted).toBe(true);
  expect(result.calls[0]?.status).toBe("cancellation_requested");
  expect(result.error?.message).toContain("termination is unconfirmed");
});

test("code mode fails rather than claiming success when early-return cleanup is unconfirmed", async () => {
  const result = await run("tools.hang(); text('early');", {
    tools: [{ name: "hang", description: "" }],
    invokeTool: () => new Promise(() => {}),
  });
  expect(result.ok).toBe(false);
  expect(result.error?.kind).toBe("cleanup");
  expect(result.calls[0]?.status).toBe("cancellation_requested");
});

test("code mode rejects a pre-aborted signal without invoking tools", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const result = await run("text(1)", { signal: controller.signal, invokeTool: async () => { called = true; } });
  expect(result.error?.kind).toBe("aborted");
  expect(called).toBe(false);
});

test("code mode user cancellation interrupts a CPU-bound VM", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const result = await run("while (true) {}", { signal: controller.signal });
    expect(result.error?.kind).toBe("aborted");
  } finally {
    clearTimeout(timer);
  }
});

test("code mode enforces script, argument, result, output and call-count budgets", async () => {
  const tools = [{ name: "echo", description: "" }];
  let calls = 0;
  const invokeTool = async (_name: string, input: unknown) => { calls++; return input; };
  expect((await run(" ".repeat(CODE_MODE_LIMITS.scriptBytes) + "text(1)")).error?.kind).toBe("limit");
  expect((await run('await tools.echo("中".repeat(100000));', { tools, invokeTool })).error?.kind).toBe("limit");
  expect(calls).toBe(0);
  const oversizedResult = await run("await tools.echo();", { tools, invokeTool: async () => "x".repeat(CODE_MODE_LIMITS.resultBytes) });
  expect(oversizedResult.error?.kind).toBe("limit");
  const output = await run('text("before"); text("中".repeat(100000));');
  expect(output.error?.kind).toBe("limit");
  expect(output.output).toBe("before");
  const flooding = await run('for (let n = 0; n < 2000; n++) text("");');
  expect(flooding.error?.kind).toBe("limit");
  expect(flooding.error?.message).toContain("text items");
  const tooMany = await run("for (let n=0; n<100; n++) await tools.echo(n);", { tools, invokeTool });
  expect(tooMany.error?.kind).toBe("limit");
  expect(calls).toBe(CODE_MODE_LIMITS.calls);
});

test("code mode enforces a catchable QuickJS heap limit", async () => {
  const result = await run('let a = []; try { while (true) a.push("x".repeat(1024 * 1024) + a.length); } catch (error) { const message = String(error); a = null; text(message); }', { timeoutMs: 3000 });
  expect(result.ok).toBe(true);
  expect(result.output).toContain("out of memory");
});

test("code mode preserves exact tool names and freezes its capability objects", async () => {
  const result = await run('try { tools["my-tool"] = () => 9; } catch {} try { ALL_TOOLS.push({name:"evil"}); } catch {} text(await tools["my-tool"]()); text(await tools.my_tool()); text(ALL_TOOLS.length);', {
    tools: [{ name: "my-tool", description: "one" }, { name: "my_tool", description: "two" }],
    invokeTool: async (name) => name,
  });
  expect(result.output).toBe("my-tool\nmy_tool\n2");
});
