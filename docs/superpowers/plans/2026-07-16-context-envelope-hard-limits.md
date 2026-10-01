# Context Envelope Hard Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure no untrusted metadata can suppress tool-output persistence and every individual value sent to a model has a deterministic hard limit.

**Architecture:** Replace `metadata.outputPath` control flow with an executor-owned persisted-output registration channel that validates an invocation-scoped sidecar on disk. Generate a unique internal artifact ID for every execution so repeated provider call IDs cannot overwrite earlier output. Extend `ContextWindowBuilder` into the final request-envelope normalizer: it returns bounded history plus a bounded prompt/tool surface, and `SingleAgentRuntime` sends only those returned values. Prompt fragments receive a default rendered-size ceiling before they reach the context builder.

**Tech Stack:** Bun 1.3, TypeScript ESM, `bun:test`, Node filesystem APIs.

## Global Constraints

- No production change is written before its regression test is observed failing.
- Tool-output sidecars must be the exact invocation-scoped path under `.chili/tool-results`, use an executor-generated artifact ID independent of provider call IDs, be a private regular file, and match the registered byte count.
- Public `ToolResult.metadata` is data only and never controls executor persistence.
- Text and structured JSON are truncated at valid UTF-16 boundaries; images are omitted whole when their encoded payload exceeds the limit.
- Oversized tool schemas are omitted from the model request rather than mutated into an invalid or misleading schema.
- Stored conversation events and registry definitions remain unchanged; limits apply to the cloned model-request envelope.

---

### Task 1: Authenticate and validate streamed output sidecars

**Files:**
- Modify: `packages/tools/src/types.ts`
- Modify: `packages/tools/src/tool-output-storage.ts`
- Modify: `packages/tools/src/process-output-accumulator.ts`
- Modify: `packages/tools/src/builtins/bash.ts`
- Modify: `packages/tools/src/executor.ts`
- Test: `packages/tools/src/enriched-tools.test.ts`
- Test: `packages/tools/src/tool-output-storage.test.ts`

- [x] **Step 1: Add failing executor regressions**

Add a tool that returns oversized output plus `metadata.outputPath = "../../not-created.txt"`. Assert the executor ignores the claim, persists the complete result to the call-scoped safe path, reports that safe path, and leaves no false-path success notice. Update the legitimate streamed-sidecar test so the tool registers a finalized sidecar through the execution context before returning its preview.

- [x] **Step 2: Run focused executor tests and verify RED**

Run: `bun test packages/tools/src/enriched-tools.test.ts --test-name-pattern "rejects forged persisted output metadata|preserves a registered streamed output sidecar"`

Expected: the forged-path test reports the attacker path or loses the omitted output, and the registration API does not exist.

- [x] **Step 3: Add call-scoped sidecar validation**

Define a structural persisted-output registration record in `types.ts`. Add a storage validator that derives the expected filename from `cwd + outputArtifactId`, rejects any different relative path, resolves the path inside the workspace, requires a private single-link regular file, checks `stat.size === bytes`, and validates `bytes`, `originalBytes`, `limitBytes`, and `truncated` relationships. Generate a fresh opaque artifact ID for every executor invocation and expose it only through the execution context so sequential provider call-ID reuse cannot overwrite an earlier artifact.

- [x] **Step 4: Replace metadata control flow with executor-owned registration**

Create one registration slot per `ToolExecutor.execute()` call. Expose a context callback that validates then stores exactly one finalized sidecar. Strip public persistence-path metadata from raw results, reattach it only from the validated registration, and use only that registration to skip post-result persistence. If no validated registration exists, persist the raw oversized output through `persistToolOutput()` as before.

- [x] **Step 5: Register Bash accumulator sidecars**

Carry the finalized `PersistedOutput` record in the accumulator snapshot. After `finish()`, Bash registers it through the execution context before returning model-facing metadata. Keep persistence failures non-fatal and keep existing line/byte preview behavior.

- [x] **Step 6: Run focused storage, accumulator, Bash, and executor tests**

Run: `bun test packages/tools/src/tool-output-storage.test.ts packages/tools/src/process-output-accumulator.test.ts packages/tools/src/enriched-tools.test.ts`

Expected: all pass.

---

### Task 2: Hard-limit every model-visible message field

**Files:**
- Modify: `packages/core/src/context/window.ts`
- Test: `packages/core/src/context/compaction.test.ts`

- [x] **Step 1: Add a failing complete-envelope message test**

