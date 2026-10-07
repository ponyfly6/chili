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
The execution identity records the profile, project and workspace binding.

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

## Regression coverage

`packages/core/src/context/prepared-request.test.ts` uses temporary SQLite
stores, fake models and tools to exercise repeated provider IDs across sessions
and turns, exact sent/saved content, immutable old versions, actual-vs-preview
inspection, account version audit, stale catalogs, independent structured result
data, budget omissions, incomplete compression and call/result boundaries.
Existing runtime cancellation, retry, stream-integrity and context tests remain
part of the gate. No real credentials, provider network calls or work files are
needed for these regressions.
