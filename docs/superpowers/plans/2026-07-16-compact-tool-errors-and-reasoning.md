# Compact Tool Errors and Reasoning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace exploration error walls with compact semantic failures and preserve/render reasoning summary sections without raw Markdown leakage.

**Architecture:** Keep raw tool errors unchanged in the existing details model, but add exploration-specific compact summaries and group-level disclosure. Preserve provider reasoning section identity by mapping Codex `summary_index` values onto the existing model event `index`, then keep one core `ReasoningPart` per index. Reuse Chili's Markdown renderer for Thinking subjects and expanded bodies.

**Tech Stack:** Bun 1.3, TypeScript ESM, OpenTUI React, `marked`, colocated `bun:test` tests.

## Global Constraints

- Compact exploration groups show at most the first semantic failure plus one `+N more failures` line.
- Compact exploration output never contains raw `ENOENT`, stack traces, or repeated `error:` blocks.
- Original tool errors remain unchanged and visible when `showToolDetails` is true.
- The group `N failed` count includes only `displayStatus === "failed"`.
- Providers without a reasoning event index continue using one reasoning part.
- Persisted protocol and SDK schemas do not change.
- Compact Thinking never renders literal Markdown emphasis markers.
- No production change is written before its failing regression test is observed.

---

### Task 1: Semantic exploration failures and display paths

**Files:**
- Modify: `apps/tui/src/chat/tool-renderers.ts`
- Test: `apps/tui/src/chat/tool-renderers.test.ts`

**Interfaces:**
- Extends: `ToolRenderInput` with `cwd?: string`.
- Produces: exploration-specific `compactErrorLines` containing one semantic line.
- Produces: `displayToolPath(value, cwd, maxLength?)` behavior through renderer output.

- [ ] **Step 1: Write failing renderer tests**

Add a table-driven test for `read`, `grep`, and `glob` with an absolute workspace target and raw `ENOENT`. Pass `cwd: "/repo"`; assert compact output is exactly `File not found: app/example.php`, omits `ENOENT` and `/repo/`, and details mode still contains the original error. Add a home-path case constructed with `homedir()` and a path longer than 96 characters; assert the former starts with `~/` and both retain the filename.

```ts
for (const toolName of ["read", "grep", "glob"]) {
  const compact = renderToolActivity(toolInput({
    toolName,
    cwd: "/repo",
    status: "failed",
    displayStatus: "failed",
    inputSummary: { title: toolName, path: "/repo/app/example.php", scope: "/repo/app/example.php" },
    error: "ENOENT: no such file or directory, lstat '/repo/app/example.php'",
  }));
  expect(compact.compactErrorLines).toEqual(["File not found: app/example.php"]);
}
```

- [ ] **Step 2: Run the renderer test and verify RED**

Run: `bun test apps/tui/src/chat/tool-renderers.test.ts --test-name-pattern "semantic exploration failures"`

Expected: FAIL because exploration renderers still expose the raw exception.

- [ ] **Step 3: Implement semantic compact errors**

Add `cwd?: string` to `ToolRenderInput`. Give `readRenderer`, `searchRenderer`, and `listRenderer` a `compactErrorLines` callback that calls:

```ts
function explorationCompactErrorLines(input: ToolRenderInput, action: "Read" | "Search" | "List"): string[] | undefined {
  if (!isFailedDisplayStatus(input.displayStatus) && !input.error) return undefined;
  const target = displayToolPath(
    input.inputSummary.path ?? input.inputSummary.scope ?? input.inputSummary.pattern ?? input.inputSummary.detail ?? "target",
    input.cwd,
  );
  const error = input.error ?? input.output ?? "";
  if (/\bENOENT\b|no such file or directory/i.test(error)) return [`File not found: ${target}`];
  if (/\b(?:EACCES|EPERM)\b|permission denied/i.test(error)) return [`Permission denied: ${target}`];
  if (/timed?\s*out|timeout/i.test(error)) return [`${action} timed out: ${target}`];
  if (input.displayStatus === "rejected") return [`${action} rejected: ${target}`];
  if (input.displayStatus === "cancelled") return [`${action} cancelled: ${target}`];
  return [`${action} failed: ${target}`];
}
```

Implement `displayToolPath` with `node:path` relative-path checks, `node:os` home shortening, slash normalization, and middle elision that preserves the final path component. Do not parse a path out of the exception.

- [ ] **Step 4: Run renderer tests and verify GREEN**

