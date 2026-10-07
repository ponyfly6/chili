# Coding reliability foundation

Current product priorities are defined in [product-direction.md](product-direction.md). The coding evaluation baseline below is a completed development tool; further model benchmarking is not on the current work plan.

This change addresses concrete execution and integration failures found during the September 2026 codebase review. It preserves the Bun/TypeScript runtime and existing application boundaries. It does not establish a coding-agent ranking or choose a final Desktop design.

## Completion is a protocol boundary

The OpenAI Chat Completions, Responses/Codex, and Anthropic adapters require their protocol's explicit completion signal. EOF alone is not success. Chat Completions continues reading the usage tail after choice completion; an Anthropic tool block must close before message completion. SSE parsing preserves CRLF boundaries split across network chunks.

The core runtime independently requires a nonempty finish event before executing queued tools. Missing completion, unfinished tool arguments, and output-token exhaustion fail the turn without executing its tools. Cancellation and failure close pending tool records so the interface can show their actual terminal state. Existing retry rules still distinguish failures before assistant output from failures after output.

This intentionally changes compatibility: providers that silently close a stream without a valid terminal event now fail visibly. Output limits no longer become an apparently successful response or an implicit tool repair turn.

## A logical prompt spans multiple model turns

RuntimeService passes one prompt execution scope through ordinary turns and repair/final-response turns. Child-agent runs do the same. Each submitted input gets its own scope. A completed response does not trigger an automatic continuation; further work arrives through another input.

Repeated identical tool inputs are counted across turns in a bounded recent-call window. The per-turn total still resets at each turn. This detects repeated calls, not semantic lack of progress, and its default repetition threshold remains 20.

Initial child-agent execution now resolves the same session model configuration used by child follow-ups. It snapshots model selection, reasoning level and service tier once for the run, including its repair and final-response turns. This reuses the existing configuration policy; it does not introduce a new parent-to-child inheritance policy.

## Message order follows event creation

SQLite message projections retain the sequence of their first `message.created` event. Reads and previews use that order rather than wall-clock timestamps or random message IDs. Updates do not move a message. The creation sequence is required in the current schema and written in the same transaction as the event.

## Agents own delegation and review

Agents use the same creation, messaging, waiting, stopping, and resuming operations. They decide how to split work and request review through ordinary inputs. There is no Team controller, business Task state machine, or automatic verification/merge workflow.

Agents use `bash` for Git operations, including worktree management, and `git_apply_patch` for explicit patch integration. They can isolate work, review changes, run checks, and integrate patches under their tool permissions.

## Shell classification matches execution

Bash tools use `--noprofile --norc -c` in ordinary and macOS sandbox execution. Read-only classification includes the structured `env` argument and environment assignments in command text; an environment override requires execution permission even when the command itself looks read-only.

Commands that depended on login-shell startup files may need an explicitly configured executable path or environment. Environment overrides remain available when execution is authorized.

## A first coding-task development set

`bun run eval:coding list` exposes three real historical Chili bug-fix tasks. Preparation creates a fresh repository at the task's fixed starting snapshot. Verification supplies canonical regression and acceptance checks in a separate shadow directory. Calibration must reject each original bug and accept its production-only historical fix.

See [evaluation/README.md](evaluation/README.md) for provenance, usage and limitations. These commands do not invoke a model. Real model attempts, usage measurements, and an unseen holdout are still needed before comparing agent capability or the benefit of parallel delegation.

## Validation

Focused behavioral tests cover protocol endings and cancellation, event ordering and persistence, prompt scopes, child model configuration, read-only shell boundaries, real Git dependency chains, and evaluation isolation.

Final local validation on 2026-09-08:

- `bun test`: 2,997 passed, 0 failed across 246 files (21,495 assertions; 157.15 seconds).
- `bun run typecheck`: passed, including Desktop and control-web.
- `bun run smoke:all`: all 10 suites passed, including `smoke:p3-team-model` and `smoke:p3-team-parallel`.
- Coding evaluator calibration: all three original bugs rejected by behavior checks; their historical production fixes passed both gates. See [initial calibration](evaluation/initial-calibration-2026-09-08.md).

