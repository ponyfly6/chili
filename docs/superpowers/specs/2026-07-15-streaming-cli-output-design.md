# Streaming CLI Output Design

## Goal

Prevent verbose CLI commands from consuming excessive model context while preserving their complete output for later inspection. A command such as `seq 3000` must return a bounded preview to the model, and commands larger than the current 256 KiB process capture limit must still have a complete recoverable artifact.

## Scope

This first pass applies to the built-in `bash` tool and the context-window transformation of textual tool results. It reuses `.chili/tool-results` and the existing `read` and `grep` tools. Dedicated artifact APIs, MCP-specific structured pagination, semantic summarization, and UI artifact browsers are intentionally deferred.

## Chosen Approach

Use a Pi/OpenCode-style streaming accumulator at the process boundary.

- Count decoded output lines and raw UTF-8 bytes across stdout and stderr.
- Keep bounded tail state in memory for the model-facing preview.
- When either 2,000 lines or 50 KiB is exceeded, create a call-scoped sidecar, backfill all buffered chunks, and append every later chunk with filesystem backpressure.
- Preserve stream identity in the sidecar and preview with `[stdout]` and `[stderr]` section markers.
- For output below both thresholds, preserve today's stdout-then-stderr formatting and do not create a sidecar.

This is preferred over post-process truncation because the existing process collector permanently loses bytes after 256 KiB. It is preferred over Codex-style in-memory head/tail-only capture because a complete artifact remains searchable.

## Components

### Streaming process-output accumulator

Add a focused accumulator in `packages/tools/src/` that accepts raw chunks plus their stream name. Its public surface provides append, finish, and snapshot operations. A snapshot reports:

- bounded preview text;
- `truncated` and `truncatedBy` (`lines`, `bytes`, or both);
- total and retained line/byte counts;
- sidecar relative path when one was created;
- persistence errors without throwing away the command result.

The accumulator buffers at most the threshold-sized prefix before offload and a bounded rolling tail for preview. Once offloaded, it writes subsequent chunks directly to the sidecar. UTF-8 decoding uses a streaming decoder per output stream so split multibyte characters never produce replacement characters.

### Process runner integration

Extend `runProcess` with an optional raw-output capture callback. The callback runs before the existing final-output collector discards bytes. It may be asynchronous so filesystem drain applies backpressure instead of allowing an unbounded write queue.

The existing live-output dispatcher remains separately bounded and continues to drive the TUI.

### Bash integration

The bash tool creates the accumulator using its workspace and tool call ID. When the accumulator reports truncation, bash returns a bounded tail preview followed by an explicit notice containing totals, the retained range, and the `.chili/tool-results/...` path. When it does not report truncation, bash uses the existing formatter unchanged.

The bash model-facing result limit is raised only enough to contain the 50 KiB preview and notice. It remains below the CLI runtime's configured 80,000-character single-tool context limit.

### Sidecar lifecycle and safety

Sidecar names use the existing sanitized tool-call naming rules and remain inside `.chili/tool-results`. The existing defaults continue to apply:

- maximum persisted output per call: 1 MiB;
- maximum sidecar directory size: 64 MiB;
- oldest sidecars evicted first;
- current sidecar retained even when it alone exceeds the directory target;
- symlink and workspace-escape checks fail closed.

If the command produces more than the configured persisted-output limit, the file contains the first persisted limit bytes and the model notice must say `first N of M bytes saved`, never `full output saved`. If persistence cannot be established safely, execution still completes with a bounded preview and a clear persistence-failure warning.

### Context-window truncation

Change single tool-result truncation from prefix-only to UTF-16-safe head/tail truncation with an omission marker. Allocate 25% of the available payload to the head and 75% to the tail so command setup remains visible while final errors and summaries survive. Existing artifact IDs, error fields, and metadata remain attached.

## Data Flow

1. The child process emits a stdout or stderr chunk.
2. The process runner forwards the raw chunk to the accumulator before applying its legacy capture cap.
3. The accumulator updates totals and its rolling tail; crossing either threshold lazily opens and backfills the sidecar.
4. Live output continues through the existing bounded delta dispatcher.
5. On exit, bash closes the sidecar and formats either the unchanged small result or the bounded verbose-result preview.
6. The tool executor stores the bounded result without overwriting an already-created complete sidecar.
7. The context builder may further head/tail-compact old results while preserving the tail notice and artifact reference.
8. The model can use `grep` or `read` with offset/limit on the sidecar.

## Error Handling

- A sidecar write or close failure does not change a successfully executed command into a tool failure.
- The result records the persistence error and remains bounded.
- Abort and timeout paths flush and close any opened sidecar before returning or rejecting.
- Raw byte totals describe process output only; sidecar stream markers are not included in those totals.
- A trailing newline does not create an extra logical line.

## Tests

Add test-first coverage for:

1. `seq 3000`: model preview is bounded to the final 2,000 lines, reports the retained range, and the sidecar contains lines 1 through 3000.
2. Output above 256 KiB with a unique final marker: the marker is present in the preview and sidecar, proving capture occurs before the legacy prefix cap.
3. Split UTF-8 characters across chunks: no replacement character in preview or sidecar.
4. Interleaved stdout/stderr: content and stream identity are preserved.
5. Sidecar persistence failure: command completes with bounded output and an explicit warning.
6. Context truncation: both head and tail survive, including an artifact path placed at the end.
7. Existing process, tool executor, bash, context compaction, typecheck, and smoke suites remain green.

## Success Criteria

- No bash result can enter model history with more than 2,000 preview lines or approximately 50 KiB before context-window safeguards.
- Full output remains recoverable up to the configured 1 MiB sidecar limit, including content emitted after 256 KiB.
- The model always knows whether the artifact is complete, partial, or unavailable.
- Small-command behavior and current live-output rendering do not regress.
