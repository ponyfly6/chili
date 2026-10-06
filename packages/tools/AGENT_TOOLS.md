# Agent tools

Host exposes six ad-hoc Agent management tools. They are deferred as one group:
searching for one loads the available controls, and existing Agent state keeps
them available for later inspection and follow-up. All six support code mode and
return the same machine-readable JSON in `structuredData` and text `output`.

| Tool | Input | Behavior |
| --- | --- | --- |
| `agent_spawn` | `description`, `prompt`, optional `mode`; or `tasks` array | Create one or several agents. |
| `agent_list` | Optional `taskIds`, `status`, `limit`; or `view: "messages"` with message filters | Inspect scoped agents/results or durable mailbox messages. |
| `agent_send` | `to`, `content`, optional `delivery` | Send a durable message without interrupting work. |
| `agent_wait` | `taskId` or `taskIds`, optional `waitFor`, `timeoutMs` | Wait for any/all results, returning a partial snapshot on timeout. |
| `agent_stop` | `taskId`, optional `summary` | Interrupt active work and mark it cancelled; keep the session/history. |
| `agent_resume` | `taskId`, optional `prompt`, `maxTurns` | Continue an existing Agent with its preserved history. |

Tool names are canonical; legacy names are not registered as aliases in Host.
Existing snake_case argument spellings remain accepted by the adapters. Task IDs,
domain events, SDK lifecycle records and permission name `task` remain stable.
Old tool factories remain exported for embedders, and historical tool calls still
render correctly. `complete_task` remains the worker's completion protocol;
persistent Team tools are a separate workflow.

## Create, wait and resume

Single creation defaults to `one_shot`, which returns its result inline. Use
`mode: "resumable"` for an inline result with retained history, or `background`
for an immediate handle and later stop/resume. Batch creation accepts
`tasks: [{ description, prompt }]`, runs background workers, and defaults to
`completionPolicy: "join"`. `maxConcurrency` defaults to 3 and remains subject to
runtime limits. Single and batch inputs cannot be mixed.

`completionPolicy: "supervised"` is available with the `tasks` form. Review
results using `agent_wait({ taskIds, waitFor: "any" })`, send messages or resume
terminal agents as needed, then perform a final `waitFor: "all"` and integrate
their results. `notify` wakes a later parent turn; `detached` does not. Completion
is not the same as successful completion: inspect failed, incomplete and
cancelled states before answering.

`agent_wait` always returns a `tasks` array, including when given one `taskId`.
A timeout preserves all handles and returns `timedOut: true`; it does not stop
the agents. `agent_resume` waits inline for the continued run. If `prompt` is
omitted, it asks the agent to continue the previous task. A running agent cannot
be resumed concurrently. An immediately preceding stop may still be draining;
retry resume after cleanup if it reports busy. Repeating `agent_stop` on a
terminal agent preserves its terminal result, rather than overwriting it.

## Messages and scope

`agent_send` defaults to `delivery: "queueOnly"`: the message is stored for
inspection, and no turn is started. Read it with
`agent_list({ view: "messages", taskId })`. `delivery: "triggerTurn"` requests
delivery to a live recipient, waiting for its active turn to finish without
interrupting it. It does not restart a terminal agent; use `agent_resume`.
Targets may be task IDs, canonical agent paths, task names or `parent`.

Agent listing remains scoped to the current session; message listing remains
scoped to the visible agent tree. `all: true` does not bypass that scope.
Workers receive only their allowed controls and completion tool. Nested ad-hoc
delegation is available when the configured depth permits it; child agents inherit
their parent's restrictions and cannot grant themselves broader access. Delegation-off policy blocks
spawn, send and resume, while inspection, waiting and stopping remain available.

## Horizontal and vertical expansion

Set `[agents]` in the user or nearest project `.chili/config.toml`:

```toml
[agents]
max_children = 4
max_depth = 3
max_concurrent = 3
```

This allows each Agent to create four direct child identities and descendants down
to depth three (root depth zero). Horizontal slots count completed/stopped children;
resume reuses a slot. Creation checks the quota atomically, including concurrent
requests and after reopening the Host. Parents waiting for descendants release
execution capacity so a deep tree can progress even with `max_concurrent = 1`.
Background creation still returns a handle immediately, subject to admission.

Defaults are 64 children, depth 1 and 3 concurrent child executions across all
depths; the root does not consume a slot. Depth 0 or width 0
disables spawning. Agent expansion limits are loaded when the Host starts; restart
it after editing them. Existing explicit worker restrictions remain in force.
Persistent Team workers keep their separate scheduling and scope; these recursive
controls apply to ad-hoc agents created with `agent_spawn`.

`agent_stop` targets that Agent's current run, not an entire durable subtree. A
background descendant created by an earlier completed run may still be active;
its owner can inspect and stop it independently.

See [configuration details](../host/AGENT_CONFIG.md) for ranges and override rules.

## Code mode

```js
const spawned = await tools.agent_spawn({
  description: "Inspect imports",
  prompt: "Check for unused imports and report findings.",
  mode: "resumable",
});
const taskId = spawned.structuredData.task_id;
text((await tools.agent_resume({ taskId, prompt: "Verify the findings." })).structuredData);
```

Each call retains its own authorization, event record and lifecycle checks. The
code-mode deadline includes Agent execution: use direct calls for operations
that may exceed that deadline. Searching inside a script is optional when the
contract is known; `tool_search` can provide full schemas when needed.
