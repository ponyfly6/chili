import { executeCodeMode } from "../../packages/tools/src/code-mode/runtime.js";
import { validateToolSchema } from "../../packages/tools/src/input-schema.js";
import { PROCESS_GUARDIAN_MODE, runProcess, runProcessGuardianEntrypoint } from "../../packages/tools/src/process.js";
import type { ChiliToolDefinition } from "../../packages/tools/src/types.js";

if (process.argv[2] === PROCESS_GUARDIAN_MODE) {
  runProcessGuardianEntrypoint();
} else {
  await smoke();
}

async function smoke(): Promise<void> {
  const result = await executeCodeMode({
    code: 'const a = await tools.echo({value: 20}); const b = await tools.echo({value: a.value + 22}); text(b.value); text([typeof process, typeof Bun, typeof fetch]);',
    tools: [{ name: "echo", description: "Fake tool" }],
    invokeTool: async (_name, input) => input,
  });
  if (!result.ok || result.output !== '42\n["undefined","undefined","undefined"]') {
    throw new Error(`Compiled code mode failed: ${JSON.stringify(result)}`);
  }
  const timed = await executeCodeMode({
    code: "while (true) await null;",
    tools: [],
    invokeTool: async () => undefined,
    timeoutMs: 150,
  });
  if (timed.error?.kind !== "timeout") throw new Error(`Compiled timeout failed: ${JSON.stringify(timed)}`);
  const external: ChiliToolDefinition = {
    name: "external", description: "MCP-style input", risk: "read", inputSchemaSource: "external",
    inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["count"], properties: { count: { type: "integer" } } },
    execute: async () => ({ title: "external", output: "" }),
  };
  await validateToolSchema(external, { count: 1 });
  let rejected = false;
  try { await validateToolSchema(external, { count: "wrong" }); } catch { rejected = true; }
  if (!rejected) throw new Error("Compiled external schema validation accepted invalid input");
  if (process.platform !== "win32") {
    const guarded = await executeCodeMode({
      code: 'const result = await tools.command(); text(result.stdout);',
      tools: [{ name: "command", description: "Compiled process guardian fixture" }],
      invokeTool: (_name, _input, signal) => runProcess("/bin/echo", ["GUARDIAN_OK"], { cwd: process.cwd(), signal }),
    });
    if (!guarded.ok || guarded.output !== "GUARDIAN_OK\n") {
      throw new Error(`Compiled code mode guardian failed: ${JSON.stringify(guarded)}`);
    }
  }
  console.log("CODE_MODE_COMPILED_OK");
}
