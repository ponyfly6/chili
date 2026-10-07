# Context and model execution contract

Implemented in the shared `SingleAgentRuntime`, reached by Host, CLI and child
session execution. This document describes the October 2026 foundation changes;
model quality still requires separate live-model acceptance.

## Tool identities and preparation

Every model tool call receives a new internal `callId`, including streamed calls.
The provider's original protocol identifier is recorded as `providerCallId` and
never used as a global SQLite key. Call and result parts retain both identities.
Old history without the extra field retains its old protocol mapping. Provider
adapters pair calls/results using internal IDs and apply protocol-safe handling
for repeated external IDs in one replay request.

The scheduler calls `ToolExecutor.prepare` once, then uses that prepared call for
concurrency classification and execution. Invalid arguments become a failed tool
result; unexpected preparation failures stop further dispatch. The executor owns
latest-policy and target-revision checks at the effect boundary. A registry
revision change after model advertisement rejects the stale call and asks the
next model turn to use refreshed definitions. This is deliberately conservative:
an unrelated catalog change may also invalidate an in-flight request.

Program results are durable `ToolResultPart.structuredData`. The model context
projection excludes that channel, and only bounds the model output/content
preview. Reading the stored message preserves the program data. Large program
results remain subject to executor storage bounds; a model preview limit cannot
silently mutate them.

## The actual request is the inspection record

Immediately before each `ModelRouter.stream` attempt, including compression and
verification requests, the runtime persists `model.request_prepared`. It contains
JSON snapshots of the selected messages, prompt materials, tool schemas, model
selection, controls, budget, source hashes and inclusion/omission reasons. No
handler or credential is stored in the tool schema snapshot. A content hash
identifies the preparation version; `sourceEventId` locates the session event
boundary. `sessionRevision` is a message/part count, not an optimistic-lock token.
Historical requests may contain creation-time execution identity metadata;
new requests do not copy the session's historical environment bindings.

When an adapter has resolved the actual account and passed its concurrency gate,
it records `model.request_identity` before network dispatch, with the matching
request ID and attempt. This is the effective provider/model/account/version
record; a requested model name alone does not identify the account. The callback
must complete before network dispatch. Credential values are never part of it.

Inspecting a session without hypothetical turn text returns the latest stored
request and merges its actual identity. Inspecting with text remains a preview.
Changing rules, Memory, tools or model settings later does not rewrite an old
request. The snapshot is the shared adapter input, rather than a claim to store
provider-specific HTTP serialization or reproduce a nondeterministic response.
Transport surfaces compact request events to metadata; full content is obtained
through explicit inspection, not repeatedly pushed through the live UI stream.

## Authority and long-session recovery

Prompt assembly enforces roles: only fragments marked as host/system authority
can enter base/developer roles. Tool, MCP, skill, project and user materials with
lower trust become contextual user material even if their producer requested a
higher role. Source, original content version, rendered version, clipping and
requested layer remain inspectable. This prevents a descriptive trust label from
masking a higher protocol role; it does not prove that arbitrary model-generated
text is safe.

Budgeting retains material boundaries. With several prompt materials it omits
whole items that cannot fit rather than joining all rules and cutting the middle.
A single oversized material is explicitly truncated and recorded. Tool schemas,
images, history and output reservations remain inside the shared context budget.

Compaction cannot end between a tool call and its result, and cannot summarize a
still-pending call. A missing finish event, cancellation or output-limit finish
cannot create a replacement summary. Failed compaction preserves the previous
history. Current rules remain separate prompt inputs; source message IDs retain the original user facts and unfinished work for inspection.
The summary's semantic completeness is still model-dependent: passing fake
transport tests does not establish that a real model always preserves every
requirement over repeated compression.

## Prompt → Context → Memory responsibilities

The complete request path is `buildHostPromptFragments` (or the child equivalent)
→ `PromptAssembler` → `ContextWindowBuilder` → `SingleAgentRuntime`'s prepared
request → `ModelRouter.stream`. Host and child runtimes use the same path and
current profile/project configuration. `RuntimeService` rebuilds supplied prompt
material at each model step; lifecycle labels are not a cache. The standard Host
supplies Memory directory paths, while the Agent reads Memory and project files
through ordinary tools when needed. Rebuilding the prompt does not reread them.

| Material | Authority and scope | Selection and update |
| --- | --- | --- |
| Platform/runtime rules | Trusted base/developer roles | Current Host snapshot, not project/Memory authority |
| Explicit user request/correction | Current session user message | Retained in effective history; takes precedence over stale Memory/summary |
| AGENTS/CHILI/path rules | Project material observed through tools | Agent discovers and reads applicable files |
| Skills/MCP descriptions | Tool/reference material in contextual user role | Current selected profile/registry and explicit mentions; no system promotion |
| Memory preferences/facts | Markdown under profile personal/current project directories | Agent searches, reads and edits files; no special Memory tool or automatic selection |
| History/tool observations | Session-owned conversation | Complete compaction contract, paired tools, existing marked preview limits |
| Tool definitions/images | Actual advertised catalog/multimodal inputs | Included in the full request estimate and existing item limits |

