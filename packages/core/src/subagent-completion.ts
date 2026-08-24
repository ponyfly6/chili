export type SubagentCompletionIssue = "empty" | "acknowledgement_only" | "planning_only" | "no_evidence";
export type DelegationIntegrationIssue = SubagentCompletionIssue
  | "orchestration_status_only"
  | "generic_integration_only"
  | "result_evidence_missing";

export interface SubagentCompletionAssessmentOptions {
  /** Set only when the assignment contract explicitly requires repository/tool evidence. */
  evidenceRequired?: boolean;
  /** True when the runner observed the evidence required by the assignment contract. */
  evidenceObserved?: boolean;
}

export type SubagentCompletionAssessment =
  | {
      status: "completed";
      summary: string;
    }
  | {
      status: "incomplete";
      issue: SubagentCompletionIssue;
      summary?: string;
    };

const ACKNOWLEDGEMENT_ONLY = /^(?:ok(?:ay)?|sure|got it|understood|sounds good|will do|on it|好的?|收到|明白)[.!。！\s]*$/iu;

const ENGLISH_PLANNING_CLAUSE = new RegExp(
  [
    "^(?:okay|sure|got it|understood)?[,;:\\s-]*",
    "(?:",
    "i(?:(?:'ll| will| should)(?! not\\b)| am going to|'m going to| am about to| need to)\\b",
    "|we(?:(?:'ll| will| should)(?! not\\b)| are going to|'re going to| need to)\\b",
    "|let(?:'s| us| me)\\b",
    "|(?:my |the )?next step is\\b",
    "|to (?:start|begin)\\b",
    "|(?:starting|beginning) (?:with|by)\\b",
    "|i(?:'m| am) (?:starting|working|checking|looking|analyzing|analysing|reviewing|investigating)\\b",
    ")",
  ].join(""),
  "iu",
);

const ENGLISH_SEQUENCED_PLANNING_CLAUSE = new RegExp(
  [
    "^(?:next|first|firstly)[,;:-]\\s*",
    "(?:",
    "i(?:(?:'ll| will| should)(?! not\\b)| am going to|'m going to| am about to| need to)\\b",
    "|we(?:(?:'ll| will| should)(?! not\\b)| are going to|'re going to| need to)\\b",
    "|let(?:'s| us| me)\\b",
    "|(?:inspect|check|review|analy[sz]e|investigate|read|map|scan|start|begin)\\b",
    ")",
  ].join(""),
  "iu",
);

const CHINESE_PLANNING_CLAUSE = /^(?:(?:好的?|收到|明白|可以)[，、,:：\s-]*)?(?:(?:让我(?:先|来)?|(?:我|我们)(?:先|接下来|下一步|现在)?(?:会|将|要|准备|需要|打算|先去|去))(?:检查|查看|看看|分析|研究|阅读|梳理|映射|扫描|调查|确认|理解|处理|开始|继续)|(?:接下来|下一步)(?:我|我们)?(?:会|将|要|准备)|(?:先|现在)从.+开始)/u;

/**
 * Conservatively checks whether a subagent's terminal text is an actual result.
 *
 * Unknown or very short answers are accepted. Only empty text, bare acknowledgements,
 * and responses made entirely of high-confidence future-work clauses are rejected.
 */
export function assessSubagentCompletion(
  summary: string | undefined,
  options: SubagentCompletionAssessmentOptions = {},
): SubagentCompletionAssessment {
  const normalized = summary?.trim();
  if (!normalized) return { status: "incomplete", issue: "empty" };

  if (ACKNOWLEDGEMENT_ONLY.test(normalized)) {
    return { status: "incomplete", issue: "acknowledgement_only", summary: normalized };
  }

  const clauses = completionClauses(normalized);
  if (clauses.length > 0 && clauses.every(isPlanningClause)) {
    return { status: "incomplete", issue: "planning_only", summary: normalized };
  }

  if (options.evidenceRequired && !options.evidenceObserved) {
    return { status: "incomplete", issue: "no_evidence", summary: normalized };
  }

  return { status: "completed", summary: normalized };
}

