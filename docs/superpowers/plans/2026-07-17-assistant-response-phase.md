# Assistant Response Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkboxes so progress can be tracked precisely.

**Goal:** Preserve OpenAI Responses assistant `phase` metadata from SSE ingestion through persistence and projection so the TUI visibly distinguishes intermediate commentary from the final answer without heuristics or compatibility fallbacks.

**Architecture:** Add a shared assistant phase type to protocol text parts, make the OpenAI Codex provider strictly validate and emit phase per output item, and have the runtime retain distinct indexed text parts with immutable phases. The SDK and TUI then project and render that explicit metadata only: commentary is muted with `↳ `, final answers use `🌶️: `, and phase-less text is visibly unclassified as `Assistant: `.

**Tech Stack:** Bun, TypeScript ESM, OpenAI Responses SSE, event-sourced runtime/store, OpenTUI React, Bun tests.

## Global Constraints

- Do not infer phase from tool calls, message position, streaming state, completion state, or text content.
- Do not repair, promote, or silently default missing/invalid Codex phase values.
- A Codex text delta without a previously declared phased message output item is a provider protocol error.
- A single assistant message may contain several text parts; preserve their output-index ordering and phases independently.
- Other providers remain allowed to emit phase-less text. The TUI must label it `Assistant: ` and must never show the chili final marker for it.
- Preserve the user's unrelated changes in `apps/cli/src/approval.ts` and `apps/cli/src/approval.test.ts`.
- Use `apply_patch` for source and test edits. Follow red-green-refactor: observe each focused test fail for the intended reason before implementing its production change.

---

## Task 1: Define the shared phase contract and enforce it at the Codex stream boundary

**Files:**

- Modify: `packages/protocol/src/message.ts`
- Modify: `packages/providers/src/types.ts`
- Modify: `packages/core/src/runtime.ts`
- Test: `packages/providers/src/openai-codex.test.ts`
- Modify: `packages/providers/src/openai-codex.ts`

- [ ] Add provider tests whose SSE contains two `message` output items (`commentary`, then `final_answer`) and assert every `text_delta` carries the matching `index` and `phase`.
- [ ] Add provider tests asserting rejection for: a message item with missing phase, a message item with an unknown phase, a text delta whose output index was never declared as a message, and a conflicting phase for the same output index.
- [ ] Update existing successful Codex SSE fixtures so every text-producing output item declares its real phase; do not insert synthetic phase declarations inside production code.
- [ ] Run `bun test packages/providers/src/openai-codex.test.ts` and confirm failures show that phase is not parsed or validated yet.
- [ ] Export `AssistantMessagePhase = "commentary" | "final_answer"` from `packages/protocol/src/message.ts`; add `phase?: AssistantMessagePhase` to `TextPart` and both duplicated `ModelTextDeltaEvent` contracts.
- [ ] Extend `CodexOutputItem` with `phase`, validate it with one strict helper, and track message phases by `output_index` inside `streamSseResponse`.
- [ ] On `response.output_item.added`, require a numeric output index and a valid phase for every `message` item; reject conflicting redeclarations. On text/refusal delta, require a previously declared phase and emit it on `text_delta`.
- [ ] Run the focused provider test until green, then run `bun run typecheck` to expose downstream call sites that need the new metadata but make no heuristic changes yet.
- [ ] Commit only Task 1 files with subject `feat(provider): preserve Codex response phases`.

## Task 2: Preserve phased assistant history exactly in Responses input

**Files:**

- Test: `packages/providers/src/openai-codex.test.ts`
- Modify: `packages/providers/src/openai-codex.ts`

- [ ] Add a request-body test with assistant parts ordered as commentary text, tool call, and final-answer text. Assert the request contains two distinct assistant message input items with their exact phases, with the function call left in its original relative position.
- [ ] Add a request-body test asserting that Codex history serialization rejects an assistant text part with no phase. Include a tool-call-only assistant message to prove phase is required only for assistant text.
- [ ] Run `bun test packages/providers/src/openai-codex.test.ts` and confirm the current merged assistant text request fails both ordering and strictness expectations.
- [ ] Replace assistant `messageText(...)` merging in `toResponsesInput` with ordered per-part serialization. Emit one assistant message item per text part, include `phase`, and throw for missing/invalid phase before issuing the request.
- [ ] Run the focused provider tests until green.
- [ ] Commit Task 2 files with subject `fix(provider): replay phased assistant history`.

