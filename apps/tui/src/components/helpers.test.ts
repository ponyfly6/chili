import { expect, test } from "bun:test";
import type { TeamLiveRunSummary } from "@chili/sdk";
import type { TeamRunSummaryCounts } from "@chili/protocol";
import { countsCompact, runBottleneckLabel, runBottleneckShortLabel } from "./helpers.js";

test("countsCompact renders run counts in a stable compact order", () => {
  expect(
    countsCompact(
      counts({
        errors: 3,
        stillRunning: 2,
        dispatched: 4,
        mergeConflicted: 1,
        blocked: 5,
        completed: 6,
      }),
    ),
  ).toBe("disp:4 done:6 conflict:1 block:5 run:2 err:3");
});

test("countsCompact hides zero counts and caps dense summaries", () => {
  expect(
    countsCompact(
      counts({
        dispatched: 1,
        completed: 2,
        accepted: 3,
        reopened: 4,
        merged: 5,
        mergeFailed: 6,
        mergeConflicted: 7,
        mergeSkipped: 8,
        failed: 9,
      }),
    ),
  ).toBe("disp:1 done:2 accept:3 reopen:4 merge:5 mergeFail:6 conflict:7 mergeSkip:8");
  expect(countsCompact(counts({}))).toBe("none");
});

test("runBottleneckLabel reports the highest-signal run limiter", () => {
  expect(runBottleneckLabel(run({ counts: counts({ errors: 1, stillRunning: 4 }), maxConcurrentDispatches: 4 }))).toBe("errors");
  expect(runBottleneckLabel(run({ counts: counts({ stillRunning: 4 }), maxConcurrentDispatches: 4 }))).toBe("fanout-full");
  expect(runBottleneckLabel(run({ counts: counts({ blocked: 2, stillRunning: 1 }), maxConcurrentDispatches: 4 }))).toBe("blocked");
  expect(runBottleneckLabel(run({ counts: counts({}), stopReason: "drained" }))).toBe("drained");
  expect(runBottleneckShortLabel("workers-running")).toBe("run");
  expect(runBottleneckShortLabel("merge-conflict")).toBe("mconf");
});

function run(input: Partial<TeamLiveRunSummary>): TeamLiveRunSummary {
  return {
    id: "run_test",
    teamId: "team_test",
    status: "running",
    cycle: 1,
    counts: counts({}),
    updatedAt: 1,
    ...input,
  } as TeamLiveRunSummary;
}

function counts(input: Partial<TeamRunSummaryCounts>): TeamRunSummaryCounts {
  return {
    dispatched: 0,
    completed: 0,
    accepted: 0,
    reopened: 0,
    merged: 0,
    mergeFailed: 0,
    mergeConflicted: 0,
    mergeSkipped: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    stillRunning: 0,
    errors: 0,
    ...input,
  };
}
