import { describe, expect, test } from "bun:test";
import {
  assessDelegationIntegration,
  assessSubagentCompletion,
  delegationIntegrationRepairPrompt,
  subagentCompletionRepairPrompt,
  type SubagentCompletionIssue,
} from "./subagent-completion.js";

describe("assessSubagentCompletion", () => {
  test.each([
    [undefined, "empty"],
    ["  \n\t ", "empty"],
    ["Okay.", "acknowledgement_only"],
    ["收到！", "acknowledgement_only"],
    ["I'll analyze the business feature modules systematically. Let me start by mapping the workspace.", "planning_only"],
    ["I need to inspect the route files first. Next, I'll summarize their responsibilities.", "planning_only"],
    ["Let's inspect the repository first.", "planning_only"],
    ["让我先看看项目结构。接下来我会分析关键文件。", "planning_only"],
  ] satisfies Array<[string | undefined, SubagentCompletionIssue]>) (
    "rejects incomplete terminal text %#",
    (summary, issue) => {
      expect(assessSubagentCompletion(summary)).toMatchObject({
        status: "incomplete",
        issue,
      });
    },
  );

  test.each([
    "Done.",
    "No issues found.",
    "README uses the MIT license.",
    "已完成：更新了 3 个测试。",
    "未发现问题。",
    "Blocked: README.md is missing.",
    "42",
    "可以。",
    "First finding: no issue.",
    "First: no issues found.",
    "Starting point: package root.",
    "I will not change the file because the task is read-only.",
    "Plan:\n1. Keep the public API stable.\n2. Add a regression test.",
  ])("preserves a legitimate concise final: %s", (summary) => {
    expect(assessSubagentCompletion(summary)).toEqual({
      status: "completed",
      summary,
    });
  });

  test("trims an accepted summary", () => {
    expect(assessSubagentCompletion("  No issues found.\n")).toEqual({
      status: "completed",
      summary: "No issues found.",
    });
  });

  test("rejects a result when the assignment explicitly required unobserved evidence", () => {
    expect(assessSubagentCompletion("No issues found.", {
      evidenceRequired: true,
      evidenceObserved: false,
    })).toEqual({
      status: "incomplete",
      issue: "no_evidence",
      summary: "No issues found.",
    });
  });

  test("accepts a concise result when required evidence was observed", () => {
    expect(assessSubagentCompletion("No issues found.", {
      evidenceRequired: true,
      evidenceObserved: true,
    })).toEqual({
      status: "completed",
      summary: "No issues found.",
    });
  });
});

test("repair prompt requires concrete completion without mandating tools", () => {
  const assessment = assessSubagentCompletion("I'll inspect it next.");
  if (assessment.status !== "incomplete") throw new Error("expected an incomplete assessment");

  const prompt = subagentCompletionRepairPrompt(assessment);
  expect(prompt).toContain("only described work you intended to do");
  expect(prompt).toContain("use tools when the task requires repository evidence");
  expect(prompt).toContain("actual findings, changes, verification, or concrete blocker");
});

