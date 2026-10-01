# Chili coding task development baseline

This is a small, local **public development set**, built from three real Chili bug fixes. It tests whether a candidate change satisfies independently supplied behavior checks and preserves selected existing behavior. It is not a model ranking, a hidden holdout, or a claim that Chili can solve these tasks autonomously.

The harness never invokes a model, reads provider credentials, or installs dependencies. All generated repositories, logs, metadata, and results go under `/tmp/chili-coding-eval-*`. The source checkout is read only. Requirements and the starting repository are given to the coding agent; reference changes and acceptance tests stay outside its working directory.

## Tasks and provenance

All task code and historical test fixtures come from this Apache-2.0 repository. `LICENSE` remains in each prepared snapshot. The base and reference commits must exist locally; the evaluator does not fetch them. The evaluator integration test skips when a shallow checkout lacks the pinned historical commit; explicit `prepare`/`self-check` still fail visibly if required history is absent.

| ID | Actual development problem | Base commit | Historical reference | Behavioral acceptance |
| --- | --- | --- | --- | --- |
| `tool-input-preview` | SDK replay drops valid pre-execution input previews; Desktop reports incorrect truncation | `88c76bcdfc7e27dd9411a73adfb691a33d05abac` | `7a9e49fd66fb1be404c5f1146c899824eba764ac` | 44 tests across SDK replay and Desktop view-model; previews, cancellation, session separation, anchors, byte limits and warnings |
| `task-cancellation-receipts` | Caller abort leaves child tasks running; delayed lease receipts permit expired follow-ups | `f040e33a3d956a86079632052e7966ad66c5943a` | `a9e8e1dcb53f0cf5ff064d2121a19d7464f5ef85` | 5 tests: two seeded lifecycle runs of 250 tasks, expiry with/without recovery, abort during admission acknowledgement |
| `mcp-operation-deadline` | Deadline rejection fails to cancel underlying requests; late startup can repopulate state | `21baff1e2988b4910cc47b47313830b4d70a5c62` | `ee637fccd8998175f1eac4a3113740cfee26578c` | 4 selected deadline, pre-aborted caller, initialization and sibling-cancellation tests |

The acceptance fixtures are pinned historical tests, obtained by the external evaluator from the reference commits. They are independent of the candidate's edits, not independently authored from the historical fixes. They do not prove that all valid implementations are accepted or all incorrect implementations rejected. For the preview task, the full historical acceptance files also contain older regression cases. The separate regression gate always uses the unmodified base-commit tests.

The MCP fixture deliberately selects four bounded tests. Its complete historical test file can hang on the uncorrected implementation; an evaluator-level timeout is still enforced for every test process. This small baseline does not claim coverage of every MCP cancellation boundary.

## List and prepare — no model call

Run from the Chili checkout containing this harness:

```sh
bun run scripts/coding-eval/index.ts list
bun run scripts/coding-eval/index.ts prepare tool-input-preview
```

`prepare` prints a `runDirectory`, `workspace`, and `prompt` path. Keep the run directory for verification. Give the agent only the workspace and `workspace/CODING_TASK.md`.

Preparation exports the exact base tree, then creates a new local Git repository with one generic snapshot commit and no remote. It does not expose future Git history. It does not use, reset, or clean the user's checkout or its worktrees. The task file is ignored locally; candidate edits must remain **uncommitted**, because verification compares the working tree and index with that one snapshot commit. Added regular files are included; ignored generated files are excluded.

An agent may read base tests and add its own focused tests. Do not show it this document, the evaluator directory, or reference patches during an attempt. The environment is not a filesystem security boundary: a local process with broad permissions could inspect other checkouts. These are cooperative development experiments; public history can contaminate results.

## Explicitly opt in to a real coding attempt

Only this separate, manual step invokes a model. Use it after choosing an explicit provider/model and recording its configuration and budget. **The selected Chili provider determines the account and billing path; Codex app allowance or reset credits must not be assumed to cover a provider API call.** The baseline does not choose credentials or consume resets.

Use the current Chili CLI as the agent under test, pointed at the prepared historical workspace. Run it from a terminal in the current checkout. Replace the two placeholders first:

```sh
CHILI_EVAL_WORKSPACE='/tmp/chili-coding-eval-.../workspace'
CHILI_EVAL_MODEL='YOUR_EXPLICIT_PROVIDER/MODEL'
bun run apps/cli/src/index.ts --cwd "$CHILI_EVAL_WORKSPACE" --model "$CHILI_EVAL_MODEL" --no-mcp --max-turns 24 "$(cat "$CHILI_EVAL_WORKSPACE/CODING_TASK.md")"
```