Prompt manages source identity, scope and actual roles. Repeated identical
material IDs update one value; an empty update clears it. Cross-source/scope/trust
collisions fail. Distinct MCP names have distinct identities. Numeric priority
orders material selection; it does not give lower-trust material higher authority
or solve arbitrary semantic conflicts.

Context chooses the actual request. Explicitly supplied optional background
fragments retain their selection boundaries; required instructions and the
current request are never relabeled as optional merely because their text
matches a background item. The standard Host's Memory reads are normal tool
history, with the same explicit display limits and compaction coverage contract.
If required input cannot fit, the runtime fails explicitly. The prepared budget
includes history, all selected prompt roles, tool definitions, image estimates,
output reserve and framing margin.

Memory retains explicit durable facts and preferences as ordinary Markdown files.
Editing or deleting a file immediately affects the next normal read. There is no
Memory database, index, automatic extractor, embedding service or graph.
Current task state and incomplete tool execution remain session facts. Main and
child Agents share a profile's user preferences and the bound project's facts;
directory discovery uses the execution's profile and project. Sharing Memory
does not mean sharing private conversation history or authorization; filesystem
access continues to use normal tool and worker policies.

Loaded source bodies remain separate from display previews in memory. Only the
authoritative files own those bodies. Inspection
records original source hash/length, rendered hash, actual sent hash, applicable
scope/revision, and omission/truncation reason. Source matching consumes content
occurrences, so empty fragments, duplicate text, and budget omission cannot shift
IDs. JSON key ordering alone does not count as truncation. A compaction request
also records its batch/stage, original message IDs, and previous/draft summary
hashes, instead of mislabeling all serialized source messages as omitted.

Current user corrections and current rules/Memory versions explicitly supersede
older contradictory background text. This is an authority and freshness contract,
not a deterministic natural-language conflict resolver. Removing Memory does not
rewrite historical observations or already-generated summaries; those remain
historical evidence, not permission to reinstate the deleted entry.

## Compaction coverage and budget (2026-10-07)

The audit confirmed a deterministic coverage defect: `budgetSourceText` removed
middle material before both draft and review, but the returned boundary and
`sourceMessageIds` still covered the entire selected prefix. A second part limit
and final prompt clipping could remove additional material. Keeping raw history
in SQLite did not make that omitted evidence available to subsequent requests.

The replacement contract is now **complete processing of the selected serialized
prefix, or no replacement**. Coverage does not mean lossless semantics.

- Source is the effective previous summary followed by the newly selected raw
  history, including separate tool-result text blocks. It is serialized with `formatCompactionSourceMessages`, never with the
  window builder's clipped history. Tool calls and all their matching results
  form contiguous groups. An actual result is the completion fact; a stale stored
  call status alone is insufficient. Open calls stay outside the boundary, and
  malformed/duplicate associations cannot be summarized.
- Whole groups are packed into sequential batches. Each batch receives the
  previous batch's complete summary, plus the next contiguous groups. Draft and
  the existing optional review see identical complete source. Only after every
  batch succeeds may the original boundary and corresponding source IDs be
  returned. The default is at most eight batches (sixteen model calls with
  review); `maxBatches` can be configured up to 32. There are no partial commits,
  recursive retries, or additional evaluator models.
- Character limits are hard admission limits, not slicing instructions:
  120,000 source characters including carried summary, 160,000 prompt characters,
  and 16,000 summary characters by default. Model limits come from the selected
  router/provider descriptor. When a model window is known, the summary character
  allowance is capped at one quarter of it; output reservation is the smaller of
  that allowance and the provider output allowance. This avoids reserving an
  entire large provider generation limit for a small summary.
- Both requests budget their exact text, compression system prompt, additional
  user instructions, source, and output reserve using the shared estimator and
  2,048-token framing margin. Batch admission additionally reserves the full
  permitted review draft (one estimated token per character). Review is checked
  again using the actual draft. Part/prompt clipping is disabled on this path;
  overlong or incomplete output fails instead of becoming a clipped summary.
- A single message/tool group or existing summary that cannot fit is rejected.
  It is neither skipped nor split within its body. Existing attachment metadata
  and artifact references remain available through the current formatter; this
  change does not add storage references or a long-term memory system.
- Runtime validates the prospective summary plus retained tail against the
  actual request surface before saving. It rejects eviction of any effective
  message or clipping of summary text. Automatic compaction may fall back after
  failure only if the complete original message set still fits. Manual compaction
  uses the selected model limits and tool catalog; its API has no future turn's
  system/developer prompt, so the next turn validates its full surface again.
- Replacement message parts and `turn.compaction_completed` use one existing
  `appendMany` batch (transactional in SQLite). Cancellation is checked before
  commit; cancellation after commit cannot reclassify the replacement as failed.
  A later failed/cancelled main request does not invalidate that committed summary
  or remove its boundary anchor, even when the boundary belongs to that failed turn.
  Repeated compaction drops superseded summary records from the effective view.
  An unresolved/self/future boundary never authorizes dropping raw history.