Gate logs are local artifacts under `/tmp/chili-reliability-foundation-2026-09-08/`. The full checks ran against the current working tree, including the pre-existing Desktop edits that are excluded from this change. A passing fake-model smoke suite is not evidence of real-model coding performance.

## Runtime event delivery and recovery

Chili keeps SQLite as the durable event authority and SSE as the live transport.
Healthy connections have no default event-count or age rotation. A connection
does not retain the IDs of every event it has sent.

### Ordering and reconnects

`EventStore.events()` returns unique durable events in insertion (`seq`) order.
An `afterEventId` is exclusive and must belong to the requested session when a
session filter is present. Initial connections retain the bounded recent-tail
behavior. SQLite computes the tail boundary and resumed replay count without
decoding the event payloads.

Notifications are wakeups, not the source of durable frames. A single pump reads
after its cursor; duplicate, delayed, or reordered notifications cannot replay
older rows. Periodic reads cover writes that did not notify this particular
`ObservableEventStore`. Transient notifications also request durable catchup so
their tool and turn anchors can be sent first.

The server's cursor means **enqueued**, not delivered or acknowledged. A client
reconnects using its last consumed durable event. Short interruptions replay the
missing suffix. Normal EOF reconnects too; an EOF without durable progress and
ordinary TUI transport errors wait before retrying. Abort and connection-version
checks prevent an old stream or recovery request from replacing newer state.

### Bounded queues

The SSE application queue has a UTF-8 byte high-water mark. The producer waits
for `pull()`/available capacity and stops reading additional database pages while
blocked. SQLite checks the compact payload size before bringing a row into JS;
pages have a separate byte budget. A legal larger event may occupy its own page.
An oversized row produces a bounded `chili.resync` control frame.

Temporary output has an independent byte budget, including during initial
replay. Durable notifications coalesce into one dirty flag instead of retaining
event objects. Heartbeats are skipped while output is blocked. A stalled reader
is errored after the configured no-progress timeout, discarding the application
queue and releasing subscriptions, timers, and pending output. Temporary-buffer
overflow requests a state resync. Explicit rotation settings remain available as
operational overrides; they are unnecessary for bounding memory.

The resident data bound includes the SSE queue, one database page, one encoded
frame, the temporary queue, a separately byte-bounded active-content bootstrap,
and a small terminal control frame. This is an
application-layer bound; Bun and the operating system also maintain transport
buffers. Byte budgets bound serialized data, not exact JavaScript heap overhead.

On the pinned Bun 1.3.14 runtime, `Bun.serve` eagerly drains response streams,
including direct streams, even when the TCP reader is blocked. The runtime HTTP
listener therefore uses Bun's `node:http` adapter and waits for `drain` after
`ServerResponse.write()` reports pressure. Writes are sliced into 64 KiB chunks;
the existing Fetch-style handler and SSE protocol remain unchanged. Real TCP
tests exercise a stopped reader alongside a fast reader. Socket closure aborts
the handler, and a write-stall timeout destroys the connection.

Single-context TLS retains the existing PEM, byte-buffer, and local `Bun.file`
inputs through Bun's TLS listen options. This Bun adapter does not support
multiple TLS certificate contexts: such configurations fail at startup rather
than silently dropping certificates. Loopback Host validation and remote
authentication/TLS requirements remain enforced. HTTP JSON bodies and recovery
responses are byte-bounded during reading, before JSON parsing.

### Atomic state recovery

`GET /events/snapshot` (optionally scoped by `sessionId`) reads a compact
materialized state and its durable high-water cursor in one SQLite read
transaction. The observable store adds current in-memory text and thinking.
New SSE subscriptions capture these active blocks after subscribing, before any
asynchronous replay work; offsets suppress overlapping live fragments. Legacy
persisted deltas are still folded when reading old messages. Seed IDs are projection identities;
they must never be used as SSE resume cursors.

The TUI uses this endpoint for an invalid cursor, an excessive replay backlog,
an oversized event, or a temporary-buffer overflow. It replaces the projection
and resumes strictly after the snapshot's `afterEventId`. An empty snapshot uses
`fromStart=true`, so events committed before the next connection cannot be lost
to an initial tail limit. If that suffix already exceeds the replay budget, it
requests a newer snapshot.