Run: `bun test apps/tui/src/chat/tool-renderers.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit semantic renderer behavior**

```bash
git add apps/tui/src/chat/tool-renderers.ts apps/tui/src/chat/tool-renderers.test.ts
git commit -m "fix(tui): summarize exploration tool errors"
```

### Task 2: Group failures without repeating raw errors

**Files:**
- Modify: `apps/tui/src/chat/presentation.ts`
- Modify: `apps/tui/src/chat/ToolCells.tsx`
- Modify: `apps/tui/src/chat/MessageList.tsx`
- Test: `apps/tui/src/chat/presentation.test.ts`
- Test: `apps/tui/src/chat/ToolCells.test.tsx`
- Test: `apps/tui/src/chat/MessageList.test.tsx`

**Interfaces:**
- Consumes: semantic activity `compactErrorLines` from Task 1.
- Extends: `ToolGroupMetadata` with `failedCount` and optional `compactFailureLines`.
- Extends: `BuildOptions` with `cwd?: string` and forwards it to tool renderers.

- [ ] **Step 1: Write the failing three-failure regression test**

Create three failed read/search/list rows with different absolute paths and raw `ENOENT` messages, followed by one successful exploration call. Render compact and details modes with `cwd: "/repo"`.

```ts
expect(compact).toContain("· 3 failed");
expect(compact).toContain("File not found: app/first.php");
expect(compact).toContain("+2 more failures (Ctrl+O for details)");
expect(compact).not.toContain("ENOENT");
expect(compact).not.toContain("/repo/app/second.php");
expect(occurrences(compact, "error:")).toBe(0);
expect(details).toContain("/repo/app/first.php");
expect(details).toContain("/repo/app/second.php");
expect(details).toContain("/repo/app/third.php");
```

Update the presentation and ToolCells unit expectations to assert one group-level semantic line and one remainder line.

- [ ] **Step 2: Run focused group tests and verify RED**

Run: `bun test apps/tui/src/chat/presentation.test.ts apps/tui/src/chat/ToolCells.test.tsx apps/tui/src/chat/MessageList.test.tsx --test-name-pattern "exploration|group failures"`

Expected: FAIL because the label says `with errors` and every child error is rendered.

- [ ] **Step 3: Build group-level failure metadata**

Pass `cwd` from `MessageList` to `buildChatDisplayItems`, then through `toolActivityFromRow`, `fallbackToolResultActivity`, and `toolActivity` into `renderToolActivity`.

Compute group metadata as:

```ts
const failed = activities.filter((activity) => activity.displayStatus === "failed");
const compactFailureLines = failed.flatMap((activity) => activity.compactErrorLines ?? []).slice(0, 1);
if (compactFailureLines.length > 0) {
  compactFailureLines[0] = failed.length === 1
    ? `${compactFailureLines[0]} (Ctrl+O for details)`
    : compactFailureLines[0];
  if (failed.length > 1) compactFailureLines.push(`+${failed.length - 1} more failures (Ctrl+O for details)`);
}
```

Set `failedCount: failed.length` and retain `errorCount` for all error-tone statuses. Build the status suffix from exact display statuses:

```ts
const statusParts = [
  countStatus(activities, "failed", "failed"),
  countStatus(activities, "rejected", "rejected"),
  countStatus(activities, "cancelled", "cancelled"),
].filter((part): part is string => part !== undefined);
const suffix = statusParts.length > 0 ? ` · ${statusParts.join(", ")}` : "";
```

`countStatus` returns `${count} ${label}` only when the count is positive. This keeps rejected/cancelled calls out of the failed count.

- [ ] **Step 4: Render only group-level compact failures**

In `toolGroupCellLines`, render `group.metadata.compactFailureLines` as red `  ↳ ...` lines immediately after the group label. Remove the loop that renders each child's compact error. Keep the existing child label/details loop so details mode still renders every original error.

For an ungrouped failed exploration tool, change `toolCompactSupplementLines` to render the semantic line as `  ↳ ... (Ctrl+O for details)` without an `error:` heading.

- [ ] **Step 5: Run group tests and verify GREEN**

Run: `bun test apps/tui/src/chat/presentation.test.ts apps/tui/src/chat/ToolCells.test.tsx apps/tui/src/chat/MessageList.test.tsx`

Expected: all tests pass.

- [ ] **Step 6: Commit compact group disclosure**

```bash
git add apps/tui/src/chat/presentation.ts apps/tui/src/chat/ToolCells.tsx apps/tui/src/chat/MessageList.tsx apps/tui/src/chat/presentation.test.ts apps/tui/src/chat/ToolCells.test.tsx apps/tui/src/chat/MessageList.test.tsx
git commit -m "fix(tui): collapse exploration failure details"
```

### Task 3: Preserve reasoning summary section identity

**Files:**
- Modify: `packages/providers/src/openai-codex.ts`
- Test: `packages/providers/src/openai-codex.test.ts`
- Modify: `packages/core/src/single-agent-runtime.ts`
- Test: `packages/core/src/runtime-control-flow.test.ts`

**Interfaces:**
- Preserves: existing `ModelReasoningDeltaEvent.index?: number`.
- Changes: `AssistantStreamState.reasoningPartId` to `reasoningPartIds: Map<number, PartId>`.
- Leaves: protocol `ReasoningPart` and SDK projection unchanged.

- [ ] **Step 1: Write the failing Codex provider section test**

Feed one reasoning item with four `response.reasoning_summary_text.delta` events using `summary_index` values `0, 0, 1, 1` and the same `output_index`. Assert emitted reasoning indexes are `[0, 0, 1, 1]` and joined text by index forms two headers.

- [ ] **Step 2: Run the provider test and verify RED**

Run: `bun test packages/providers/src/openai-codex.test.ts --test-name-pattern "preserves reasoning summary sections"`

Expected: FAIL with indexes `[0, 0, 0, 0]`.

- [ ] **Step 3: Map Codex section keys to stable event indexes**

Add `summary_index?: number` to `CodexStreamPayload`. Inside `stream`, maintain `Map<string, number>` and allocate a sequential index for `${item_id ?? output_index}:${summary_index ?? 0}`. Emit that stable value as the existing reasoning event `index`.

- [ ] **Step 4: Run the provider test and verify GREEN**

Run: `bun test packages/providers/src/openai-codex.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Write the failing core part-boundary test**

