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

## Execution identity and ownership

Host resolves canonical profile, authentication path, project and workspace
identities. Git worktrees share the common repository project ID while retaining
separate workspace IDs. Session-specific cwd selection continues to work: skills,
Memory, rules and child execution follow that session's project rather than the
initial Host directory. The identity is persisted when a session is created;
legacy sessions bind on their first owned execution. Resume and execution reject
a changed profile/project/workspace binding before model or tool effects.

An explicit `chiliHome` isolates auth, Memory, skills, commands, MCP and model
selection. Without one, `CHILI_HOME` and the legacy `CHILI_AUTH_FILE` override
remain supported. The auth path contributes to profile identity. CLI exposes
`--chili-home`. Account resolution is recorded separately, immediately before
provider dispatch; no credential value is stored in the audit identity.

Each SQLite store now admits one live Host. A second Host throws
`HostOwnerConflictError`; it does not pretend to attach or forward Stop. Host
ownership has no time-based expiry. After an owner dies, recorded guardians and
their process groups must also be gone before a new Host can open the store.
Session leases still fence individual operations; a lease expiry alone proves
nothing about an external process. PID reuse is handled conservatively by
refusing takeover. Cross-process attach and independent background residency
remain unimplemented.

Prompt, Stop, Steer, archive and snapshot recovery use the same runtime operation
ownership. Low-level RuntimeService callers using separate store connections also
reject control of a foreign live execution. Each Agent is a Session. Creation,
messages, waiting, Stop and Resume use its durable input queue and session run
lease. Child model turns share the configured concurrency limit.

## Tools, context and durable compatibility

The runtime advertises a versioned tool catalog, then prepares each call once for
schema validation, permission analysis, scheduling and execution. Catalog changes
invalidate stale calls. The effect boundary rechecks current policy and resource
identity, including after approval and file-lock waits. Structured program data
is stored separately from model previews and compact UI transport.

Each authorization boundary captures one copied policy observation. Permission
decisions, revision hashes and file-resource checks share that observation; the
next boundary captures fresh rules. An approval returns its accepted policy
version with the decision, so a stale reply cannot acquire a newer version during
handoff to the executor. Worker admission and backend scopes likewise use one
copied worker policy per check. This does not pin permissions for an entire turn:
revocation during approval, backup or file-lock waits still blocks later effects.
See the [permission refactor record](../../docs/agent-foundation-implementation-2026-10-03.md#2026-10-06权限执行链收拢).

Explicit file denies also constrain Bash through the actual process backend.
They force macOS Seatbelt even under full-access; escalation and opaque runners
cannot bypass them. Unsupported platforms and deny patterns fail closed. Scoped
commands keep their complete invocation, write and network restrictions through
the final process-start authorization check. See [process isolation](../../docs/managed-processes.md).

File tools share session/workspace/version observations and cooperative mutation
locks. Snapshot v3 restoration checks ownership and all target versions before
mutating files. Changed v2 snapshots remain available as backup artifacts but
cannot be safely auto-restored without historical ownership evidence. See
[the file contract](../../docs/file-observation-contract.md).

The actual budgeted model request is persisted, with sources and omission reasons;
`inspectPrompt` returns that record unless a hypothetical turn is requested.
[Context](../core/src/context/README.md), [Memory](../core/src/memory/README.md),
[providers](../providers/README.md), [MCP](../mcp/README.md) and
[commands](../commands/README.md) document their shared contracts and migrations.
Existing conversation history is retained. Internal tool IDs are now independent
of provider IDs, and old history keeps its protocol mapping. Memory Markdown is
imported transactionally once into the profile database and is thereafter an
export format, not a second mutable authority.

## Durable session inputs

`RuntimeService.submitPromptAsync()` commits the normalized input and its queue
change event in one SQLite transaction before returning an accepted receipt.
`submissionId` identifies one submission within a session: identical retries
return the existing receipt; changing content, mode, or trusted source conflicts.
Callers that need retries must keep that ID. Omitting it creates a new submission.
`accepted` means saved; it does not mean the model ran or external work completed.

Modes are `start` (require an idle queue), `queue` (FIFO), and `steer` (priority at
the next turn boundary, interrupting the current turn without stopping managed
processes). `RuntimeService` dispatches these inputs through the session queue.
Synchronous `submitPrompt()` accepts only `start`; HTTP synchronous routes reject
queue/steer before admission. Root and child Sessions use the same durable input
queue. Agent creation commits its child Session and first input together.

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

On startup and maintenance, recovery leaves live leases alone. Expired claimed
inputs become interrupted, unknown unfinished tool results become synthetic
failures, and remaining work is paused. Recovery never replays a tool operation.
Explicit Resume reopens the latest eligible interrupted, failed or cancelled
input under the same input ID and preserves its model options, materials, skills
and tool restrictions. That input runs before later pending inputs; the model is
instructed to inspect existing effects before continuing. Cancelled never-claimed
inputs are excluded from recovery. Pending remote inputs require renewed
authorization after runtime recovery; device/scope revocation cancels their pending
input sources.

HTTP/SSE and `@chili/sdk` expose receipts, queue snapshots, cancellation, Resume,
and `session.input_queue_changed`. Desktop main caches these projections but owns
no execution queue. Renderer retries retain the submission ID until acknowledgment;
this draft retry map lasts for the current renderer process. Accepted content is
in SQLite regardless of renderer lifetime. Queue snapshots include previews only;
full input content and execution options remain in the store.

Limits: 128 pending inputs per session, 4,096 globally, 64 MiB of pending payloads,
and 16 MiB per payload, in addition to existing transport admission limits.
The store opens the current schema directly; older database schemas
are unsupported. JSONL mirroring is a best-effort secondary copy and is drained
before Host closes SQLite.

A second Host is rejected until the current owner and its resources have stopped.
There is no control forwarding or attach protocol. Stores without durable input
support retain the legacy runtime behavior; they do not provide these receipt
guarantees. A synchronous accepted receipt may precede asynchronous identity
validation; a mismatch settles as a failure before execution and is never allowed
to silently switch the queued task's profile.