export function subagentCompletionRepairPrompt(assessment: Extract<SubagentCompletionAssessment, { status: "incomplete" }>): string {
  const issue = assessment.issue === "empty"
    ? "It did not contain a final result."
    : assessment.issue === "acknowledgement_only"
      ? "It only acknowledged the assignment."
      : assessment.issue === "planning_only"
        ? "It only described work you intended to do."
        : "It did not provide the evidence required by the assignment.";

  return [
    `Your previous response was incomplete. ${issue}`,
    "Continue the assigned task now and use tools when the task requires repository evidence.",
    "Do not respond with another acknowledgement or plan.",
    "Return the actual findings, changes, verification, or concrete blocker when finished.",
  ].join(" ");
}

export type DelegationIntegrationAssessment =
  | {
      status: "completed";
      summary: string;
    }
  | {
      status: "incomplete";
      issue: DelegationIntegrationIssue;
      summary?: string;
    };

export interface DelegationIntegrationAssessmentOptions {
  /**
   * Supervised collaboration promises active review and synthesis. A bare
   * verdict such as "Reviewed" is not enough to close that stronger contract.
   */
  supervised?: boolean;
  supervisedResults?: readonly {
    taskId: string;
    status: string;
    summary?: string;
    error?: string;
  }[];
}

/**
 * Checks the parent's response after required delegated work returned. This is
 * intentionally conservative: it repairs only the same high-confidence
 * acknowledgement/planning failures as child completion plus responses made
 * entirely of orchestration status (for example, "I launched 10 agents").
 */
export function assessDelegationIntegration(
  summary: string | undefined,
  options: DelegationIntegrationAssessmentOptions = {},
): DelegationIntegrationAssessment {
  const completion = assessSubagentCompletion(summary);
  if (completion.status === "incomplete") return completion;

  const clauses = delegationStatusClauses(completion.summary);
  if (clauses.length > 0 && clauses.every(isDelegationStatusClause)) {
    return {
      status: "incomplete",
      issue: "orchestration_status_only",
      summary: completion.summary,
    };
  }

  if (options.supervised && !hasSubstantiveSupervisedIntegration(completion.summary)) {
    return {
      status: "incomplete",
      issue: "generic_integration_only",
      summary: completion.summary,
    };
  }

  if (options.supervised && !coversSupervisedResultEvidence(completion.summary, options.supervisedResults ?? [])) {
    return {
      status: "incomplete",
      issue: "result_evidence_missing",
      summary: completion.summary,
    };
  }

  return completion;
}

export function delegationIntegrationRepairPrompt(
  assessment: Extract<DelegationIntegrationAssessment, { status: "incomplete" }>,
): string {
  const issue = assessment.issue === "orchestration_status_only"
    ? "It only reported delegation status instead of integrating the delegated results."
    : assessment.issue === "generic_integration_only"
      ? "It only gave a generic review verdict without reporting any delegated finding, change, verification, or blocker."
    : assessment.issue === "result_evidence_missing"
      ? "It gave a concrete-sounding answer, but did not cover the actual evidence returned by enough supervised tasks."
    : assessment.issue === "empty"
      ? "It did not contain a final answer."
      : assessment.issue === "acknowledgement_only"
        ? "It only acknowledged the work."
        : assessment.issue === "planning_only"
          ? "It only described work you intended to do."
          : "It did not provide the required evidence.";

  return [
    `Your previous parent response was incomplete. ${issue}`,
    "Continue the original user request now.",
    "Read every returned task result already present in the conversation; do not merely announce that agents were launched or completed.",
    "For failed, incomplete, cancelled, missing, or contradictory results, wait, follow up, or verify with tools when needed.",
    "Then give the user the substantive integrated findings, changes, verification, or concrete blocker.",
  ].join(" ");
}