Stream two deltas at index 0 and two at index 1:

```ts
yield { type: "reasoning_delta", index: 0, text: "**Inspecting " };
yield { type: "reasoning_delta", index: 0, text: "core**" };
yield { type: "reasoning_delta", index: 1, text: "**Checking " };
yield { type: "reasoning_delta", index: 1, text: "schema**" };
```

Assert `reasoningParts(store).map((part) => part.text)` equals `['**Inspecting core**', '**Checking schema**']`.

- [ ] **Step 6: Run the core test and verify RED**

Run: `bun test packages/core/src/runtime-control-flow.test.ts --test-name-pattern "keeps indexed reasoning sections separate"`

Expected: FAIL because the runtime creates one concatenated part.

- [ ] **Step 7: Store one reasoning PartId per index**

Initialize `reasoningPartIds: new Map()` in `AssistantStreamState`. Pass `event.index` into `appendReasoningDelta`; look up `const index = eventIndex ?? 0`, create a new reasoning part when absent, and append later deltas to the PartId stored for that index.

- [ ] **Step 8: Run provider and core tests and verify GREEN**

Run: `bun test packages/providers/src/openai-codex.test.ts packages/core/src/runtime-control-flow.test.ts`

Expected: all tests pass.

- [ ] **Step 9: Commit reasoning boundaries**

```bash
git add packages/providers/src/openai-codex.ts packages/providers/src/openai-codex.test.ts packages/core/src/single-agent-runtime.ts packages/core/src/runtime-control-flow.test.ts
git commit -m "fix(core): preserve reasoning summary sections"
```

### Task 4: Render compact Thinking subjects and Markdown details

**Files:**
- Modify: `apps/tui/src/chat/MessageList.tsx`
- Test: `apps/tui/src/chat/MessageList.test.tsx`

**Interfaces:**
- Consumes: separate reasoning parts from Task 3.
- Consumes: existing `markdownToTerminalLines`.
- Uses: existing `showToolDetails` as the global reasoning details toggle.

- [ ] **Step 1: Write failing compact and detailed Thinking tests**

Render two reasoning parts: `**Inspecting core**\n\nReading runtime state.` and `**Checking schema**\n\nComparing migrations.`. Assert compact mode contains two clean `Thinking:` subjects, contains neither body, `**`, nor `****`; assert details mode contains both body lines and still contains no literal emphasis markers.

- [ ] **Step 2: Run the Thinking test and verify RED**

Run: `bun test apps/tui/src/chat/MessageList.test.tsx --test-name-pattern "Thinking subjects"`

Expected: FAIL because compact mode flattens the complete raw Markdown part.

- [ ] **Step 3: Add compact subject and detailed Markdown rendering**