Snapshots have count and byte budgets. Older history may be omitted with a
visible truncation warning. Required current state must either fit or recovery
fails explicitly; the client retries with delay instead of silently advancing.
Stores without atomic recovery capability return an explicit unavailable error.

The TUI keeps stream consumption separate from history hydration. Its existing
durable-ID deduplication still protects overlapping ordinary hydration and live
events. After replacing a session from a snapshot, late raw history hydration
for that session is ignored: old text deltas must not be appended again to the
snapshot's already-materialized text.

The transport budgets do not bound the TUI's lifetime projection/history or its
retained durable-ID hydration deduplication. Those client structures remain in
place; paged history and coordinated eviction need a separate design.

### Temporary output

`tool.output_delta` is best-effort preview data, not durable history. A dropped
connection or snapshot cannot reconstruct intermediate output. The projection
marks preview gaps and bounds each tool's preview by chunk count and UTF-8 bytes;
the TUI says when missing preview cannot be replayed. Durable tool completion and
final output still restore the final result. Complete running-output recovery
would require a separate persisted output/snapshot protocol.

### Codex reference

The sibling Codex implementation informed the queue and recovery boundaries:

- `codex-rs/app-server/src/transport.rs` isolates slow network writers by
  disconnecting when their bounded channel is full; its ordinary transport
  limits are message counts, not byte limits.
- `thread_state.rs` and `request_processors/thread_lifecycle.rs` serialize a
  thread resume response with its listener, combining durable history and the
  active turn before continuing live notifications. Chili uses SQLite's atomic
  snapshot plus cursor to establish the corresponding boundary.
- `codex-rs/tui/src/app/thread_event_buffer.rs` bounds and coalesces temporary
  deltas. Chili similarly gives previews a separate budget and explicitly does
  not promise to replay lost temporary bytes.

Chili does not adopt Codex's transport or persistence architecture. SQLite,
SSE, and incremental cursor replay remain the runtime contract.

### Complete content and file storage

New model text and thinking are accumulated in memory. A provider block-end
commits one complete `message.part_committed`; providers without a block-end
commit pending content at response finish. Cancellation and handled failures
commit the received text with `completion: cancelled` or `failed`, and failed
turns retain their reason. An abrupt process exit loses uncommitted content.
There are no disk drafts, periodic text checkpoints, or index-rebuild service.
Original thinking and opaque provider continuation fields remain available.

`message.part_stream_delta` and `message.part_stream_snapshot` are transient.
Offsets use JavaScript string code units. Completed blocks replace active text;
late fragments cannot append to a completed block. Part ordinals preserve the
order in which blocks first appeared, even when completion is interleaved.
Tool argument fragments accumulate in memory until their complete call boundary.

File-backed stores put immutable content under
`<database-directory>/contents/<database-filename>/`, grouped by session. Text,
images, tool inputs/results and model-request content are referenced from SQLite.
Equal content within a session shares a file, including tool results reused in
message parts, tool records and prepared requests. JSON manifests carry the
structural data needed to resolve those references. New file contents are synced
before SQLite publishes their references. SQLite retains event identities,
ordering, relations, short previews, input acceptance and execution state.
Back up the database and its content directory together.

The default Host no longer writes a second transcript JSONL mirror. Explicit
mirror utilities remain available to embedders. Existing inline SQLite records
remain readable, and the required storage-format and byte-accounting columns are added when opening
an existing store. This does not rewrite or delete old history or its duplicate
payloads. Unreferenced files from rejected transactions are not automatically
imported or collected.

Event-page limits use the resolved content size before opening referenced bodies.
Recovery snapshots remain bounded display views, not backups. Active content
must fit without truncation so subsequent offsets remain meaningful. Historical
content can still be clipped in a recovery view; the ordinary message API reads
the stored content, and the TUI reloads the selected session's history after a
snapshot replacement. The SSE queue and transport backpressure limits continue
to apply independently of persistent storage.