describe("assessDelegationIntegration", () => {
  test.each([
    "I launched 10 agents.",
    "All 10 agents have completed.",
    "已并行启动了 10 个代理。",
    "已成功并行启动 10 个 subagent，全部完成，无失败、超时或文件修改。",
    "10 个代理都已完成。",
    "收到。",
    "I'll inspect their results next.",
  ])("rejects parent orchestration without an integrated result: %s", (summary) => {
    expect(assessDelegationIntegration(summary).status).toBe("incomplete");
  });

  test.each([
    "All agents completed. They found the retry fence missing in task-control.ts.",
    "代理已完成：发现 task_batch 默认错误地使用 notify。",
    "No issues found after comparing all three reports.",
    "Implemented the fix and bun test passes.",
    "Blocked: two agents failed with provider quota 2062.",
  ])("accepts a substantive integrated result: %s", (summary) => {
    expect(assessDelegationIntegration(summary)).toEqual({ status: "completed", summary });
  });

  test.each([
    "Reviewed.",
    "Looks good.",
    "Integrated.",
    "All agent results are solid.",
    "Done — no concerns.",
    "已审阅。",
    "所有代理结果都不错。",
    "Review complete.",
    "Results reviewed.",
    "Everything checks out.",
    "LGTM.",
    "Approved.",
    "No issues.",
    "All good.",
    "The agents did good work.",
    "I reviewed all results.",
    "Found an issue.",
    "Issue found.",
    "Tests passed.",
    "Confirmed no issue.",
    "Found a bug.",
    "发现问题。",
    "测试通过。",
    "发现一个错误。",
    "没有发现问题。",
  ])("rejects a generic supervised verdict without result content: %s", (summary) => {
    expect(assessDelegationIntegration(summary, { supervised: true })).toEqual({
      status: "incomplete",
      issue: "generic_integration_only",
      summary,
    });
  });

  test.each([
    "Reviewed.",
    "Looks good.",
    "Done — no concerns.",
  ])("does not strengthen ordinary delegation closure: %s", (summary) => {
    expect(assessDelegationIntegration(summary)).toEqual({ status: "completed", summary });
  });

  test.each([
    "Auth lacks retry fencing.",
    "The retry fence is correct.",
    "No issues found after comparing all three reports.",
    "README uses the MIT license.",
    "Blocked: two agents failed with provider quota 2062.",
    "认证缺少重试围栏。",
    "修复了重试围栏并通过竞态测试。",
  ])("accepts a concrete supervised integration: %s", (summary) => {
    expect(assessDelegationIntegration(summary, {
      supervised: true,
      supervisedResults: [{ taskId: "task_1", status: "completed", summary }],
    })).toEqual({ status: "completed", summary });
  });

  test("requires concrete supervised finals to cover returned task evidence", () => {
    const results = [
      { taskId: "task_auth", status: "completed", summary: "auth retry fence is missing" },
      { taskId: "task_tests", status: "completed", summary: "cache race regression test is missing" },
    ];
    expect(assessDelegationIntegration("Database schema uses UUID primary keys.", {
      supervised: true,
      supervisedResults: results,
    })).toMatchObject({ status: "incomplete", issue: "result_evidence_missing" });
    expect(assessDelegationIntegration("Auth lacks retry fencing, and the cache race needs a regression test.", {
      supervised: true,
      supervisedResults: results,
    })).toMatchObject({ status: "completed" });
  });

  test("matches Chinese supervised evidence without accepting an unrelated concrete result", () => {
    const results = [
      { taskId: "task_auth", status: "completed", summary: "认证缺少重试围栏" },
      { taskId: "task_cache", status: "completed", summary: "缓存竞态缺少回归测试" },
    ];
    expect(assessDelegationIntegration("认证重试围栏缺失，缓存竞态需要补测试。", {
      supervised: true,
      supervisedResults: results,
    })).toMatchObject({ status: "completed" });
    expect(assessDelegationIntegration("数据库使用 UUID 主键。", {
      supervised: true,
      supervisedResults: results,
    })).toMatchObject({ status: "incomplete", issue: "result_evidence_missing" });
  });

  test("allows concise coverage of normal results but never hides abnormal result evidence", () => {
    const normalResults = Array.from({ length: 10 }, (_, index) => ({
      taskId: `task_${index}`,
      status: "completed",
      summary: index === 0 ? "auth retry fence missing" : index === 1 ? "database lease race found" : `module_${index} review complete`,
    }));
    expect(assessDelegationIntegration("Auth lacks retry fencing and database leases have a race.", {
      supervised: true,
      supervisedResults: normalResults,
    })).toMatchObject({ status: "completed" });

    const withFailure = [
      ...normalResults,
      { taskId: "task_failed", status: "failed", error: "auth provider quota 2062" },
    ];
    expect(assessDelegationIntegration("Auth lacks retry fencing and database leases have a race.", {
      supervised: true,
      supervisedResults: withFailure,
    })).toMatchObject({ status: "incomplete", issue: "result_evidence_missing" });
    expect(assessDelegationIntegration("Auth provider lacks a retry fence, and database leases have a race.", {
      supervised: true,
      supervisedResults: withFailure,
    })).toMatchObject({ status: "incomplete", issue: "result_evidence_missing" });
    expect(assessDelegationIntegration("Auth lacks retry fencing; database leases race; provider quota 2062 blocked the failed review.", {
      supervised: true,
      supervisedResults: withFailure,
    })).toMatchObject({ status: "completed" });
    for (const summary of [
      "Provider quota 2062 passed verification; auth lacks a retry fence and database leases have a race.",
      "Provider quota 2062 is correct; auth lacks a retry fence and database leases have a race.",
      "Provider quota 2062 poses no concern; auth lacks a retry fence and database leases have a race.",
    ]) {
      expect(assessDelegationIntegration(summary, {
        supervised: true,
        supervisedResults: withFailure,
      })).toMatchObject({ status: "incomplete", issue: "result_evidence_missing" });
    }
    expect(assessDelegationIntegration("Provider quota 2062 blocked verification; auth lacks a retry fence and database leases have a race.", {
      supervised: true,
      supervisedResults: withFailure,
    })).toMatchObject({ status: "completed" });
    expect(assessDelegationIntegration("Error: provider quota 2062; auth lacks a retry fence and database leases have a race.", {
      supervised: true,
      supervisedResults: withFailure,
    })).toMatchObject({ status: "completed" });
    expect(assessDelegationIntegration("Provider quota 2062 was exceeded; auth lacks a retry fence and database leases have a race.", {
      supervised: true,
      supervisedResults: withFailure,
    })).toMatchObject({ status: "completed" });
    expect(assessDelegationIntegration("No error: provider quota 2062; auth lacks a retry fence and database leases have a race.", {
      supervised: true,
      supervisedResults: withFailure,
    })).toMatchObject({ status: "incomplete", issue: "result_evidence_missing" });
  });

  test("does not waive supervised results that returned no concrete evidence", () => {
    const results = [
      { taskId: "task_1", status: "completed", summary: "Done." },
      { taskId: "task_2", status: "completed", summary: "已完成。" },
    ];
    expect(assessDelegationIntegration("Database schema uses UUID primary keys.", {
      supervised: true,
      supervisedResults: results,
    })).toMatchObject({ status: "incomplete", issue: "result_evidence_missing" });
    expect(assessDelegationIntegration(
      "Task task_1 is missing specific evidence; follow-up inspection is required.",
      { supervised: true, supervisedResults: results },
    )).toMatchObject({ status: "completed" });
  });

  test("does not close a supervised workflow with no decoded task or failure result", () => {
    expect(assessDelegationIntegration("Database schema uses UUID primary keys.", {
      supervised: true,
      supervisedResults: [],
    })).toMatchObject({ status: "incomplete", issue: "result_evidence_missing" });
  });

  test("repair prompt requires result reading, follow-up, verification, and synthesis", () => {
    const assessment = assessDelegationIntegration("All agents completed.");
    if (assessment.status !== "incomplete") throw new Error("expected incomplete integration");
    const prompt = delegationIntegrationRepairPrompt(assessment);
    expect(prompt).toContain("Read every returned task result");
    expect(prompt).toContain("wait, follow up, or verify");
    expect(prompt).toContain("substantive integrated findings");
  });
});
