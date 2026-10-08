import { describe, expect, test } from "bun:test";
import { MAX_PROMPT_BYTES, canSendPrompt, errorMessage, promptByteLength, readAnswerReceipt, readSendReceipt, readStopReceipt, readTaskList, readTaskSnapshot, recoveryNeedsPairing, runStatusLabel, visibleMobilePanel } from "./view-model.js";

const task = { id: "session_1", title: "Existing task", status: "active", updatedAt: 1_700_000_000_000 };
const snapshot = {
  session: { ...task, runStatus: "running", queuedCount: 0, needsDesktop: { input: false } },
  messages: [{ id: "message_1", role: "assistant", text: "Recent visible message", createdAt: 1_700_000_000_000 }],
  truncated: false,
};

describe("mobile public projection", () => {
  test("desktop input is the only desktop prompt flag and retired approval states stay historical", () => {
    expect(readTaskSnapshot(snapshot).session.needsDesktop).toEqual({ input: false });
    const legacy = readTaskSnapshot({ ...snapshot, session: { ...snapshot.session, runStatus: "waiting_for_approval", needsDesktop: { input: false, approval: true } } });
    expect(legacy.session.needsDesktop).toEqual({ input: false });
    expect(runStatusLabel(legacy.session.runStatus)).toBe("旧审批已停止");
    expect(runStatusLabel("waiting_for_input")).toBe("等待你的回答");
  });

  test("mobile questions keep their complete choices and omit unrelated tool fields", () => {
    const input = { id: "input-1", createdAt: 1_700_000_000_000, questions: [{ id: "q1", header: "方向", question: "先做哪一项？", options: [{ label: "连接", description: "连接电脑" }, { label: "通知", description: "接收提醒" }], multiple: true }], toolInput: "secret" };
    const parsed = readTaskSnapshot({ ...snapshot, inputRequests: [input] });
    expect(parsed.inputRequests[0]?.questions[0]?.options).toEqual(input.questions[0]?.options);
    expect(parsed.inputRequests[0]?.createdAt).toBe("2023-11-14T22:13:20.000Z");
    expect(JSON.stringify(parsed.inputRequests)).not.toContain("secret");
    expect(readTaskSnapshot(snapshot).inputRequests).toEqual([]);
    for (const invalid of [
      [input, input],
      [{ ...input, questions: [{ ...input.questions[0], options: [{ label: "一项", description: "" }] }] }],
      [{ ...input, questions: [{ ...input.questions[0], id: "__proto__" }] }],
      [{ ...input, questions: [{ ...input.questions[0], question: "长".repeat(2001) }] }],
      [{ ...input, questions: [{ ...input.questions[0], options: [{ label: "重复", description: "" }, { label: "重复", description: "" }] }] }],
    ]) expect(() => readTaskSnapshot({ ...snapshot, inputRequests: invalid })).toThrow();
  });
  test("only copies allowlisted summary and snapshot fields for display", () => {
    const list = readTaskList({ sessions: [{ ...task, cwd: "/private/workspace", children: ["child_1"] }], truncated: true });
    expect(list).toEqual({ sessions: [{ id: task.id, title: task.title, status: "active", updatedAt: "2023-11-14T22:13:20.000Z" }], truncated: true });
    const projected = readTaskSnapshot({
      ...snapshot,
      session: { ...snapshot.session, pendingApprovals: [{ toolInput: "secret" }] },
      events: [{ rawInput: "secret" }],
      messages: [{ ...snapshot.messages[0], reasoning: "secret" }],
    });
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(projected.messages[0]?.text).toBe("Recent visible message");
  });

  test("rejects tool/internal messages rather than displaying their contents", () => {
    expect(() => readTaskSnapshot({ ...snapshot, messages: [{ ...snapshot.messages[0], role: "tool" }] })).toThrow();
    expect(() => readTaskSnapshot({ ...snapshot, messages: Array.from({ length: 41 }, () => snapshot.messages[0]) })).toThrow();
    expect(() => readTaskSnapshot({ ...snapshot, session: { ...snapshot.session, queuedCount: -1 } })).toThrow();
  });

  test("accepts the adapter's maximum title and message id budgets", () => {
    const result = readTaskSnapshot({
      ...snapshot,
      session: { ...snapshot.session, title: "A".repeat(1022), needsDesktop: { input: true } },
      messages: [{ ...snapshot.messages[0], id: "m".repeat(254), text: "<script>not markup</script>" }],
    });
    expect(result.session.needsDesktop.input).toBe(true);
    expect(result.messages[0]?.text).toBe("<script>not markup</script>");
  });

  test("projects the queued delivery uncertainty flag without treating it as a desktop input request", () => {
    const uncertain = readTaskSnapshot({ ...snapshot, session: { ...snapshot.session, deliveryUnknown: true } });
    expect(uncertain.session.deliveryUnknown).toBe(true);
    expect(uncertain.session.needsDesktop).toEqual({ input: false });
    expect(readTaskSnapshot(snapshot).session.deliveryUnknown).toBe(false);
    expect(readTaskSnapshot({ ...snapshot, session: { ...snapshot.session, deliveryUnknown: false } }).session.deliveryUnknown).toBe(false);
    for (const invalid of ["false", "true", 0, 1, null, undefined]) {
      expect(() => readTaskSnapshot({ ...snapshot, session: { ...snapshot.session, deliveryUnknown: invalid } })).toThrow();
    }
  });
});

