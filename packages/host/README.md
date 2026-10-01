# Chili Host

`@chili/host` is the shared application composition for the local coding agent.
CLI and Desktop construct it; TUI connects to its HTTP/SSE adapter through
`@chili/sdk`. Host owns the runtime, tool and MCP registration, configuration,
permission policy, session store, recovery timers, and resource shutdown.

## Create and close

```ts
import { createChiliHost } from "@chili/host";

const host = await createChiliHost({
  cwd: workspacePath,
  mcpConnectMode: "manual",
});

try {
  const session = await host.service.createSession();
  await host.service.submitPrompt({
    sessionId: session.sessionId,
    text: "Explain this repository",
  });
} finally {
  await host.close();
}
```

The model defaults, persisted selection, tools, prompt assembly, and restricted
child-agent policies are shared across application entry points. `modelRouter`
and `bashRunner` can be injected for tests. `model: "fake"` runs the existing
offline fixtures; `@chili/host/testing` exposes their router for test code.

Host has no terminal UI and writes no execution output to stdout. An optional
`onEvent` observer receives committed events from initialization through shutdown;
observer exceptions do not change the committed result. CLI supplies its printer
and readline approval UI. Desktop supplies deferred approval and user-input queues.

Approval policy remains inside Host. An `askApproval` callback only returns a
decision; Host validates its scope and persists allowed grants. `approvalQueue`
takes precedence when supplied. Without either interface, operations requiring
approval are denied. `permissionProfile: "full-access"` still honors configured
denies; `"auto-review"` is unavailable and rejected.

`close()` returns one shared promise. It closes admission, interrupts/drains root
and child execution, stops managed processes and maintenance, settles interaction
queues, closes MCP, then closes SQLite. Initialization failures also drain the
resources already created.

## Dependency boundary

```text
CLI adapter / Desktop sidecar ──> Host ──> core, tools, store, providers,
                                       mcp, policy, skills, commands
HTTP/SSE server <── injected service objects from the entry point
TUI / Desktop client ──> SDK ──> protocol
```

Host imports no application, server, or SDK package. The server receives structural
service interfaces; it does not construct Host. Public transport data and MCP
control types live in `@chili/protocol`. Filesystem command loading and
`preparePromptCommandSubmission` live in `@chili/commands`; HTTP and CLI use that
same conversion to validate expanded text and preserve display text and tool
restrictions before submission.

The runtime remains `RuntimeService` plus `SingleAgentRuntime`; Host adds no
parallel session state machine. Root and restricted child registries remain
separate. Store location (`<workspace>/.chili/chili.sqlite`), session identities,
event persistence, and JSONL mirroring remain compatible.

## Current migration boundary

This package provides shared composition and SQLite-backed root input admission.
It does **not** yet implement a discoverable owner, cross-process attach, or an
independent background supervisor. Creating two Hosts does not connect them;
SQLite session leases do not forward cancellation or approval callbacks.
Desktop retains its existing parent watchdog and process containment.

`chiliHome` is currently honored by configuration, model-selection persistence,
commands, MCP, and transcript mirroring. The existing auth/Memory/skills paths
are not yet fully unified around this option. Do not treat it as complete profile
isolation until the context/configuration migration is finished.

## Durable root inputs

`RuntimeService.submitPromptAsync()` commits the normalized input and its queue
change event in one SQLite transaction before returning an accepted receipt.
`submissionId` identifies one submission within a session: identical retries
return the existing receipt; changing content, mode, or trusted source conflicts.
Callers that need retries must keep that ID. Omitting it creates a new submission.
`accepted` means saved; it does not mean the model ran or external work completed.

Modes are `start` (require an idle queue), `queue` (FIFO), and `steer` (priority at
the next turn boundary, interrupting the current turn without stopping managed
processes). `RuntimeService` arbitrates these inputs with the existing Goal loop.
Synchronous `submitPrompt()` accepts only `start`; HTTP synchronous routes reject
queue/steer before admission. Child-agent task admission keeps its existing fenced
lifecycle rather than entering this root queue.

An input is `pending`, `claimed`, or `settled`. Claiming atomically acquires the
existing session run lease and assigns stable execution/message/turn IDs. Creating
the user message and all its parts is one fenced transaction. History is never
appended twice for a retry. Settled outcomes are `completed`, `failed`, `cancelled`,
or `interrupted`; tool effects are not an exactly-once transaction.

Stop persists dispatch pause before aborting execution and stopping owned
resources. Every Stop advances the control revision, even if already paused, so
a stale Resume cannot override it. Pending inputs stay saved until explicit
Resume. A deliberate new `start` may clear pause only when no older pending or
claimed input exists. Queue/steer and duplicate retries never implicitly unpause.
HTTP Goal creation/resume also explicitly restores dispatch; model Goal tools
cannot clear a user Stop. Budget-limited Goals require a budget update first.

On startup and maintenance, recovery leaves live leases alone. Expired claimed
inputs become interrupted, unknown unfinished tool results become synthetic
failures, and remaining work is paused. Recovery never replays a tool operation.
Explicit Resume drains pending inputs first. If only interrupted/failed/stopped
execution remains, it creates a separate continuation that preserves the original
model options, materials, skills and tool restrictions. Recovery ancestry keeps
the original request available across repeated failures; the model is instructed
to inspect existing effects before continuing. Cancelled never-claimed inputs are
excluded from recovery. Pending remote inputs require renewed authorization after
runtime recovery; device/scope revocation cancels their pending input sources.

HTTP/SSE and `@chili/sdk` expose receipts, queue snapshots, cancellation, Resume,
and `session.input_queue_changed`. Desktop main caches these projections but owns
no execution queue. Renderer retries retain the submission ID until acknowledgment;
this draft retry map lasts for the current renderer process. Accepted content is
in SQLite regardless of renderer lifetime. Queue snapshots include previews only;
full input content and execution options remain in the store.

Limits: 128 pending inputs per session, 4,096 globally, 64 MiB of pending payloads,
and 16 MiB per payload, in addition to existing transport admission limits. New
schema guards reject older writers trying to claim sessions protected by durable
input state. Store migrations are additive; JSONL mirroring is a best-effort
secondary copy and is drained before Host closes SQLite.

Two Hosts still do not form one logical execution owner. Queuing into a different
process is not an attach protocol, and cancellation/approval routing still needs
owner discovery. Keep that work separate from background residency and complete
Memory/profile isolation. Stores without durable input support retain the legacy
runtime behavior; they do not provide these receipt guarantees.
