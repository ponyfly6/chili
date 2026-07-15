# Streaming CLI Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound verbose bash results by both lines and bytes while preserving complete streamed output in a safe, searchable sidecar.

**Architecture:** Extract the existing sidecar filesystem rules into a shared storage module, then add a streaming process-output accumulator that receives raw chunks before `runProcess` drops them. Bash uses the accumulator only for verbose output; small output keeps its existing format. Context-window truncation changes from prefix-only to head/tail.

**Tech Stack:** Bun 1.3, TypeScript ESM, Node child processes and filesystem streams, colocated `bun:test` tests.

## Global Constraints

- Preview thresholds are 2,000 process-output lines and 50 KiB of UTF-8 output.
- Persisted output is capped at 1 MiB per call and 64 MiB per workspace directory.
- Persisted paths remain inside `.chili/tool-results` and reuse sanitized tool-call IDs.
- Small bash output preserves current stdout-then-stderr formatting.
- Persistence failure never turns a completed command into a failed tool call.
- No production change is written before its failing regression test is observed.

---

### Task 1: Shared safe sidecar storage

**Files:**
- Create: `packages/tools/src/tool-output-storage.ts`
- Modify: `packages/tools/src/executor.ts`
- Test: `packages/tools/src/enriched-tools.test.ts`

**Interfaces:**
- Produces: `persistToolOutput(cwd, callId, output, options?)` for post-process persistence.
- Produces: `StreamingToolOutputFile.open(cwd, callId, options?)`, `append(text)`, and `close()` for streaming persistence.
- Preserves: `PersistedOutput` metadata fields currently emitted by `ToolExecutor`.

- [ ] **Step 1: Add a failing test for an existing sidecar that must not be overwritten**

Register a tool whose result metadata already contains `outputPath`, pre-create that path with complete content, and return an oversized preview. Assert executor truncation preserves the existing file and metadata path.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test packages/tools/src/enriched-tools.test.ts --test-name-pattern "preserves an existing streamed output sidecar"`

Expected: FAIL because `ToolExecutor.processResult()` overwrites the existing file.

- [ ] **Step 3: Extract sidecar storage and preserve pre-persisted results**

Create these public signatures:

```ts
export const DEFAULT_MAX_PERSISTED_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PERSISTED_OUTPUT_DIRECTORY_BYTES = 64 * 1024 * 1024;

export interface PersistedOutput {
  relativePath: string;
  absolutePath: string;
  bytes: number;
  originalBytes: number;
  limitBytes: number;
  truncated: boolean;
}

export async function persistToolOutput(
  cwd: string,
  callId: ToolCallId,
  output: string,
  options?: { maxBytes?: number; maxDirectoryBytes?: number },
): Promise<PersistedOutput>;

export class StreamingToolOutputFile {
  static open(
    cwd: string,
    callId: ToolCallId,
    options?: { maxBytes?: number; maxDirectoryBytes?: number },
  ): Promise<StreamingToolOutputFile>;
  append(text: string): Promise<void>;
  close(): Promise<PersistedOutput>;
}
```

Move UTF-8-safe truncation, filename sanitization, workspace/symlink validation, directory locking, and oldest-first eviction out of `executor.ts`. In `processResult()`, when metadata already contains a string `outputPath`, truncate only the model-facing text and reuse the existing artifact metadata instead of calling `persistToolOutput` again.

- [ ] **Step 4: Run storage and executor tests and verify GREEN**

Run: `bun test packages/tools/src/enriched-tools.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit the storage refactor**

```bash
git add packages/tools/src/tool-output-storage.ts packages/tools/src/executor.ts packages/tools/src/enriched-tools.test.ts
git commit -m "refactor(tools): share tool output sidecar storage"
```

### Task 2: Stream raw process output before the legacy capture cap

**Files:**
- Create: `packages/tools/src/process-output-accumulator.ts`
- Modify: `packages/tools/src/process.ts`
- Test: `packages/tools/src/process.test.ts`
- Create test: `packages/tools/src/process-output-accumulator.test.ts`

**Interfaces:**
- Consumes: `StreamingToolOutputFile` from Task 1.
- Produces: `RunProcessOptions.onRawOutput?: (chunk: { stream; chunk }) => void | Promise<void>`.
- Produces: `ProcessOutputAccumulator.append()`, `finish()`, and `snapshot()`.