const GENERIC_SUPERVISED_ENGLISH_TOKENS = new Set([
  "a", "added", "all", "an", "and", "agent", "agents", "approve", "approved", "are", "as", "at", "be", "been",
  "before", "blocked", "bug", "bugs", "call", "calls", "changed", "complete", "completed", "concern", "concerns", "confirmed", "contain", "contains",
  "correct", "define", "defines", "did", "do", "done", "error", "errors", "everything", "export", "exports", "failed", "failure", "failures", "fine", "fixed",
  "for", "found", "from", "good", "great", "had", "has", "have", "i", "identified", "implemented", "import", "imports", "in",
  "incorrect", "integrated", "integration", "is", "issue", "issues", "it", "lack", "lacks", "lgtm", "look", "looks",
  "missing", "mismatch", "my", "no", "of", "ok", "okay", "on", "or", "our", "out", "passed", "passes",
  "read", "reads", "removed", "report", "reports", "result", "results", "return", "returns", "review", "reviewed", "reviewing", "set", "sets", "solid", "subagent", "subagents",
  "task", "tasks", "test", "tests", "that", "the", "their", "these", "they", "this", "those", "to", "unsafe",
  "uses", "verified", "was", "we", "were", "with", "work", "worked", "working", "writes",
]);

function hasSubstantiveSupervisedIntegration(summary: string): boolean {
  const normalized = summary
    .trim()
    .replace(/^[\s*_`#]+|[\s*_`#.!?。！？]+$/gu, "")
    .replace(/\s+/gu, " ");
  if (!normalized) return false;

  const terms = supervisedEvidenceTerms(normalized);
  const englishOutcome = /\b(?:added|blocked|calls?|changed|confirmed|contains?|correct|defines?|error|exports?|failed?|fixed|found|identified|implemented|imports?|incorrect|issue|issues|lacks?|missing|mismatch|passed|passes|reads?|regression|removed|returns?|sets?|unsafe|uses?|verified|writes?)\b/iu.test(normalized);
  const chineseOutcome = /(?:发现|确认|验证|缺少|缺失|错误|失败|通过|修复|新增|删除|修改|阻塞|不一致|竞态|风险|漏洞|未发现|原因|由于|因为|采用|使用|包含|定义|调用|返回|设置|读取|写入|导入|导出)/u.test(normalized);
  const hasChineseEvidence = [...terms].some((term) => term.startsWith("zh:"));

  return (englishOutcome && terms.size >= 2)
    || (chineseOutcome && (hasChineseEvidence || terms.size >= 1));
}

function supervisedEvidenceTerms(text: string): Set<string> {
  const english = (text.toLowerCase().match(/[a-z0-9][a-z0-9_./:-]*/gu) ?? [])
    .map(normalizeEvidenceToken)
    .filter((token) => token.length >= 2 && !GENERIC_SUPERVISED_ENGLISH_TOKENS.has(token));
  const chinese = text
    .replace(/(?:所有|全部|一个|子?代理|智能体|任务|结果|报告|测试|问题|缺陷|已经|审阅|审核|整合|完成|看起来|很好|不错|没有|没问题|都|均|已|了)/gu, "")
    .replace(/(?:发现|确认|验证|缺少|缺失|错误|失败|通过|修复|新增|删除|修改|阻塞|不一致|竞态|风险|漏洞|未发现|原因|由于|因为|采用|使用|包含|定义|调用|返回|设置|读取|写入|导入|导出)/gu, "")
    .match(/[\p{Script=Han}]+/gu) ?? [];
  const chineseBigrams = chinese.flatMap((segment) => {
    if (segment.length < 2) return [];
    return Array.from({ length: segment.length - 1 }, (_, index) => `zh:${segment.slice(index, index + 2)}`);
  });
  return new Set([...english, ...chineseBigrams]);
}

function normalizeEvidenceToken(token: string): string {
  const trimmed = token.replace(/^[./:-]+|[./:-]+$/gu, "");
  if (trimmed.length <= 4 || /[0-9_./:-]/u.test(trimmed)) return trimmed;
  return trimmed
    .replace(/ies$/u, "y")
    .replace(/(?:ing|ed|es|s)$/u, "");
}

function coversSupervisedResultEvidence(
  summary: string,
  results: readonly NonNullable<DelegationIntegrationAssessmentOptions["supervisedResults"]>[number][],
): boolean {
  if (results.length === 0) return false;
  const evidenceByTask = results.map((result) => {
    const text = [result.summary, result.error].filter((value): value is string => Boolean(value?.trim())).join(" ");
    return {
      result,
      terms: supervisedEvidenceTerms(text),
      abnormal: result.status !== "completed" || Boolean(result.error?.trim()),
    };
  });
  const finalTerms = supervisedEvidenceTerms(summary);
  const overlaps = (terms: ReadonlySet<string>) => [...terms].some((term) => finalTerms.has(term));
  const evidenceSegments = supervisedEvidenceSegments(summary);

  // Every abnormal result is material. If it contains a concrete error or
  // summary, the final must cover evidence that is distinctive from successful
  // sibling reports, or explicitly name the abnormal outcome while covering
  // the result. Shared module/topic words alone must not hide a failure. This
  // is an output-evidence gate, not proof that the model semantically read
  // every normal result.
  const abnormalCovered = evidenceByTask
    .filter(({ abnormal }) => abnormal)
    .every(({ result, terms }) => {
      const otherTerms = new Set(
        evidenceByTask
          .filter(({ result: sibling }) => sibling !== result)
          .flatMap(({ terms: siblingTerms }) => [...siblingTerms]),
      );
      const distinctiveTerms = new Set([...terms].filter((term) => !otherTerms.has(term)));
      const requiredTerms = distinctiveTerms.size > 0 ? distinctiveTerms : terms;
      if (terms.size === 0) {
        return evidenceSegments.some((segment) => {
          if (!namesNegativeOutcome(segment)) return false;
          return new RegExp(`\\b${escapeRegExp(result.status)}\\b`, "iu").test(segment)
            || result.status !== "completed";
        });
      }
      return evidenceSegments.some((segment) => {
        if (!namesNegativeOutcome(segment)) return false;
        const segmentTerms = supervisedEvidenceTerms(segment);
        const coveredTerms = [...requiredTerms].filter((term) => segmentTerms.has(term));
        return coveredTerms.length >= Math.min(2, requiredTerms.size);
      });
    });
  if (!abnormalCovered) return false;

  const zeroEvidenceNormals = evidenceByTask.filter(({ abnormal, terms }) => !abnormal && terms.size === 0);
  if (zeroEvidenceNormals.length > 0 && !reportsMissingConcreteResultEvidence(summary)) return false;
  const normalEvidence = evidenceByTask.filter(({ abnormal, terms }) => !abnormal && terms.size > 0);
  if (normalEvidence.length === 0) return true;
  const normalCovered = normalEvidence.filter(({ terms }) => overlaps(terms)).length;
  return normalCovered >= Math.min(2, normalEvidence.length);
}

function supervisedEvidenceSegments(summary: string): string[] {
  return summary
    .split(/[.!?;,\n。！？；，]+|\b(?:and|but|while|whereas)\b/iu)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function namesNegativeOutcome(segment: string): boolean {
  const withoutNegatedEnglish = segment.replace(
    /\b(?:no|not|isn'?t|wasn'?t|weren'?t|no longer)\s+(?:(?:an?|the)\s+)?(?:blocked|cancelled|canceled|denied|errors?|errored|exceeded|exhausted|failed|incomplete|limited|prevented|rejected|stopped|timed out|unavailable|unverified)\b/giu,
    "",
  );
  const withoutNegatedChinese = withoutNegatedEnglish.replace(
    /(?:没有|并未|不是|不再)(?:失败|阻塞|取消|不完整|错误|超限|超时|受限|拒绝|耗尽|中止)/gu,
    "",
  );
  return /\b(?:blocked|cancelled|canceled|cannot|can't|could not|denied|errors?|errored|exceeded|exhausted|failed|failure|incomplete|limited|prevented|rate[- ]limited|rejected|stopped|timed out|timeout|unable|unavailable|unverified)\b|(?:失败|阻塞|无法|未能|取消|不完整|错误|超限|超时|受限|拒绝|耗尽|中止)/iu.test(withoutNegatedChinese);
}

function reportsMissingConcreteResultEvidence(summary: string): boolean {
  return /\b(?:no|without|lacks?|missing)\s+(?:(?:specific|concrete|usable)\s+)?(?:evidence|details?|findings?|summary)\b|\b(?:result|report|task)\b.{0,32}\b(?:only\s+(?:said|reported)|provided no)\b|(?:未|没有)(?:提供|包含)?(?:具体|可用)?(?:证据|细节|结论)|仅(?:报告|回复|返回).{0,12}(?:完成|无问题)/iu.test(summary);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function completionClauses(summary: string): string[] {
  return summary
    .split(/[.!?。！？]+|\n+/u)
    .map((clause) => clause.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, ""))
    .filter(Boolean);
}

function isPlanningClause(clause: string): boolean {
  return ENGLISH_PLANNING_CLAUSE.test(clause)
    || ENGLISH_SEQUENCED_PLANNING_CLAUSE.test(clause)
    || CHINESE_PLANNING_CLAUSE.test(clause);
}

function isDelegationStatusClause(clause: string): boolean {
  const normalized = clause
    .trim()
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/[,;，；]+$/u, "")
    .trim();
  if (!normalized || /[:：]/u.test(normalized)) return false;

  return /^(?:(?:i|we)(?:'ve| have)?\s+)?(?:just\s+)?(?:successfully\s+)?(?:started|launched|spawned|delegated|dispatched)\s+(?:(?:all|the)\s+)?(?:\d+\s+)?(?:sub-?agents?|agents?|workers?|tasks?)(?:\s+in parallel)?$/iu.test(normalized)
    || /^(?:(?:all|the)\s+)?(?:\d+\s+)?(?:sub-?agents?|agents?|workers?|tasks?)(?:\s+have|\s+are|\s+were)?\s+(?:started|running|complete|completed|finished|done|returned)$/iu.test(normalized)
    || /^(?:they\s+)?(?:all\s+)?(?:have\s+)?(?:completed|finished|returned)(?:\s+successfully)?$/iu.test(normalized)
    || /^(?:no|without)\s+(?:failures?|errors?|timeouts?|file changes?)(?:(?:,|\/|\s+or|\s+and)\s*(?:failures?|errors?|timeouts?|file changes?))*$/iu.test(normalized)
    || /^(?:(?:我|我们)?(?:已|已经|刚刚)?(?:成功)?(?:并行)?(?:启动|派出|创建|安排|调度)(?:了)?\s*(?:全部|所有|\d+\s*个)?\s*(?:子)?(?:代理|智能体|sub-?agents?|agents?)(?:任务)?(?:并行执行|执行|运行)?|(?:(?:全部|所有)\s*)?(?:\d+\s*个)?\s*(?:子)?(?:代理|智能体|sub-?agents?|agents?|任务)(?:都|均)?(?:已|已经)?(?:启动|运行|完成|结束|跑完|返回)(?:了)?|(?:全部|所有|它们)(?:都|均)?(?:已|已经)?(?:完成|结束|跑完|返回)(?:了)?|无(?:失败|错误|超时|文件修改)(?:[、或和及]*(?:失败|错误|超时|文件修改))*)$/iu.test(normalized);
}

function delegationStatusClauses(summary: string): string[] {
  return summary
    .split(/[.!?。！？,，;；]+|\n+/u)
    .map((clause) => clause.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, ""))
    .filter(Boolean);
}