## Task 3: Store independent indexed text parts in the runtime

**Files:**

- Test: `packages/core/src/runtime-control-flow.test.ts`
- Modify: `packages/core/src/single-agent-runtime.ts`

- [ ] Add a runtime test model that emits interleaved deltas for index 0 commentary and index 2 final answer. Assert the stored assistant message has two text parts in first-seen order, concatenated per index, with their exact phases.
- [ ] Add a runtime test where the same text index changes phase mid-stream and assert the turn fails instead of mutating or splitting the existing part.
- [ ] Run `bun test packages/core/src/runtime-control-flow.test.ts` and confirm the current single `textPartId` implementation collapses the output and loses phase.
- [ ] Replace `AssistantStreamState.textPartId` with `textParts: Map<number, { partId: PartId; phase?: AssistantMessagePhase }>`.
- [ ] Pass `event.index` and `event.phase` into `appendTextDelta`; create one text part per normalized index and persist its phase. Reject a later delta whose phase differs from the first delta for that index.
- [ ] Ensure retry state is fresh per attempt and existing generic phase-less provider streams still form a phase-less text part without manufacturing metadata.
- [ ] Run the focused runtime test until green, then run all core tests with `bun test packages/core/src`.
- [ ] Commit Task 3 files with subject `feat(core): retain indexed assistant phases`.

## Task 4: Verify phase survives event persistence and SDK projection

**Files:**

- Test: `packages/store/src/sqlite-event-store.test.ts`
- Test: `packages/sdk/src/projection.test.ts`
- Modify: `packages/sdk/src/projection.ts`

- [ ] Add a SQLite event-store round-trip test for a `message.part_added` text part with `phase: "commentary"`; assert the loaded event payload preserves it unchanged.
- [ ] Add an SDK projection test containing commentary, final-answer, and phase-less text parts; assert `chatSessionView` copies exact phase values only where present.
- [ ] Run the focused store and SDK tests. The projection assertion must fail because `ChatMessagePart` currently drops phase; the store round-trip should document that no migration or compatibility transform is required.
- [ ] Add optional `phase?: AssistantMessagePhase` to the SDK text variant and copy `part.phase` in `chatMessagePart` using the existing optional-field convention.
- [ ] Run `bun test packages/store/src/sqlite-event-store.test.ts packages/sdk/src/projection.test.ts` until green.
- [ ] Commit Task 4 files with subject `feat(sdk): project assistant response phases`.

## Task 5: Replace TUI trace heuristics with phase-driven presentation

**Files:**

- Test: `apps/tui/src/chat/presentation.test.ts`
- Modify: `apps/tui/src/chat/presentation.ts`

- [ ] Add presentation tests for one assistant message containing commentary, a tool call, and a final answer. Assert both text items retain their phases and the final answer remains visible when `hideThinking` is enabled.
- [ ] Add a `hideThinking` test asserting only explicit commentary and reasoning are collapsed, while phase-less text remains visible and unclassified.
- [ ] Add a regression test showing the presence of a tool call and a running stream does not determine whether assistant text is hidden.
- [ ] Run `bun test apps/tui/src/chat/presentation.test.ts` and confirm the existing tool/stream heuristic hides the wrong text and drops phase.
- [ ] Add `phase?: AssistantMessagePhase` to the `assistant_text` display item.
- [ ] Remove `hideStreamingAssistantText` and `hideAssistantTrace`. When `hideThinking` is true, collapse only reasoning parts and text parts whose phase is exactly `commentary`; do not inspect tool calls or streaming state to classify text.
- [ ] Preserve phase when producing visible assistant text display items. The hidden-thinking item is active only when the hidden explicit commentary/reasoning belongs to a currently streaming message.
- [ ] Run the focused presentation tests until green.
- [ ] Commit Task 5 files with subject `fix(tui): classify assistant text by phase`.