Build messages containing oversized ordinary text, reasoning, tool-call input JSON, tool-result output, error, structured text content, direct image data, and tool-result image data. Configure small explicit limits. Assert every returned model-visible text/JSON field is within its cap, oversized images are replaced or omitted whole, input messages are not mutated, and estimates do not hide retained multi-megabyte payloads.

- [x] **Step 2: Run the focused context test and verify RED**

Run: `bun test packages/core/src/context/compaction.test.ts --test-name-pattern "hard-limits every model-visible message item"`

Expected: error/content/ordinary text/tool input and images remain oversized.

- [x] **Step 3: Normalize cloned message parts before budgeting**

Add configurable `maxMessagePartChars` and `maxImageDataChars` ceilings with finite defaults. Truncate text/reasoning/error/content text with surrogate-safe head/tail markers; replace oversized direct images with a bounded text notice; omit oversized tool-result image blocks and add a bounded text notice; replace oversized tool-call inputs with a bounded JSON-safe omission value. Preserve IDs, call IDs, roles, ordering, and original stored objects.

- [x] **Step 4: Keep tool-result accounting consistent**

Count truncations across output, error, and structured content, ensure compacted results cannot reintroduce an unbounded error, and make char/token estimates operate on the normalized request copy.

- [x] **Step 5: Run context tests and verify GREEN**

Run: `bun test packages/core/src/context/compaction.test.ts`

Expected: all pass.

---

### Task 3: Hard-limit prompt fragments and the fixed request surface

**Files:**
- Modify: `packages/core/src/prompt/fragment.ts`
- Modify: `packages/core/src/prompt/assembler.ts`
- Modify: `packages/core/src/context/window.ts`
- Modify: `packages/core/src/single-agent-runtime.ts`
- Test: `packages/core/src/prompt/assembler.test.ts`
- Test: `packages/core/src/context/compaction.test.ts`

- [x] **Step 1: Add failing prompt and surface regressions**

Assert a fragment without an explicit `maxChars` is still bounded including its marker wrapper. Build a context surface with oversized system, developer, contextual-user, tool description, and tool schema values; assert `ContextBuildResult.surface` contains bounded strings, a bounded description, and omits the oversized-schema tool. Add a runtime test that captures `ModelStreamInput` and proves the model receives the returned bounded surface rather than the original arrays and registry objects.

- [x] **Step 2: Run focused tests and verify RED**

Run: `bun test packages/core/src/prompt/assembler.test.ts packages/core/src/context/compaction.test.ts --test-name-pattern "default hard limit|hard-limits fixed request surface|sends bounded request surface"`

Expected: fragments and surface values remain unbounded, and runtime forwards originals.

- [x] **Step 3: Apply a default rendered fragment ceiling**

Export a finite default fragment limit. Make every rendered fragment use `fragment.maxChars ?? default`, count marker open/close text inside the same ceiling, and preserve an explicit smaller limit.

- [x] **Step 4: Return a normalized fixed surface**

Add configurable `maxPromptItemChars` and `maxToolDefinitionChars`. Clone and truncate each fixed prompt string. Clone tool definitions with bounded names/descriptions; serialize schemas safely and omit any definition whose schema or complete model-facing definition exceeds the tool-definition cap. Return this surface in every `ContextBuildResult`, including overflow results, and estimate budgets from it.

- [x] **Step 5: Send only the normalized surface**

Update initial, post-compaction, and recovery model inputs in `SingleAgentRuntime` to use `context.surface.system`, `.developer`, `.contextualUser`, and `.tools`. Keep execution registry visibility unchanged so limiting model schema exposure does not mutate tool registration.

- [x] **Step 6: Run prompt, context, and runtime tests**

Run: `bun test packages/core/src/prompt/assembler.test.ts packages/core/src/context/compaction.test.ts packages/core/src/runtime-control-flow.test.ts`

Expected: all pass.

---

### Task 4: Verify the complete change and record it

**Files:**
- Modify: `docs/superpowers/plans/2026-07-16-context-envelope-hard-limits.md`

- [x] **Step 1: Run formatting/diff checks**

Run: `git diff --check`

Expected: no output.

- [x] **Step 2: Run all unit tests**

Run: `bun test`

Expected: all tests pass.

- [x] **Step 3: Run workspace typecheck**

Run: `bun run typecheck`

Expected: all projects pass.

- [x] **Step 4: Run the full smoke gate**

Run: `bun run smoke:all`

Expected: all smoke suites pass.

- [x] **Step 5: Review the final diff and commit**

Confirm no unrelated user changes are included, mark this plan complete, and commit with an imperative scoped subject.
