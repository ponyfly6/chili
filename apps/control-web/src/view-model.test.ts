import { describe, expect, test } from "bun:test";
import { MAX_PROMPT_BYTES, canSendPrompt, errorMessage, promptByteLength, readSendReceipt, readStopReceipt, readTaskList, readTaskSnapshot, visibleMobilePanel } from "./view-model.js";

const task = { id: "session_1", title: "Existing task", status: "active", updatedAt: 1_700_000_000_000 };
const snapshot = {
  session: { ...task, runStatus: "running", queuedCount: 0, needsDesktop: { approval: false, input: false } },
  messages: [{ id: "message_1", role: "assistant", text: "Recent visible message", createdAt: 1_700_000_000_000 }],
  truncated: false,
};

describe("mobile public projection", () => {
  test("preserves read-only history in summaries and snapshots without accepting malformed flags", () => {
    expect(readTaskList({ sessions: [{ ...task, readOnly: true }] }).sessions[0]?.readOnly).toBe(true);
    expect(readTaskSnapshot({ ...snapshot, session: { ...snapshot.session, readOnly: true } }).session.readOnly).toBe(true);
    expect(readTaskList({ sessions: [task] }).sessions[0]?.readOnly).toBeUndefined();
    for (const invalid of ["false", "true", 0, 1, null, {}]) {
      expect(() => readTaskList({ sessions: [{ ...task, readOnly: invalid }] })).toThrow();
      expect(() => readTaskSnapshot({ ...snapshot, session: { ...snapshot.session, readOnly: invalid } })).toThrow();
    }
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
      session: { ...snapshot.session, title: "A".repeat(1022), needsDesktop: { approval: true, input: false } },
      messages: [{ ...snapshot.messages[0], id: "m".repeat(254), text: "<script>not markup</script>" }],
    });
    expect(result.session.needsDesktop.approval).toBe(true);
    expect(result.messages[0]?.text).toBe("<script>not markup</script>");
  });

  test("projects the queued delivery uncertainty flag without treating it as a desktop approval", () => {
    const uncertain = readTaskSnapshot({ ...snapshot, session: { ...snapshot.session, deliveryUnknown: true } });
    expect(uncertain.session.deliveryUnknown).toBe(true);
    expect(uncertain.session.needsDesktop).toEqual({ approval: false, input: false });
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
  });

  test("malformed mutation receipts remain unknown rather than claiming success or no operation", () => {
    expect(readSendReceipt({ status: "queued", position: 1 })).toBe("queued");
    expect(readStopReceipt({ interrupted: false })).toBe(false);
    for (const read of [readSendReceipt, readStopReceipt]) {
      try { read({}); throw new Error("Expected outcome to remain unknown"); }
      catch (error) { expect(error).toMatchObject({ code: "outcome_unknown" }); }
    }
  });

  test("unsupported encryption and untrusted HTTPS never suggest plaintext fallback", () => {
    expect(errorMessage({ code: "BROWSER_CRYPTO_UNSUPPORTED" })).toContain("不会降级为明文");
    expect(errorMessage({ code: "TRUSTED_HTTPS_REQUIRED" })).toContain("需要可信 HTTPS");
    expect(errorMessage(new Error("sensitive raw host stack"))).not.toContain("sensitive");
  });
});
