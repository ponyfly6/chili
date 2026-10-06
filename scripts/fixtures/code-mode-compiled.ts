import { executeCodeMode } from "../../packages/tools/src/code-mode/runtime.js";
import { validateToolSchema } from "../../packages/tools/src/input-schema.js";
import type { ChiliToolDefinition } from "../../packages/tools/src/types.js";

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
console.log("CODE_MODE_COMPILED_OK");