## Task 6: Render commentary, final answers, and unclassified text distinctly

**Files:**

- Test: `apps/tui/src/chat/AssistantCells.test.tsx`
- Test: `apps/tui/src/chat/MessageList.test.tsx`
- Modify: `apps/tui/src/chat/AssistantCells.tsx`
- Modify: `apps/tui/src/chat/MessageList.tsx`

- [ ] Add line-model tests asserting exact prefixes: commentary `↳ `, final answer `🌶️: `, phase-less `Assistant: `. Assert commentary/unclassified text never contains the chili marker.
- [ ] Add rendered-cell tests asserting commentary uses the muted text color while final and unclassified text use the normal assistant text color.
- [ ] Add a MessageList integration test with all three phase states and assert their rendered prefixes and ordering.
- [ ] Run `bun test apps/tui/src/chat/AssistantCells.test.tsx apps/tui/src/chat/MessageList.test.tsx` and confirm the hard-coded chili prefix fails the new cases.
- [ ] Introduce one explicit assistant text presentation mapping from phase to `{ prefix, tone }`; use it for both fallback line generation and component rendering so the paths cannot diverge.
- [ ] Parameterize `AssistantMarkdownCell`, `assistantTextCellLines`, markdown foreground, and syntax style by the mapped tone. Do not infer from `streaming` or cell position.
- [ ] Pass `item.phase` from `MessageList` to both line and component paths.
- [ ] Run the focused TUI tests until green.
- [ ] Commit Task 6 files with subject `feat(tui): distinguish commentary from final answers`.

## Task 7: Expose phase in the diagnostic transcript

**Files:**

- Test: `apps/tui/src/chat/transcript.test.ts`
- Modify: `apps/tui/src/chat/transcript.ts`

- [ ] Add a transcript test asserting phased text-part headers include `phase=commentary` or `phase=final_answer`, while a phase-less header explicitly includes `phase=unclassified`.
- [ ] Run `bun test apps/tui/src/chat/transcript.test.ts` and confirm the diagnostic transcript omits classification.
- [ ] Update text part labels to print the exact stored phase, using only the diagnostic label `unclassified` when metadata is absent; do not write it back into the model.
- [ ] Run the focused transcript test until green.
- [ ] Commit Task 7 files with subject `chore(tui): show assistant phase in transcript`.

## Task 8: End-to-end verification and cleanup

**Files:**

- Review: all files changed in Tasks 1-7
- Update if necessary: colocated tests only

- [ ] Run `git diff --check` and inspect `git diff --stat` plus `git status --short` to verify only intended files are staged/changed and the two pre-existing CLI edits are untouched.
- [ ] Run focused phase tests together: `bun test packages/providers/src/openai-codex.test.ts packages/core/src/runtime-control-flow.test.ts packages/store/src/sqlite-event-store.test.ts packages/sdk/src/projection.test.ts apps/tui/src/chat/presentation.test.ts apps/tui/src/chat/AssistantCells.test.tsx apps/tui/src/chat/MessageList.test.tsx apps/tui/src/chat/transcript.test.ts`.
- [ ] Run the required repository gates fresh: `bun run typecheck`, `bun test`, and `bun run smoke:all`.
- [ ] If a gate fails, diagnose and fix only regressions caused by this change, add or refine the smallest behavioral test, and rerun every affected gate.
- [ ] Review for forbidden fallback patterns (`last`, tool-call presence, completion, stream state, defaulting to final) with `rg` across the changed provider/core/TUI files.
- [ ] Confirm the full chain manually from a captured synthetic SSE: phased output item → phased delta → distinct persisted text parts → phased SDK row → `↳ ` commentary and `🌶️: ` final answer.
- [ ] Commit any verification-only test cleanup with subject `test: cover assistant response phase chain`.
