import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OutcomeWarnings } from "./OutcomeWarnings.js";
import {
  INITIAL_CONTROL_FEEDBACK,
  promptPreview,
  reduceControlFeedback,
  type ControlFeedback,
  type UnknownMutationOutcome,
} from "./control-feedback.js";

const send: UnknownMutationOutcome = {
  id: "1", sessionId: "session_old", sessionTitle: "部署前检查", command: "Queue",
  startedAt: 1_700_000_000_000, promptPreview: "先运行测试，再检查差异",
};
const stop: UnknownMutationOutcome = {
  id: "2", sessionId: "session_old", sessionTitle: "部署前检查", command: "Stop", startedAt: 1_700_000_000_100,
};

function rendered(state: ControlFeedback): string {
  return renderToStaticMarkup(<>
    {state.notice && <p data-testid="ordinary-notice">{state.notice.text}</p>}
    <OutcomeWarnings outcomes={state.unknownOutcomes} onConfirm={() => { throw new Error("No implicit confirmation"); }} />
  </>);
}

describe("unresolved mutation feedback", () => {
  test("lost send result remains visible through reconnect, reads and later success until explicit confirmation", () => {
    let state = reduceControlFeedback(INITIAL_CONTROL_FEEDBACK, { type: "mutation_unknown", outcome: send });
    for (const notice of [
      null,
      { kind: "success", text: "连接已恢复并同步请求序号。" },
      null,
      { kind: "success", text: "Stop 已由桌面接受。" },
      { kind: "success", text: "Steer 请求已由桌面接受。" },
      { kind: "error", text: "读取任务暂时失败。" },
    ] as const) {
      state = reduceControlFeedback(state, { type: "notice", notice });
      const html = rendered(state);
      expect(html).toContain("Queue 结果未知");
      expect(html).toContain("先运行测试，再检查差异");
      expect(html).toContain("session_old");
      expect(html).toContain('data-testid="unknown-confirm-1"');
      if (notice) expect(html).toContain(notice.text);
    }
    state = reduceControlFeedback(state, { type: "confirm_unknown", id: send.id });
    expect(rendered(state)).not.toContain('data-testid="outcome-unknown"');
    expect(state.notice?.text).toBe("读取任务暂时失败。");
  });

  test("concurrent Send and Stop outcomes cannot overwrite each other or be cleared together", () => {
    let state = reduceControlFeedback(INITIAL_CONTROL_FEEDBACK, { type: "mutation_unknown", outcome: stop });
    state = reduceControlFeedback(state, { type: "notice", notice: { kind: "success", text: "连接已恢复。" } });
    state = reduceControlFeedback(state, { type: "mutation_unknown", outcome: send });
    // A duplicated delivery of the same outcome cannot duplicate its warning.
    state = reduceControlFeedback(state, { type: "mutation_unknown", outcome: send });
    expect(state.unknownOutcomes).toHaveLength(2);
    expect(rendered(state)).toContain("Queue 结果未知");
    expect(rendered(state)).toContain("Stop 结果未知");
    state = reduceControlFeedback(state, { type: "confirm_unknown", id: "missing-command" });
    expect(state.unknownOutcomes).toHaveLength(2);
    state = reduceControlFeedback(state, { type: "confirm_unknown", id: send.id });
    expect(rendered(state)).not.toContain("Queue 结果未知");
    expect(rendered(state)).toContain("Stop 结果未知");
  });

  test("late outcomes keep their original task context through a different task or a new pairing", () => {
    let state = reduceControlFeedback(INITIAL_CONTROL_FEEDBACK, { type: "notice", notice: { kind: "success", text: "配对已通过桌面确认。" } });
    state = reduceControlFeedback(state, { type: "mutation_unknown", outcome: send });
    state = reduceControlFeedback(state, { type: "mutation_unknown", outcome: { ...stop, sessionId: "session_new", sessionTitle: "新的任务" } });
    state = reduceControlFeedback(state, { type: "notice", notice: { kind: "success", text: "本页的授权已清除。" } });
    const html = rendered(state);
    expect(html).toContain("部署前检查");
    expect(html).toContain("新的任务");
    expect(html).toContain("session_old");
    expect(html).toContain("session_new");
    expect(html).toContain("已核对，清除此提醒");
    expect(html).not.toContain("关闭提示");
    expect(state.unknownOutcomes).toHaveLength(2);
  });

  test("command context is bounded and rendered as text", () => {
    const preview = promptPreview(`  <script>unsafe</script>\n${"🌶".repeat(150)} `);
    expect(Array.from(preview)).toHaveLength(121);
    expect(preview).not.toContain("\n");
    const state = reduceControlFeedback(INITIAL_CONTROL_FEEDBACK, { type: "mutation_unknown", outcome: { ...send, promptPreview: preview } });
    expect(rendered(state)).not.toContain("<script>");
    expect(rendered(state)).toContain("&lt;script&gt;");
  });
});