- [ ] **Step 1: Add failing raw-capture tests**

Add one test with `maxOutputBytes: 16` that emits more than 256 KiB plus `FINAL_CAPTURE_MARKER`; collect `onRawOutput` chunks and assert they contain the marker although `result.stdout` contains only the first 16 bytes. Add a second test whose callback awaits briefly and assert all bytes still arrive, proving async backpressure is awaited.

- [ ] **Step 2: Run the process tests and verify RED**

Run: `bun test packages/tools/src/process.test.ts --test-name-pattern "raw output"`

Expected: typecheck/test failure because `onRawOutput` is not defined or invoked.

- [ ] **Step 3: Add the raw-output hook**

Add:

```ts
export interface RunProcessRawOutputChunk {
  stream: RunProcessOutputStream;
  chunk: Buffer;
}

// RunProcessOptions
onRawOutput?: (chunk: RunProcessRawOutputChunk) => void | Promise<void>;
```

Pass the hook into each `collect()` call and execute `await onRawOutput?.({ stream, chunk })` before the prefix collector checks `storedBytes >= maxBytes`. Keep live-output dispatch unchanged.

- [ ] **Step 4: Run process tests and verify GREEN**

Run: `bun test packages/tools/src/process.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Add failing accumulator tests**

Test `seq 3000`-equivalent chunks with `maxLines: 2_000`, split UTF-8 chunks, interleaved streams, 50 KiB byte overflow, and a forced storage-open failure. Assert bounded tail output, accurate totals, a complete/partial/unavailable artifact state, and no replacement characters.

- [ ] **Step 6: Run accumulator tests and verify RED**

Run: `bun test packages/tools/src/process-output-accumulator.test.ts`

Expected: FAIL because the accumulator does not exist.

- [ ] **Step 7: Implement the accumulator**

Use this public contract:

```ts
export interface ProcessOutputSnapshot {
  preview: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | "lines_and_bytes" | null;
  totalLines: number;
  totalBytes: number;
  previewLines: number;
  previewBytes: number;
  outputPath?: string;
  persistedBytes?: number;
  persistedTruncated?: boolean;
  persistenceError?: string;
}

