# Code mode in Chili

Chili exposes `code_mode` alongside its direct tools in CLI, TUI, and Desktop hosts.
It is a baseline tool for both the main agent and every child agent, including
scoped Team workers and resumed workers with older allowlists. They all use the
same implementation; each agent receives its own authorized tool catalog.
The model supplies `{ "code": "...", "timeoutMs": 30000 }`. JavaScript runs once in
an isolated QuickJS worker. It can compose the explicitly enabled tools; it cannot
access Node, Bun, files, network, imports, or timers directly.

```js
const paths = ["package.json", "packages/tools/package.json"];
const results = await Promise.all(paths.map(async (filePath) => {
  const result = await tools.read({ filePath });
  if (!result.structuredData || result.structuredData.truncated) {
    throw new Error("A complete file read is required");
  }
  const manifest = JSON.parse(result.structuredData.content);
  return { filePath, name: manifest.name, scripts: manifest.scripts ?? {} };
}));
text(results);
```

`text(value)` is the only script output sent back to the model. A returned value
is not printed. `tools[name](input)` always resolves to a `ToolResult` envelope:
`output` is display text, `structuredData` is optional machine data, and `metadata`
may describe output truncation. A missing machine value does not imply an empty
successful result. Check the tool's own `truncated` fields before making decisions
from partial data. Machine data must be strict JSON, with at most 4 MiB of encoded
data and bounded structural depth. Invalid or oversized machine data fails the
tool call; it is never silently replaced with a preview. The entire result
envelope must also fit the narrower 1 MiB script bridge budget.

`ALL_TOOLS` lists the callable names and descriptions. Use `tool_search` with a
capability query or `select:read,bash` to inspect parameter and result schemas.
This catalog includes authorized deferred tools even when their direct definitions
have not been loaded. It contains short descriptions, not parameter declarations.
Inside a script, `await tools.tool_search({ query: "select:exact-name" })` returns
complete contracts in `.structuredData.tools` without loading direct definitions.
Pass `load: true` only when subsequent direct model calls need those definitions.
Knowing a tool's contract is sufficient for a script call; search is not an
execution prerequisite. Direct `tool_search` calls load definitions for the next
model request, with the selection recorded durably for that session.
Names are preserved exactly, including MCP punctuation: use `tools["exact-name"]`.
Tool search describes the schema of `.structuredData`, not the outer envelope.
TypeScript syntax is not accepted; schemas describe the JavaScript contract.

File tools, shell and managed-process tools, Git tools, the six `agent_*` controls,
and ordinary MCP tools opt in to code mode. Image reads, user input, and Team
controls remain direct calls. Explicit denials of `code_mode` are still respected;
each nested tool retains its own allowlist, scope and approval checks.
The wrapper declares an internal resource policy because it has no direct file
or process capability. This permits composition under resource restrictions;
it does not grant its children additional access.

## Execution and lifecycle

- A turn shares one effect scheduler and tool-call budget across direct and
  nested calls. Declared concurrency-safe calls can overlap; other effects run
  exclusively. A script wrapper never holds its children's execution permit.
- Inputs are validated, and policy and catalog validity are checked again after
  waiting. External MCP schemas are validated in a terminable worker so a slow
  pattern cannot block the host event loop.
- Every dispatched child has its own call ID, approval and terminal event,
  linked to the parent script by `parentCallId`. TUI groups these calls; replay
  retains their relationship. Intermediate child outputs are not added to model
  messages; normal bounded tool-output audit and persistence still apply.
- Await all tool calls. Returning or throwing cancels queued work and requests
  cancellation of active children. A child that has not settled within cleanup
  grace is reported as unconfirmed termination, not successful cancellation.
- A script failure does not undo a completed write. Inspect child calls before
  retrying; do not automatically replay a failed script. Infrastructure audit
  failures and turn-budget exhaustion cannot be bypassed with JavaScript catch.
- Explicit `bash({ background: true, ... })` retains the existing managed-process
  lifecycle and returns a handle. This is separate from an unawaited JS promise.

## Limits

| Resource | Limit |
| --- | --- |
| Script execution | 30 seconds by default; `timeoutMs` up to 120 seconds |
| QuickJS heap | 64 MiB |
| Script / tool arguments | 64 KiB / 256 KiB |
| Tool `structuredData` | Strict JSON, at most 4 MiB; invalid or larger values fail |
| Tool result crossing the JS bridge | 1 MiB, including its envelope |
| Explicit output | 256 KiB and 1,024 output items |
| Calls per script | 64 |
| Concurrent host requests per script | 8, additionally constrained by the turn scheduler |
| Catalog metadata | 256 KiB |

The execution deadline includes tool and approval waits. Use a direct call for a
long-running operation, or the explicit managed-process interface where suitable.
Each execution has a fresh heap. This version has no persistent REPL, `store/load`,
or background script cells with `yield/wait`.

Cleanup waits up to 100 ms after requesting cancellation. A process guardian may
need longer to reap an active command, so the script can report unconfirmed
termination while its child continues cleanup. Child terminal events and execution
permits follow actual completion, rather than the wrapper's earlier return.

## Development

The runtime lives in `packages/tools/src/code-mode`; the builtin adapter delegates
to the executor's trusted `context.invokeTool`. Tool implementations must not be
called directly from the sandbox bridge. Opt in with `codeMode: true`, provide an
`outputSchema` describing `structuredData`, and declare concurrency safety
conservatively. `inputSchemaSource: "external"` selects isolated schema validation.

Desktop's sidecar build includes both worker entrypoints and the QuickJS WASM
asset. `bun run smoke:code-mode` builds and runs a standalone executable from an
empty temporary directory; the check is included in `smoke:all`.

Focused coverage includes sandbox isolation, CPU and microtask loops, memory and
output limits, cancellation and cleanup, nested approvals, dynamic catalog
withdrawal, audit failures, shared budgets, structured results, and replay.
