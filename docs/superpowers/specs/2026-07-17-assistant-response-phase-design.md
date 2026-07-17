# Assistant Response Phase Design

## Goal

Preserve the OpenAI Responses API assistant `phase` field from the wire through Chili's persisted protocol, runtime projection, SDK view, history replay, and TUI so intermediate commentary can never look like the final answer.

## Scope

This change applies strict phase handling to the `openai-codex` Responses provider used by the reported session.

- `commentary` means a visible intermediate update.
- `final_answer` means the completed user-facing answer.
- The Codex provider treats a missing, invalid, or inconsistent assistant phase as a provider protocol error.
- The TUI does not infer phase from tool calls, session status, stream position, or message order.
- Phase-less text from stored legacy data or providers outside this scope is explicitly unclassified and must not use the final-answer Chili marker.

## Chosen Approach

Carry phase on each assistant text output unit represented by a Chili `TextPart`. This is the smallest faithful representation because one Responses call can emit multiple assistant message output items, each identified by `output_index` and each carrying its own phase, while Chili currently creates one enclosing assistant `Message` per model request.

The rejected alternatives are:

1. A TUI-only rule based on tool calls, running state, or the last message. It guesses semantics that the provider already supplies and fails for long-running goal continuations.
2. A single phase on Chili `Message`. It cannot represent multiple phased Responses message items within one model response.
3. Collapsing commentary into reasoning. Commentary is user-visible model output and must remain distinct from hidden or summarized reasoning.

## Protocol Model

Add the shared type:

```ts
export type AssistantMessagePhase = "commentary" | "final_answer";
```

`TextPart` gains optional `phase?: AssistantMessagePhase`. It is optional at the generic protocol level because user text and providers outside this scope do not produce Responses assistant phases. The OpenAI Codex path is stricter than the generic type: every assistant text output it accepts or replays must have a phase.

No database migration is required because message parts are persisted as JSON. New events store phase in the existing part payload.

## Provider Data Flow

The OpenAI Codex provider records every `response.output_item.added` message item by `output_index`, validates its `phase`, and associates subsequent `response.output_text.delta` or `response.refusal.delta` events with that phase.

`ModelTextDeltaEvent` gains optional `phase`. OpenAI Codex always supplies it; other providers remain outside this change and do not synthesize it.

The provider must reject:

- a message output item without `commentary` or `final_answer`;
- a text delta whose `output_index` has no preceding validated message item;
- conflicting phase values for the same output item;
- phase-less assistant text found while serializing Codex conversation history.

History serialization iterates assistant parts in their stored order. Each phased text part becomes its own Responses assistant message input with the original phase. Tool calls remain separate function-call input items in the same relative order. Assistant text is never concatenated across output items.

## Runtime Storage

Replace the single `AssistantStreamState.textPartId` with a map keyed by text event index. The value records both the part ID and phase.

- The first delta for an index creates one `TextPart` with its phase.
- Later deltas for that index append to the same part.
- A new index creates a new part, preserving Responses message boundaries.
- A phase change within an existing index fails the turn as a provider protocol error.

This is independent of reasoning section indexing and tool-call indexing.

## SDK Projection

`ChatMessagePart` exposes `phase?: AssistantMessagePhase`, and `chatMessagePart` copies it without interpretation. Projection does not classify messages from turn state or tool presence.

Raw transcript output includes phase for text parts so diagnostics can verify the semantic channel.

## TUI Presentation

The final marker is reserved for explicit `final_answer` output:

```text
↳ 当前负载已经明显异常，我再看一下总体 CPU 和磁盘活动。
  Ran system sampler
🌶️: 看到了，主要原因是短时文件任务与长期会话累积。
```

Presentation rules are exact:

- `commentary`: muted Markdown, prefix `↳ `, never `🌶️:`.
- `final_answer`: normal assistant Markdown, prefix `🌶️:`.
- no phase: muted Markdown, prefix `Assistant: `, never `🌶️:`.

The hide-thinking control may hide explicit commentary and reasoning, but it must not use tool calls or streaming state to decide whether assistant text is commentary. Showing thinking exposes commentary with its muted progress presentation; it never promotes commentary to final-answer styling.

Streaming preserves the same phase-specific prefix from the first delta. A streaming `final_answer` may show `🌶️:` because the provider has explicitly declared that output item as final.

## Error Handling

Provider protocol errors use a stable message that identifies the invalid output index and phase condition. The runtime follows its existing failed-turn path, persists any already-received valid output, and does not relabel it.

There is no heuristic fallback, phase repair, last-message promotion, or tool-call-based compatibility behavior.

## Tests

Implement test-first coverage for:

1. The Codex provider emits distinct commentary and final-answer text events for distinct output indexes.
2. Missing, invalid, orphaned, and conflicting Codex phase data fail with provider protocol errors.
3. Codex history serialization round-trips phase and preserves text/tool ordering without concatenation.
4. Core runtime creates separate phased text parts per output index and rejects a phase change for one index.
5. SQLite replay and SDK projection preserve phase.
6. TUI commentary uses `↳ ` and never contains `🌶️:`.
7. TUI final answers use `🌶️:`.
8. Phase-less text is visibly unclassified and never promoted to final-answer styling.
9. Hide-thinking uses explicit phase rather than tool-call or running-state inference.

## Success Criteria

- The reported session pattern renders intermediate progress without the Chili final marker.
- Only explicit `final_answer` output renders `🌶️:`.
- Multiple Responses message output items remain distinct through storage and replay.
- Codex history sends the original phase values back to the model.
- Missing Codex phase fails loudly instead of being guessed or silently repaired.
- Focused provider, core, SDK, store, and TUI tests pass, followed by `bun run typecheck`, `bun test`, and `bun run smoke:all`.
