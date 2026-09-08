export interface CodingEvalTask {
  id: string;
  title: string;
  baseCommit: string;
  referenceCommit: string;
  productionFiles: readonly string[];
  acceptanceFiles: readonly string[];
  acceptanceNamePattern?: string;
  expectedAcceptanceTests: number;
  regressionFiles: readonly string[];
  requirements: string;
}

// Public development fixtures derived from Chili's own Apache-2.0 history.
// Keep this manifest and the reference commits outside the candidate workspace.
export const codingEvalTasks: readonly CodingEvalTask[] = [
  {
    id: "tool-input-preview",
    title: "Preserve streamed tool input through SDK replay and Desktop presentation",
    baseCommit: "88c76bcdfc7e27dd9411a73adfb691a33d05abac",
    referenceCommit: "7a9e49fd66fb1be404c5f1146c899824eba764ac",
    productionFiles: ["packages/sdk/src/replay-window.ts", "apps/desktop/src/renderer/view-model.ts"],
    acceptanceFiles: ["packages/sdk/src/replay-window.test.ts", "apps/desktop/src/renderer/view-model.test.ts"],
    expectedAcceptanceTests: 44,
    regressionFiles: ["packages/sdk/src/replay-window.test.ts", "apps/desktop/src/renderer/view-model.test.ts"],
    requirements: `Users should see a tool's input while the provider is still streaming it, before execution has emitted tool.call_started. A running tool.call_updated carrying a non-empty toolName and a defined input is a complete preview; status-only or incomplete updates cannot establish a tool on their own.

Preserve previews in SDK replay and in the live Desktop timeline. Under bounded retention, retain the latest complete preview with a pre-execution cancellation. Once execution starts, prefer the execution anchor so turn identity survives. A same call ID in another session must not anchor an otherwise orphaned event. Keep exact event-count and UTF-8 byte limits. Desktop warnings must distinguish a missing causal anchor from a capacity overflow; valid previews must not show a false truncation warning. Preserve normal message/tool replay and incremental timeline behavior.`,
  },
  {
    id: "task-cancellation-receipts",
    title: "Settle cancelled child tasks and fence delayed lease acknowledgements",
    baseCommit: "f040e33a3d956a86079632052e7966ad66c5943a",
    referenceCommit: "a9e8e1dcb53f0cf5ff064d2121a19d7464f5ef85",
    productionFiles: ["packages/core/src/subagent.ts", "packages/core/src/task-control.ts"],
    acceptanceFiles: ["packages/core/src/task-admission-soak.test.ts"],
    expectedAcceptanceTests: 5,
    regressionFiles: ["packages/core/src/subagent.test.ts", "packages/core/src/task-control.test.ts"],
    requirements: `Cancelling a child task via the caller's AbortSignal can leave its durable status running after the runner has stopped. Ensure cancellation settles the owning task/run, releases its lease, and drains active/queued work without duplicate runner execution. Preserve pending legacy/team intents during stale-task recovery.

Also handle cancellation while provider-entry lease acknowledgement is pending: the runner must never start after the caller aborts, and the durable task must settle as cancelled. A follow-up lease acknowledgement can arrive after its lease expires, with or without another controller first recovering the task. Recheck durable ownership and lease validity before entering the provider; never start an expired or recovered run and never overwrite another owner's terminal state. Preserve valid follow-ups, shutdown, recovery, and task admission behavior.`,
  },
  {
    id: "mcp-operation-deadline",
    title: "Propagate MCP deadlines and cancellation to in-flight operations",
    baseCommit: "21baff1e2988b4910cc47b47313830b4d70a5c62",
    referenceCommit: "ee637fccd8998175f1eac4a3113740cfee26578c",
    productionFiles: ["packages/mcp/src/manager.ts"],
    acceptanceFiles: ["packages/mcp/src/manager-timeout.test.ts"],
    acceptanceNamePattern: "tool deadline|pre-aborted|initialization deadline|one failed",
    expectedAcceptanceTests: 4,
    regressionFiles: ["packages/mcp/src/manager.test.ts", "packages/mcp/src/connection-lifecycle.test.ts"],
    requirements: `When an MCP manager operation times out, the client request must receive cancellation rather than merely leaving the caller's Promise.race. Preserve the manager's stable timeout error even when the client rejects on abort. A pre-aborted caller must not start a tool operation, and timing out a tool must not disconnect an otherwise healthy server.

Startup deadlines must abort initialization, close the failed client, and prevent late initialization from listing capabilities or changing failed state back to connected. If one startup discovery request fails, cancel its pending siblings and prevent their late results from repopulating manager state. Preserve normal manager connection, tool/prompt/resource calls, reconnection, and disposal behavior.`,
  },
];

export function codingEvalTask(id: string): CodingEvalTask {
  const task = codingEvalTasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Unknown task ${JSON.stringify(id)}. Run 'list' for task IDs.`);
  return task;
}