Limits remain explicit: token estimates are ASCII/4 plus one token per non-ASCII
code point, not a provider tokenizer. Provider framing/reasoning can differ;
unknown model limits leave only character admission available. Normal request
projection still has the existing marked per-part/tool preview limits; those are
not evidence of compaction coverage. Serialization represents images as metadata
and excludes the durable `structuredData` channel. Summaries, including summaries
of summaries, can lose meaning. No test here promises preservation of every fact.

No EventStore signature, persisted event format, SQLite schema, SSE protocol, or
authorization interface changed. Store implementations must preserve the existing
batch commit behavior. Final tool authorization and dispatch were not modified.

### Research provenance

Sibling directories inspected: `.chili`, `aider`, `CC`, `cherry-studio`, `chili`,
`chili-archives`, `chili-git-shell`, `chili-store-storage`, `chili-task-continuity`,
`codex`, `continue`, `deepseek-harness`, `gemini-cli`, `grok-build`, `opencode`, `pi`.

Local official-source observations, not claims about latest upstream HEAD:

- Codex `822e58cc3d666166c7446c5b1ea2e52f5d09594c` (2026-10-06): separate hard
  window and automatic threshold (`core/src/session/context_window.rs`), paired
  history normalization (`core/src/context_manager/normalize.rs`), and candidate
  replacement after successful compaction (`core/src/compact_remote_v2.rs`). Its
  legacy source eviction and remote tool-output truncation do **not** satisfy
  this task's stronger complete-source contract and were not copied.
- Gemini CLI `fb972b2f87fe7d5b06d37eac711490162d98de2c` (2026-10-02): safe split
  points and checking summary plus tail (`chatCompressionService.ts`).
- OpenCode `f03046d9f558bc54a090363fea48441b05f522bf` (2026-10-06): only completed,
  error-free summaries count; oversized summaries stop rather than recurse.
- Local `CC/CLAUDE.md` identifies reverse-engineered/decompiled material with no
  verifiable official version; it was not used as current Claude Code authority.

[Weng's Harness Engineering](https://lilianweng.github.io/posts/2026-07-04-harness/)
supports improving mechanisms from failure evidence and regression checks.
[Anthropic's harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)
supports testing whether additional mechanisms earn their cost.
[Claude middleware events](https://code.claude.com/docs/en/plugins/mods/events),
[Claude plugins](https://code.claude.com/docs/en/plugins), and
[Codex Hooks](https://learn.chatgpt.com/docs/hooks) describe lifecycle and packaging
boundaries; none requires building a plugin platform for this fix.
[OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)
requires compaction input itself to fit the model window.
OpenCode reports [#39031](https://github.com/anomalyco/opencode/issues/39031)
(1.18.5, hung plugin) and [#48085](https://github.com/anomalyco/opencode/issues/48085)
(no version supplied) motivated lifecycle checks only; they are community reports,
not proof that every implementation exhibits those failures.


Additional local research: Codex `core/src/agents_md_manager.rs` distinguishes
request snapshots, source provenance and explicit subagent provider sharing;
`core/src/context/world_state/agents_md.rs` uses replacement/removal notices.
Its repository cache is not a general file-change watcher. Memory v2 extraction
(`memories/write/templates/memories/stage_one_system_v2.md`) separates human
statements from injected instructions and delegated-agent output. These are local
version observations; its automated extraction was not added to Chili. Official
[AGENTS guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [Memories guidance](https://learn.chatgpt.com/docs/customization/memories)
were checked separately. Local Gemini `memoryContextManager.ts` distinguishes
shared rules from private notes; OpenCode `session/instruction.ts` deduplicates
path-specific instructions. Their different scope models were not treated as a
single universal rule.

## Regression coverage

`packages/core/src/context/prepared-request.test.ts` uses temporary SQLite
stores, fake models and tools to exercise repeated provider IDs across sessions
and turns, exact sent/saved content, immutable old versions, actual-vs-preview
inspection, account version audit, stale catalogs, independent structured result
data, budget omissions, incomplete compression and call/result boundaries.
Existing runtime cancellation, retry, stream-integrity and context tests remain
part of the gate. No real credentials, provider network calls or work files are
needed for these regressions.

`compaction-coverage.test.ts`, `window-coverage.test.ts`, and
`runtime-compaction-coverage.test.ts` exercise complete long-history coverage,
batch limits/failures, pairing, repeated boundaries, exact prompt admission,
recovery, atomic commit, and actual post-compaction model execution. The legacy
prompt-budget tests now assert complete input or explicit refusal, rather than
accepting clipped source as successful coverage.

`material-selection.test.ts`, `prompt/runtime-materials.test.ts`,
`memory-behavior.test.ts`, and Host `prompt-context-memory.test.ts` cover actual
roles, empty/replaced fragments, original/display provenance, same-text material
identities, full request budgets, updates/deletion without stale loads, and real
main/child Agent profile/project/session isolation.