This command is documentation only; `list`, `prepare`, `verify`, and `self-check` cannot call it. It retains the CLI's ordinary tool approval behavior. A turn limit is not a monetary hard cap. Record the actual current Chili commit and dirty diff, provider/model version, reasoning setting, task mode (single agent, read-only delegation, or team), budget, user instructions, and any interventions before interpreting a result. Do not use the historical CLI as the system under test accidentally.

## Verify — independent checks, JSON result

After the candidate has finished editing:

```sh
bun run scripts/coding-eval/index.ts verify /tmp/chili-coding-eval-...
```

Pass the **run directory**, not its `workspace` child. Verification creates a separate shadow snapshot, applies the candidate's tracked/index/untracked regular-file edits, then supplies canonical tests externally. It restores the base Bun/TypeScript root configuration and replaces selected regression tests with their base versions before running them. It then installs the pinned acceptance tests in the shadow only. Candidate-authored tests remain useful development evidence but cannot replace these two gates.

The command prints a JSON result and persists it, command output, check hashes, and dependency links in a unique `verification-*` directory. The candidate's own files are untouched. A repeat verification creates another result rather than overwriting the previous one.

Exit status is `0` for both gates passing, `1` for a behavior or regression failure, and `2` for preparation/infrastructure errors. A test-process timeout fails its gate and sends SIGKILL to the directly spawned Bun process. The harness does not create or kill an OS process group and cannot guarantee termination of arbitrary descendant processes created by candidate code. Acceptance also checks the expected number of passed tests, so an empty test run is not success.

`passed` means only that these local gates passed. Model identity, coding wall-clock time, human active time, input/output tokens, and USD cost remain `null` because this harness does not observe them. Test gate wall clocks measure verification, not coding speed. Do not substitute zero for unavailable usage. Do not report a model completion or a false-completion rate from these records alone.

## Calibrate the evaluator — no model call

```sh
bun run scripts/coding-eval/index.ts self-check all
# Or one task:
bun run scripts/coding-eval/index.ts self-check mcp-operation-deadline
```

For each task, calibration requires:

1. The original base passes its existing regression gate.
2. The original base fails behavioral acceptance with an actual test failure, not an infrastructure timeout.
3. Applying only the historical **production** diff passes both gates. The reference test diff is never applied to the candidate workspace.

The final `calibration.json` records `modelInvoked: false`, the per-task calibration status, and paths to both result records. This validates useful positive/negative examples for the checker. It provides no model capability score. Calibration workspaces contain reference production changes and must never be reused as fresh model attempts; always call `prepare` again.

## Environment limits and reproducibility

Use the repository's already installed Bun/dependencies. The harness shares installed third-party packages through symlinks, does not run `bun install`, and makes every `@chili/*` workspace link point inside the corresponding snapshot. Snapshot TypeScript paths resolve local `src`, not live checkout `src` or compiled `dist`. User `.env` files are not exported by Git, and test processes receive a minimal environment with a fresh temporary home for each subprocess and no inherited provider tokens/preload settings. Each temporary home is removed when that subprocess exits or is killed.

This is a practical local baseline, not a hermetic dependency rebuild or OS sandbox. Installed package contents may differ from the historical lockfile, and shared packages are not copied read-only. The result records Bun version, OS/architecture, historical and installed lock hashes, and a fingerprint of the dependency-link inventory. Full link details are retained next to the result. A lock hash identifies the intended dependency graph, not proof of the installed bytes. Compare runs on the same dependency installation; use a separately isolated, pinned installation before publishing performance comparisons.

The selected tests use fake runners and clients, local SQLite, and temporary files. They do not call a real provider or start the Desktop application. Existing tests' own temporary resources follow the runner's `/tmp` environment. Do not treat the evaluator as safe for arbitrary hostile patches.

## Development set versus future holdout

These three tasks are deliberately visible and suitable for improving prompts, context selection, edit recovery and verification policy. After using them for tuning, their results are development results permanently. There is **no holdout in this first version**.

For a later comparison, select additional real tasks before tuning, freeze their base snapshots and requirements, and assign acceptance to a reviewer who does not supply the implementation. Keep those cases out of prompts, examples and agent-visible history until the final run. Run an equal-budget comparison separately from an equal-quality comparison. Keep single-agent, read-only delegation and parallel-writing team conditions distinct.

Record independent pass/fail, claimed completion, failure category (understanding, localization, editing, tool use, verification, integration or recovery), human active time, end-to-end wall clock and actual model/tool cost. A claimed completion followed by failed independent acceptance is a candidate false completion; an infrastructure error is not automatically an agent error. Three task types and a handful of runs are useful for finding bottlenecks, not for a general coding-agent ranking.
