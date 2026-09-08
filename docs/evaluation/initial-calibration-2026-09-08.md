# Initial local calibration — 2026-09-08

The three-task public development baseline distinguishes each original bug from its historical production fix. No model was invoked, no provider credentials were read, and this is not a coding-agent capability result.

Commands run:

```sh
bun run scripts/coding-eval/index.ts self-check all
bun test scripts/coding-eval/index.test.ts
bun node_modules/typescript/bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --types bun --strict --skipLibCheck scripts/coding-eval/index.ts scripts/coding-eval/index.test.ts
```

Each table cell is **passed/failed tests**. All original snapshots passed their old regression gate and failed the behavior gate with actual failed assertions, rather than evaluator timeouts. Each historical production-only patch then passed both gates.

| Task | Original regression | Original acceptance | Corrected regression | Corrected acceptance |
| --- | --- | --- | --- | --- |
| `tool-input-preview` | 32/0 | 34/10 | 32/0 | 44/0 |
| `task-cancellation-receipts` | 70/0 | 0/5 | 70/0 | 5/0 |
| `mcp-operation-deadline` | 7/0 | 0/4 | 7/0 | 4/0 |

Environment: Bun 1.3.14, macOS arm64, locally installed third-party dependencies. Exact lockfile hashes, evaluator/check hashes and dependency link inventories are in the JSON records. Workspace source aliases point to the historical candidate snapshot.

Local evidence: `/tmp/chili-coding-eval-calibration-DFJKkQ/calibration.json`. This path is an ephemeral local artifact, not a portable repository fixture. Use `self-check` to regenerate the records from the pinned history.

The evaluator integration test also replaced the candidate's own MCP regression file with an always-passing test. Verification still ran the seven canonical base regression cases and rejected all four original behavioral failures. The candidate file remained unchanged, and no future acceptance file was introduced into the candidate workspace. The prepared repository contained one commit and no remote. The two verification subprocesses observed different temporary HOME directories, and both directories had been removed after verification.

The MCP baseline runs four selected bounded checks. Trying the entire historical timeout test file against its original implementation exceeded a 60-second exploratory timeout, so that full file is not claimed as a calibrated gate. The final selected checks completed without evaluator timeouts.

What remains unmeasured: real model attempts, end-to-end solving or false-completion rates, token usage, API/account cost, human intervention, Desktop usability, team uplift, and held-out generalization. The historical test fixtures were written with the original fixes and this development set is public; a future holdout needs separate task selection and acceptance authoring.
