# Chili Host

`@chili/host` is the shared application composition for the local coding agent.
CLI and Desktop construct it; TUI connects to its HTTP/SSE adapter through
`@chili/sdk`. Host owns the runtime, tool and MCP registration, configuration,
execution review, session store, recovery timers, and resource shutdown.

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
`onEvent` observer receives accepted events, including transient stream deltas,
from initialization through shutdown; observer exceptions do not change the
operation result. CLI and Desktop supply
user-input interfaces for clarification, independently from execution review.

Host registers a fixed list of typed `modules` at construction. Each `HostModule`
has one unique ID and can provide several capabilities: `prompt.collect`,
`tools.review/processResult/ended`, `model.started/event/ended`,
`agent.started/ended`, `runtime.event`, and `modelSelection.changed`. Root and
child services share the list. Built-in modules run before extensions; the
`chili.` namespace is reserved. There is no plugin loader, dynamic registration,
`next()` middleware, or callback that can replay an operation.

The execution-review module is a registered `tools.review` capability, required
by the host's gate adapter. Full Access skips all review capabilities. Auto-review
requires the built-in review and every additional reviewer to allow the prepared
operation; an extension cannot override a denial. The executor still calls the
gate at the effect boundary and rechecks the returned permits. Lifecycle
observers cannot grant authorization.

Observers are synchronous and failure-isolated. `onHookError` identifies the
`moduleId`, capability `point`, and error; a failed observer disables only that
capability. The legacy `onEvent` option is adapted once into `runtime.event` and
retains its compact public event data. Internal `model.event` streams are a
separate observation surface and are not automatically published to SSE or
conversation history. See [Host modules and Hooks](hooks.md) for the full API,
deadline, cancellation, and completion contracts.

Host supports exactly two execution modes. `full-access` executes tools directly.
`auto-review` (the default) asks an independent model to allow or deny each exact
prepared call. The host triggers review automatically; the task model has no
approval tool. A denial returns its explanation to the task model. Review errors,
invalid responses, oversized inputs and timeouts fail the tool without execution
or a fallback human approval queue. Reviewers receive no tools in this version.

The reviewer receives the complete frozen action, selected conversation evidence
with explicit provenance, the fixed reviewer role/output contract, and editable
user review instructions. Authenticated human inputs and question answers are
separated from agent messages, command expansion, tool output and repository text.
Human intent is timestamped, and newer instructions, settings changes and
cancellation invalidate pending permits before effects. Every invocation is
reviewed independently; there are no session grants or remembered tool approvals.

`permissions.set(profile, { reviewInstructions, reviewerModel })` asynchronously
saves `review-settings.json` in the user profile. `reviewerModel: null` returns to
the current task model. Instructions default to broad task autonomy with checks
for major unintended destructive actions and private-data exposure; restore the
returned `defaultReviewInstructions` to reset them. Settings affect the current
Host after a successful save; other running Hosts retain their loaded settings
until restarted or changed. Project configuration cannot replace review settings.
Legacy `[permissions]` tables are ignored. `reviewerModelRouter` and
`reviewTimeoutMs` support isolated fake-model tests. The built-in fake model also
provides deterministic review decisions without network calls.

`close()` returns one shared promise. It closes admission, cancels cancellable
module waits, interrupts/drains root and child execution, stops managed processes
and maintenance, settles interaction queues, closes MCP, then closes SQLite.
Observers remain active until terminal events have been delivered. Initialization
failures also drain the resources already created.

`modelSelection.changed(input, signal)` is awaited completion work after the
selection event commits, not an optional observer. Host closure does not cancel
it, including when an event observer starts closing before persistence begins.
Each handler still has its module deadline; the host separately drains its
already-started atomic preference writes before releasing ownership. Extension
handlers must await all their work and honor their deadline signal. A failure
does not roll back the committed selection. This is not a durable callback queue.

## Dependency boundary