describe("mobile command safety", () => {
  test("revocation and fresh pairing cannot strand the phone in an empty detail panel", () => {
    expect(visibleMobilePanel("task", "old-session")).toBe("task");
    // Revocation clears the selected task; even a stale detail preference must
    // show the list before and after a new authorization arrives.
    expect(visibleMobilePanel("task", null)).toBe("list");
    expect(visibleMobilePanel("list", null)).toBe("list");
    expect(visibleMobilePanel("task", "new-session")).toBe("task");
    expect(visibleMobilePanel("list", "new-session")).toBe("list");
  });

  test("uses UTF-8 byte limits for multilingual prompts", () => {
    expect(canSendPrompt(" ")).toBe(false);
    expect(promptByteLength("手机🌶️")).toBeGreaterThan("手机🌶️".length);
    expect(canSendPrompt("a".repeat(MAX_PROMPT_BYTES))).toBe(true);
    expect(canSendPrompt("你".repeat(Math.floor(MAX_PROMPT_BYTES / 3) + 1))).toBe(false);
  });

  test("unknown outcomes explicitly prohibit automatic resend", () => {
    expect(errorMessage({ code: "outcome_unknown" })).toContain("可能已经执行");
    expect(errorMessage({ code: "outcome_unknown" })).toContain("不会自动重发");
    expect(errorMessage({ code: "credential_revoked" })).toContain("重新配对");
    expect(errorMessage({ code: "pairing_invalid" })).toContain("配对码已失效");
    expect(errorMessage({ code: "pairing_invalid" })).toContain("新配对码");
  });

  test("malformed mutation receipts remain unknown rather than claiming success or no operation", () => {
    expect(readSendReceipt({ status: "queued", position: 1 })).toBe("queued");
    expect(readStopReceipt({ interrupted: false })).toBe(false);
    expect(readAnswerReceipt({ resolved: false })).toBe(false);
    expect(readAnswerReceipt({ resolved: true })).toBe(true);
    for (const read of [readSendReceipt, readStopReceipt, readAnswerReceipt]) {
      try { read({}); throw new Error("Expected outcome to remain unknown"); }
      catch (error) { expect(error).toMatchObject({ code: "outcome_unknown" }); }
    }
  });

  test("expired or revoked recovery stops retries but temporary network failures do not", () => {
    for (const code of ["PAIRING_REQUIRED", "recovery_invalid", "RECOVERY_CONTEXT_MISMATCH", "RECOVERY_IDENTITY_INVALID", "RECOVERY_RECORD_INVALID", "credential_revoked"]) {
      expect(recoveryNeedsPairing({ code })).toBe(true);
      expect(errorMessage({ code })).toContain("重新配对");
    }
    for (const code of ["network_error", "unavailable", "HTTP_REQUEST_CANCELLED"]) expect(recoveryNeedsPairing({ code })).toBe(false);
    expect(errorMessage({ code: "RECOVERY_STORAGE_FAILED" })).toContain("手机未能保存连接");
  });

  test("unsupported encryption and untrusted HTTPS never suggest plaintext fallback", () => {
    expect(errorMessage({ code: "BROWSER_CRYPTO_UNSUPPORTED" })).toContain("不会降级为明文");
    expect(errorMessage({ code: "TRUSTED_HTTPS_REQUIRED" })).toContain("需要可信 HTTPS");
    expect(errorMessage(new Error("sensitive raw host stack"))).not.toContain("sensitive");
  });
});
