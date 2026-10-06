# Coding reliability foundation

Current product priorities are defined in [product-direction.md](product-direction.md). The coding evaluation baseline below is a completed development tool; further model benchmarking is not on the current work plan.

This change addresses concrete execution and integration failures found during the September 2026 codebase review. It preserves the Bun/TypeScript runtime and existing application boundaries. It does not establish a coding-agent ranking or choose a final Desktop design.

## Completion is a protocol boundary

The OpenAI Chat Completions, Responses/Codex, and Anthropic adapters require their protocol's explicit completion signal. EOF alone is not success. Chat Completions continues reading the usage tail after choice completion; an Anthropic tool block must close before message completion. SSE parsing preserves CRLF boundaries split across network chunks.

The core runtime independently requires a nonempty finish event before executing queued tools. Missing completion, unfinished tool arguments, and output-token exhaustion fail the turn without executing its tools. Cancellation and failure close pending tool records so the interface can show their actual terminal state. Existing retry rules still distinguish failures before assistant output from failures after output.

This intentionally changes compatibility: providers that silently close a stream without a valid terminal event now fail visibly. Output limits no longer become an apparently successful response or an implicit tool repair turn.

## A logical prompt spans multiple model turns

RuntimeService passes one prompt execution scope through ordinary turns, repair/final-response turns, and automatic Goal continuation. Child-agent runs do the same. A fresh submitted prompt or independently resumed Goal gets a fresh scope.

Repeated identical tool inputs are counted across turns in a bounded recent-call window. The per-turn total still resets at each turn. This detects repeated calls, not semantic lack of progress, and its default repetition threshold remains 20.

Initial child-agent execution now resolves the same session model configuration used by child follow-ups. It snapshots model selection, reasoning level and service tier once for the run, including its repair and final-response turns. This reuses the existing configuration policy; it does not introduce a new parent-to-child inheritance policy.

## Message order follows event creation

SQLite message projections retain the sequence of their first `message.created` event. Reads and previews use that order rather than wall-clock timestamps or random message IDs. Updates do not move a message. Migration reconstructs known sequences and preserves deterministic ordering for historical rows without creation events.

An insert trigger also fills the sequence for older processes that continue writing the previous projection format. It uses the creation event already written in the same transaction and leaves existing historical orphan rows unchanged.

## Agents own delegation and review

Agents use the same creation, messaging, waiting, stopping, and resuming operations. They decide how to split work and request review through ordinary inputs. There is no Team controller, business Task state machine, or automatic verification/merge workflow.

`git_worktree` and `git_apply_patch` are independent tools. Agents can isolate work, review changes, run checks, and explicitly integrate patches under their tool permissions.

## Shell classification matches execution

Bash tools use `--noprofile --norc -c` in ordinary and macOS sandbox execution. Read-only classification includes the structured `env` argument and environment assignments in command text; an environment override requires execution permission even when the command itself looks read-only.

Commands that depended on login-shell startup files may need an explicitly configured executable path or environment. Environment overrides remain available when execution is authorized.

## A first coding-task development set

`bun run eval:coding list` exposes three real historical Chili bug-fix tasks. Preparation creates a fresh repository at the task's fixed starting snapshot. Verification supplies canonical regression and acceptance checks in a separate shadow directory. Calibration must reject each original bug and accept its production-only historical fix.

See [evaluation/README.md](evaluation/README.md) for provenance, usage and limitations. These commands do not invoke a model. Real model attempts, usage measurements, and an unseen holdout are still needed before comparing agent capability or the benefit of parallel delegation.

## Validation

Focused behavioral tests cover protocol endings and cancellation, event ordering and migration, prompt scopes, child model configuration, read-only shell boundaries, real Git dependency chains, and evaluation isolation.

Final local validation on 2026-09-08:

- `bun test`: 2,997 passed, 0 failed across 246 files (21,495 assertions; 157.15 seconds).
- `bun run typecheck`: passed, including Desktop and control-web.
- `bun run smoke:all`: all 10 suites passed, including `smoke:p3-team-model` and `smoke:p3-team-parallel`.
- Coding evaluator calibration: all three original bugs rejected by behavior checks; their historical production fixes passed both gates. See [initial calibration](evaluation/initial-calibration-2026-09-08.md).

Gate logs are local artifacts under `/tmp/chili-reliability-foundation-2026-09-08/`. The full checks ran against the current working tree, including the pre-existing Desktop edits that are excluded from this change. A passing fake-model smoke suite is not evidence of real-model coding performance.