export class ProcessOutputAccumulator {
  constructor(options: {
    cwd: string;
    callId: ToolCallId;
    maxLines?: number;
    maxBytes?: number;
    maxPersistedBytes?: number;
    maxDirectoryBytes?: number;
  });
  append(update: RunProcessRawOutputChunk): Promise<void>;
  finish(): Promise<ProcessOutputSnapshot>;
}
```

Maintain one `StringDecoder` per stream. Buffer formatted segments until either threshold is crossed, then lazily open the sidecar, backfill segments, and append later text. Maintain a rolling tail no larger than twice the preview budgets, then apply UTF-8-safe tail truncation for the final preview. Catch persistence errors, stop attempting writes, and continue bounded capture.

- [ ] **Step 8: Run accumulator and process tests and verify GREEN**

Run: `bun test packages/tools/src/process-output-accumulator.test.ts packages/tools/src/process.test.ts`

Expected: all tests pass.

- [ ] **Step 9: Commit raw capture and accumulator**

```bash
git add packages/tools/src/process.ts packages/tools/src/process.test.ts packages/tools/src/process-output-accumulator.ts packages/tools/src/process-output-accumulator.test.ts
git commit -m "feat(tools): capture verbose process output safely"
```

### Task 3: Integrate bounded verbose output into bash

**Files:**
- Modify: `packages/tools/src/builtins/bash.ts`
- Test: `packages/tools/src/enriched-tools.test.ts`

**Interfaces:**
- Consumes: `RunProcessOptions.onRawOutput` and `ProcessOutputAccumulator` from Task 2.
- Produces: bash metadata for line/byte totals, truncation reason, artifact completeness, and path.

- [ ] **Step 1: Add the failing `seq 3000` integration test**

Execute bash with `seq 3000`. Assert output omits the first range, contains `1001` and `3000`, contains a truncation notice and `.chili/tool-results/...`, contains no more than 2,010 lines including framing, and the referenced sidecar contains `1\n2\n3` and `2998\n2999\n3000`.

- [ ] **Step 2: Add the failing over-256-KiB final-marker test**

Execute a Node command that prints more than 256 KiB then `FINAL_CAPTURE_MARKER`. Assert both the model preview and referenced sidecar contain the marker, while metadata reports original bytes above 256 KiB.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `bun test packages/tools/src/enriched-tools.test.ts --test-name-pattern "bash persists complete verbose output|bash limits verbose output by line count"`

Expected: `seq 3000` is returned in full and the final marker is absent from the current prefix-only capture.

- [ ] **Step 4: Wire the accumulator into bash**

Set bash preview constants to 2,000 lines and 50 KiB, and raise `maxResultOutputBytes` to 64 KiB. Add `onRawOutput` to `BashRunRequest`; the default runner forwards it to `runProcess`. Construct the accumulator from `context.cwd` and `context.callId`, finish it in both success and failure paths, and use its preview only when `snapshot.truncated` is true.

Format a leading notice that states one of:

```text
[command output truncated: showing the final X of Y lines / B bytes; full output saved to PATH]
[command output truncated: showing the final X of Y lines / B bytes; first N of M bytes saved to PATH]
[command output truncated: showing the final X of Y lines / B bytes; output could not be persisted: ERROR]
```

Attach `outputTruncated`, `outputPath`, `outputBytes`, `outputLines`, `outputPreviewBytes`, `outputPreviewLines`, `outputPersistedBytes`, and `outputPersistedTruncated` metadata when applicable.

- [ ] **Step 5: Run bash integration tests and verify GREEN**

Run: `bun test packages/tools/src/enriched-tools.test.ts packages/tools/src/process.test.ts packages/tools/src/process-output-accumulator.test.ts`

Expected: all tests pass.

- [ ] **Step 6: Commit bash integration**

```bash
git add packages/tools/src/builtins/bash.ts packages/tools/src/enriched-tools.test.ts
git commit -m "feat(tools): bound and persist verbose bash output"
```

### Task 4: Preserve tool-result tails in context

**Files:**
- Modify: `packages/core/src/context/window.ts`
- Test: `packages/core/src/context/compaction.test.ts`

**Interfaces:**
- Consumes: textual `ToolResultPart.output`.
- Produces: head/tail output within `maxToolResultChars`, with a stable omission marker.

- [ ] **Step 1: Add a failing head/tail truncation test**

Build a context with `maxToolResultChars: 120` and a tool result containing `HEAD_MARKER`, a long middle, and `artifact path: .chili/tool-results/call.txt` at the end. Assert both markers survive and the middle does not.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test packages/core/src/context/compaction.test.ts --test-name-pattern "preserves tool result head and tail"`

Expected: FAIL because prefix-only truncation removes the artifact path.

- [ ] **Step 3: Implement 25/75 head/tail truncation**

Replace prefix slicing with a helper that reserves marker overhead, assigns 25% of the remaining characters to the head and 75% to the tail, avoids splitting UTF-16 surrogate pairs, and returns no more than `maxToolResultChars` plus no hidden unbounded suffix.

- [ ] **Step 4: Run context tests and verify GREEN**

Run: `bun test packages/core/src/context/compaction.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit context truncation**

```bash
git add packages/core/src/context/window.ts packages/core/src/context/compaction.test.ts
git commit -m "fix(core): preserve tool output tails in context"
```

### Task 5: Full verification

**Files:**
- Verify only.

- [ ] **Step 1: Run focused regression suites**

Run: `bun test packages/tools/src/process-output-accumulator.test.ts packages/tools/src/process.test.ts packages/tools/src/enriched-tools.test.ts packages/core/src/context/compaction.test.ts`

Expected: zero failures.

- [ ] **Step 2: Run repository typecheck**

Run: `bun run typecheck`

Expected: exit code 0.

- [ ] **Step 3: Run complete unit tests**

Run: `bun test`

Expected: zero failures.

- [ ] **Step 4: Run complete smoke gate**

Run: `bun run smoke:all`

Expected: exit code 0 and all smoke groups report success.

- [ ] **Step 5: Inspect final diff and worktree state**

Run: `git diff HEAD~4 --check && git status --short`

Expected: no whitespace errors and no uncommitted files.