```text
CLI adapter / Desktop sidecar ──> Host ──> core, tools, store, providers,
                                       mcp, skills, commands
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
event identities and old inline history remain compatible. New content is stored
in adjacent immutable files; the default duplicate JSONL mirror is disabled.

## Execution identity and ownership

Host resolves canonical profile, authentication path, project and workspace
identities. Git worktrees share the common repository project ID while retaining
separate workspace IDs. Session-specific cwd selection continues to work: skills,
Memory and child execution follow that session's project rather than the
initial Host directory. Creation-time environment metadata is stored separately
from the session ID. Resume looks up the original ID only in the current Host's
`<workspace>/.chili/chili.sqlite`; a missing ID fails. Environment changes do not
rebind or replace the session. Historical identity bindings remain readable but
do not restrict execution or become the identity of a new model request.

An explicit `chiliHome` isolates auth, Memory, skills, commands, MCP and model
selection. Without one, `CHILI_HOME` and the legacy `CHILI_AUTH_FILE` override
remain supported. The auth path contributes to profile identity. CLI exposes
`--chili-home`. Account resolution is recorded separately, immediately before
provider dispatch; no credential value is stored in the audit identity.

Multiple Hosts may open the same project store and run different root sessions.
Creation or the first mutation, and explicit open/resume through
`RuntimeService.acquireSession()`, acquire the root session and all descendants
for that Host until `Host.close()` finishes draining resources. Another Host
receives `HostSessionOwnerConflictError` for that session, including between
turns. Listing sessions and reading history acquire no ownership; they do not
attach to or forward control to the owning Host. Closing one Host releases only
its own session trees and resources. Session IDs remain unchanged on resume.

Ownership has no time-based expiry. After an owner dies, its registered guardians
and process groups must be gone before another Host acquires its sessions.
Session leases still fence individual operations; lease expiry alone does not
prove an external process has stopped. PID reuse is handled conservatively by
refusing takeover. When upgrading a store with the old singleton Host ownership
format, close the old Host and let its resources stop before opening the new
version. Cross-process control forwarding and independent background residency
remain unimplemented.

Prompt, Stop, Steer, archive and snapshot recovery use the same runtime operation
ownership. Low-level RuntimeService callers using separate store connections also
reject control of a foreign live execution. Each Agent is a Session. Creation,
messages, waiting, Stop and Resume use its durable input queue and session run
lease. Child model turns share the configured concurrency limit.

## Tools, context and durable compatibility

The runtime advertises a versioned tool catalog, then prepares each call once for
schema validation, execution review, scheduling and execution. Catalog changes
invalidate stale calls. The effect boundary rechecks the execution permit and
resource identity, including after snapshots and file-lock waits. Structured
program data is stored separately from model previews and compact UI transport.

Result processors run after canonical output and sidecar handling. They may
change `title`, `output`, and `content`; canonical `structuredData`, `metadata`,
and `artifactIds` remain authoritative. Processing neither repeats tool execution
nor creates another sidecar pass. Tool terminal audit events retain canonical
output; lifecycle completion provides both canonical and returned results. A
processor error or deadline preserves successful execution with an explanatory
notice, rather than inviting the model to repeat an already-completed effect.

Model lifecycle observation follows each consumed router stream invocation.
Runtime retries create new invocations; provider-internal retry, timeout,
backpressure, and iterator cleanup remain unchanged. `purpose` distinguishes
`task`, `review`, `compaction`, and `validation`, independently of the originating
session's `root`/`child` role and parent. Agent lifecycle observation spans one
accepted input that starts running, including its model/tool continuations, and
ends after settlement and lease release.

Both modes execute approved ordinary shell calls through the normal host backend.
Explicit delegated worker scopes remain enforced by the tool executor and process
sandbox. A worker cannot widen its assigned filesystem, command or network scope
by selecting Full Access. Unsupported scoped process isolation fails closed.
See [process isolation](../../docs/managed-processes.md).

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
of provider IDs, and old history keeps its protocol mapping. Memory is ordinary
Markdown under the active profile's `memory/personal` and
`memory/projects/<projectId>` directories. Main and child prompts provide these
paths without loading their bodies; normal file tools or Bash perform access
under existing execution policy. There is no dedicated Memory tool or database
authority, and no import or compatibility path for old Memory storage. Module
prompt collection supplies these directory hints; it adds no automatic Memory
extraction, update hook, or background maintenance interface.

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

Startup and maintenance only recover session trees already owned by this Host;
unopened history remains available for another Host to acquire. Opening a saved
session first acquires its tree, then repairs interrupted state. Expired claimed
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
in the store regardless of renderer lifetime; SQLite retains the receipt and
references the full input in the adjacent content directory. Queue snapshots include previews only;
full input content and execution options remain in the store.

Limits: 128 pending inputs per session, 4,096 globally, 64 MiB of pending payloads,
and 16 MiB per payload, in addition to existing transport admission limits.
The content-storage change adds its storage-format and byte-accounting columns to the existing
schema and continues reading inline history. It does not migrate unrelated older
schemas. The default Host does not create a secondary transcript mirror. Backups
must include `chili.sqlite` and `contents/chili.sqlite/` together.

A second Host may run another root session; the same session tree remains with
its current owner until close or safe crash recovery. Recovery skips session
trees this Host has not acquired and leaves their pending inputs alone.
There is no control forwarding or attach protocol. Stores without durable input
support retain the legacy runtime behavior; they do not provide these receipt
guarantees. Execution uses the current Host configuration and the session's
stored cwd; accepting an input does not bypass ownership or permission checks.