Pass `showToolDetails` into `displayItemCell` and `reasoningLines`. For compact mode, call `markdownToTerminalLines` with width 180 and choose the first non-blank rendered line before applying `shorten`. For details mode, render all Markdown lines with `prefix: "Thinking: "` and map their terminal line models to the muted theme color. Preserve the current hidden bubble branch exactly.

- [ ] **Step 4: Run the Thinking and keyboard visibility tests and verify GREEN**

Run: `bun test apps/tui/src/chat/MessageList.test.tsx apps/tui/src/opentui-keyboard.test.tsx --test-name-pattern "Thinking|thinking|details"`

Expected: all selected tests pass.

- [ ] **Step 5: Commit Thinking disclosure**

```bash
git add apps/tui/src/chat/MessageList.tsx apps/tui/src/chat/MessageList.test.tsx
git commit -m "fix(tui): render reasoning summaries cleanly"
```

### Task 5: Budget tool previews by rendered terminal rows

**Files:**
- Modify: `apps/tui/src/chat/lines.tsx`
- Modify: `apps/tui/src/chat/ToolCells.tsx`
- Modify: `apps/tui/src/chat/tool-renderers.ts`
- Test: `apps/tui/src/chat/ToolCells.test.tsx`
- Test: `apps/tui/src/chat/tool-renderers.test.ts`

**Interfaces:**
- Extends: `detailPreviewLines(..., maxContentRows?)`, defaulting to five content rows.
- Preserves: unlimited textual fallback for code/diff bodies by passing `Number.POSITIVE_INFINITY`.

- [ ] **Step 1: Write failing visual-row and head/tail tests**

Create one 200-character error line at width 24 and assert its rendered content occupies at most five rows with a middle `… +N lines` marker. Create seven logical output lines and assert the renderer model preserves lines 1-2 and 6-7 with a middle omission line instead of keeping only lines 1-5.

- [ ] **Step 2: Run preview tests and verify RED**

Run: `bun test apps/tui/src/chat/ToolCells.test.tsx apps/tui/src/chat/tool-renderers.test.ts --test-name-pattern "visual row|head and tail"`

Expected: FAIL because truncation is prefix-only and happens before wrapping.

- [ ] **Step 3: Implement head/tail logical previews**

Change `previewTextLines` so overflow uses `headCount = Math.ceil((maxLines - 1) / 2)`, `tailCount = maxLines - headCount - 1`, and inserts `… +N lines` between the retained head and tail. Apply `shortenLine` to retained source lines only.

- [ ] **Step 4: Implement rendered-row clipping**

In `detailPreviewLines`, wrap all content first, then when it exceeds `maxContentRows`, retain the first and last rows with a middle omission row. Mark the label truncated when either source truncation or rendered-row clipping occurred. Reuse the same row clipper from `detailPreviewLinesWithTones`, preserving each retained row's tone. Pass infinity from diff/code fallback calls.

- [ ] **Step 5: Run preview and TUI tests and verify GREEN**

Run: `bun test apps/tui/src/chat/tool-renderers.test.ts apps/tui/src/chat/ToolCells.test.tsx apps/tui/src/chat/MessageList.test.tsx`

Expected: all tests pass.

- [ ] **Step 6: Commit viewport-aware previews**

```bash
git add apps/tui/src/chat/lines.tsx apps/tui/src/chat/ToolCells.tsx apps/tui/src/chat/tool-renderers.ts apps/tui/src/chat/ToolCells.test.tsx apps/tui/src/chat/tool-renderers.test.ts
git commit -m "fix(tui): bound tool previews by screen rows"
```

### Task 6: Integrated verification

**Files:**
- Verify only.

**Interfaces:**
- Verifies all prior tasks against the approved design.

- [ ] **Step 1: Run focused regression suites**

Run: `bun test apps/tui/src/chat/tool-renderers.test.ts apps/tui/src/chat/presentation.test.ts apps/tui/src/chat/ToolCells.test.tsx apps/tui/src/chat/MessageList.test.tsx packages/providers/src/openai-codex.test.ts packages/core/src/runtime-control-flow.test.ts`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run the complete unit suite**

Run: `bun test`

Expected: all tests pass with zero failures.

- [ ] **Step 3: Run TypeScript project references**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 4: Run the complete fake-model smoke gate**

Run: `bun run smoke:all`

Expected: every smoke phase passes.

- [ ] **Step 5: Review the final diff against the design**

Confirm compact groups contain at most two failure lines, details retain raw diagnostics, reasoning sections remain separate, Thinking is Markdown-clean, and no unrelated files changed.
