# Agent tools

All Agents use one creation, input, waiting, pause and resume lifecycle. The Host
exposes six controls as a deferred group: searching for one loads the authorized
controls, and durable Agent state keeps them available for later interaction.
All six support code mode. Read machine results from the tool result's
`structuredData` field.

| Tool | Input | Result and behavior |
| --- | --- | --- |
| `agent_spawn` | `{ name, prompt, cwd? }` | Create one Agent asynchronously; return `{ agentId, inputId }` for its initial input. |
| `agent_send` | `{ agentId, text, mode?: "queue" \| "steer" }` | Submit an input through the same durable queue; return `{ agentId, inputId }`. |
| `agent_wait` | `{ agentId, inputId, timeoutMs? }` | Wait for that input; return `{ input, result?, timedOut }`. |
| `agent_stop` | `{ agentId }` | Persistently pause the Agent and cancel its current activation, preserving queued inputs and history. |
| `agent_resume` | `{ agentId }` | Resume scheduling for the same Agent; return `{ agentId, inputId? }`. |
| `agent_list` | `{}` | Return `{ agents }` with the visible hierarchy and Agent states. |

## Inputs and results

`agent_spawn` returns after creation and input admission. Keep both identifiers:
`agentId` identifies the reusable Agent, and `inputId` identifies the specific
request whose result you need. Multiple independent Agents can be created by
calling `agent_spawn` concurrently. `name` is one path segment using letters,
digits, hyphens, or underscores.

`agent_send` defaults to `mode: "queue"`. Inputs wait for the Agent's current work
and are scheduled when it can run. `mode: "steer"` requests a change of direction
for current work through the same input mechanism. Both modes return an input
receipt. Inputs sent to a paused Agent remain queued until it is resumed.

`agent_wait` follows the supplied input receipt. It does not confuse a previous
result with completion of a later request to the same Agent. On timeout it
returns `timedOut: true`; only the wait ends, and the input continues to exist.
Wait again with the same `agentId` and `inputId` to observe its outcome. Inspect
the returned input and result before treating the work as successful. `timeoutMs`
defaults to 30000 and accepts 0 through 60000; use 0 to poll the current receipt.

`agent_stop` persists the pause, cancels the current activation and retains the
Agent's queue and conversation history. `agent_resume` clears the pause so the
same Agent can process its retained inputs. If its response includes `inputId`,
that receipt can be passed to `agent_wait`. Send new instructions with
`agent_send`; resume itself takes no prompt.

## Scope and permissions

`agent_list` returns the whole hierarchy under the caller's root, including the
root and caller. `agent_send` and `agent_wait` can target Agents in that hierarchy,
including peers and parents. Messages carry a trusted sender identity
(`agentId`, `name`, `path`) alongside the submitted text. Other roots are
inaccessible. Waiting on a peer or parent is limited to inputs the caller sent;
an Agent can also wait on inputs belonging to itself or its descendants.
`agent_stop` and `agent_resume` only control the caller's
descendants. Creation limits and access checks apply equally to all Agents.
Child Agents retain their effective tool permissions and resource restrictions;
creating an Agent cannot grant broader access. Delegation-off policy hides and
rejects spawn, send and resume. List, wait and stop remain available to observe
and stop existing Agents, subject to their normal access checks.

Every Agent receives code mode by default. Each nested tool call still checks
that Agent's current permissions, resource scope and approval requirements.
Use ordinary Git tools for workspace isolation and integrating reviewed changes.

## Horizontal and vertical expansion

Set `[agents]` in the user or nearest project `.chili/config.toml`:

```toml
[agents]
max_children = 4
max_depth = 3
max_concurrent = 3
```

These settings control direct child identities, maximum depth and shared running
capacity. The root is depth zero. Resuming an Agent reuses its identity. Admission
and scheduling enforce the configured limits independently of tool access.
See [configuration details](../host/AGENT_CONFIG.md) for counting rules, defaults,
ranges and overrides.

## Code mode

Use ordinary JavaScript concurrency for independent Agent creation:

```js
const work = [
  { name: "imports", prompt: "Inspect unused imports and report findings." },
  { name: "tests", prompt: "Inspect test coverage and report gaps." },
];
const receipts = await Promise.all(work.map(async (input) => {
  const spawned = await tools.agent_spawn(input);
  return spawned.structuredData;
}));
text({ receipts });

const outcomes = await Promise.all(receipts.map(async (receipt) => {
  const waited = await tools.agent_wait({ ...receipt, timeoutMs: 5000 });
  return waited.structuredData;
}));
text({ outcomes });
```

Retain each receipt for later waits or messages. The script deadline includes
tool waits; use bounded waits that fit within it or wait directly. A wait timeout
does not cancel the submitted input. Search inside a script is optional when
the contract is known; `tool_search` provides full schemas when needed.
