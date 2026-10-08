import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildInputAnswers, canSubmitInput, InputRequestCard } from "./InputRequestCard.js";
import { QuestionSheets } from "./QuestionSheets.js";
import { Sheet } from "./Sheet.js";
import type { RemoteInputRequest } from "./view-model.js";

const request: RemoteInputRequest = {
  id: "input_1",
  createdAt: "2026-10-07T12:00:00.000Z",
  questions: [
    {
      id: "platform", header: "平台", question: "先支持哪个平台？",
      options: [
        { label: "iOS", description: "先提供手机测试版" },
        { label: "Android", description: "先提供安卓版本" },
      ],
    },
    {
      id: "features", header: "功能", question: "首版包含哪些功能？", multiple: true,
      options: [
        { label: "通知", description: "任务完成时提醒" },
        { label: "图片", description: "补充截图" },
      ],
    },
    { id: "note", header: "补充", question: "还有什么要求？", options: [] },
  ],
};

const validDraft = { platform: ["iOS"], features: ["图片", "通知"], note: ["  优先大按钮，方便单手操作  "] };

describe("input request answers", () => {
  test("builds complete answers in option order and trims free text", () => {
    expect(canSubmitInput(request, validDraft)).toBe(true);
    expect(buildInputAnswers(request, validDraft)).toEqual({
      platform: ["iOS"], features: ["通知", "图片"], note: ["优先大按钮，方便单手操作"],
    });
    expect(validDraft.features).toEqual(["图片", "通知"]);
  });

  test("requires an answer to every question", () => {
    expect(canSubmitInput(request, {})).toBe(false);
    expect(buildInputAnswers(request, { ...validDraft, features: [] })).toBeNull();
    expect(buildInputAnswers(request, { platform: ["iOS"], features: ["通知"] })).toBeNull();
  });

  test("choice questions accept only exact offered labels", () => {
    for (const platform of [["Other"], ["其他"], ["iOS "], ["我的答案"], ["ios"]]) {
      expect(buildInputAnswers(request, { ...validDraft, platform })).toBeNull();
    }
    expect(buildInputAnswers(request, { ...validDraft, features: ["通知", "自定义"] })).toBeNull();
  });

  test("single choice rejects more than one answer and multi choice rejects duplicates", () => {
    expect(buildInputAnswers(request, { ...validDraft, platform: ["iOS", "Android"] })).toBeNull();
    expect(buildInputAnswers(request, { ...validDraft, platform: ["iOS", "iOS"] })).toBeNull();
    expect(buildInputAnswers(request, { ...validDraft, features: ["通知", "通知"] })).toBeNull();
    expect(canSubmitInput(request, { ...validDraft, features: ["通知"] })).toBe(true);
  });

  test("free text needs exactly one nonempty value even when multiple is enabled", () => {
    const freeTextRequest: RemoteInputRequest = {
      ...request, questions: [{ id: "note", header: "补充", question: "还有什么要求？", options: [], multiple: true }],
    };
    for (const note of [[], [""], [" \n\t "], ["第一条", "第二条"]]) {
      expect(buildInputAnswers(freeTextRequest, { note })).toBeNull();
    }
    expect(buildInputAnswers(freeTextRequest, { note: ["  第一条  "] })).toEqual({ note: ["第一条"] });
  });

  test("does not submit stale question IDs or ambiguous requests", () => {
    expect(buildInputAnswers(request, { ...validDraft, stale: ["旧回答"] })).toBeNull();
    expect(buildInputAnswers({ ...request, questions: [] }, {})).toBeNull();
    const question = request.questions[0]!;
    expect(buildInputAnswers({ ...request, questions: [question, question] }, { platform: ["iOS"] })).toBeNull();
    expect(buildInputAnswers({ ...request, questions: [{ ...question, options: [question.options[0]!, question.options[0]!] }] }, { platform: ["iOS"] })).toBeNull();
  });

  test("keeps answers within the desktop protocol text limits", () => {
    for (const answer of ["第一行\n第二行", "含\t制表符", "含\u0000控制字符", "含\u007f删除字符", "字".repeat(8_001)]) {
      expect(buildInputAnswers(request, { ...validDraft, note: [answer] })).toBeNull();
    }
    expect(canSubmitInput(request, { ...validDraft, note: ["字".repeat(8_000)] })).toBe(true);
    const largeRequest: RemoteInputRequest = {
      ...request,
      questions: [{ id: "many", header: "选择", question: "选择？", multiple: true, options: ["甲", "乙", "丙", "丁"].map((label) => ({ label: label.repeat(8_000), description: "说明" })) }],
    };
    expect(buildInputAnswers(largeRequest, { many: largeRequest.questions[0]!.options.map((option) => option.label) })).toBeNull();
  });

  test("question IDs cannot read inherited answers or change the result prototype", () => {
    const specialRequest: RemoteInputRequest = {
      ...request, questions: [{ id: "__proto__", header: "补充", question: "要求？", options: [] }],
    };
    expect(buildInputAnswers(specialRequest, {})).toBeNull();
    const result = buildInputAnswers(specialRequest, Object.fromEntries([["__proto__", ["可以"]]]));
    expect(result).not.toBeNull();
    expect(Object.hasOwn(result!, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});

describe("input request card markup", () => {
  function render(disabled = false, pending = false, inputRequest = request): string {
    return renderToStaticMarkup(<InputRequestCard request={inputRequest} disabled={disabled} pending={pending} onAnswer={() => { throw new Error("Rendering cannot answer"); }} />);
  }

  test("renders native single and multiple choices and free text without inventing Other", () => {
    const html = render();
    expect(html).toContain("需要你的回答");
    expect(html).toContain("先提供手机测试版");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/type="text"/g)).toHaveLength(1);
    expect(html).toContain('maxLength="8000"');
    expect(html).toContain("请选择一项");
    expect(html).toContain("可选择多项");
    expect(html).toContain('aria-label="补充：还有什么要求？"');
    expect(html).not.toContain("Other");
    expect(html).not.toContain("其他");
    expect(html).toContain('type="submit" disabled=""');
  });

  test("disabled and pending states lock every question and submission", () => {
    for (const html of [render(true, false), render(false, true)]) {
      expect(html.match(/<fieldset class="input-question" disabled=""/g)).toHaveLength(3);
      expect(html).toContain('type="submit" disabled=""');
    }
    const pendingHtml = render(false, true);
    expect(pendingHtml).toContain('aria-busy="true"');
    expect(pendingHtml).toContain("正在提交…");
  });

  test("renders request text and option descriptions as escaped text", () => {
    const html = render(false, false, {
      ...request,
      questions: [{ id: "safe", header: "<script>标题</script>", question: "<img src=x>", options: [{ label: "<b>选项</b>", description: "<script>说明</script>" }] }],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;标题&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;说明&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;选项&lt;/b&gt;");
  });

  test("a controlled draft restores choices and text without changing the saved answers", () => {
    const original = JSON.stringify(validDraft);
    const html = renderToStaticMarkup(<InputRequestCard request={request} draft={validDraft}
      onDraftChange={() => { throw new Error("Rendering cannot edit a draft"); }}
      disabled={false} pending={false} onAnswer={() => { throw new Error("Rendering cannot answer"); }} />);
    expect(html.match(/checked=""/g)).toHaveLength(3);
    expect(html).toContain('value="  优先大按钮，方便单手操作  "');
    expect(html).not.toContain('type="submit" disabled=""');
    expect(JSON.stringify(validDraft)).toBe(original);
  });

  test("controlled drafts still reject answers from a previous question", () => {
    const nextRequest = { ...request, questions: [{ id: "new-platform", header: "新平台", question: "使用哪个平台？", options: request.questions[0]!.options }] };
    const html = renderToStaticMarkup(<InputRequestCard request={nextRequest} draft={validDraft}
      disabled={false} pending={false} onAnswer={() => { throw new Error("Rendering cannot answer"); }} />);
    expect(html).toContain('type="submit" disabled=""');
    expect(html).not.toContain('checked=""');
  });
});

describe("question sheet boundaries", () => {
  test("a closed sheet keeps its content mounted without exposing a nonmodal dialog", () => {
    const html = renderToStaticMarkup(<Sheet open={false} title="回答问题" onClose={() => { throw new Error("Rendering cannot dismiss"); }}>
      <span>保留的回答</span>
    </Sheet>);
    expect(html).toContain("<dialog");
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("保留的回答");
    expect(html).not.toContain(' open=""');
    expect(html).toContain('aria-label="关闭"');
  });

  test("unknown answer outcomes block every control inside the question sheet", () => {
    const html = renderToStaticMarkup(<QuestionSheets sessionId="task_1" requests={[request]}
      openRequestId={request.id} onOpenChange={() => { throw new Error("Rendering cannot open a sheet"); }}
      disabled={false} pendingId={null} unknownInputIds={[request.id]}
      onAnswer={() => { throw new Error("Rendering cannot answer"); }} />);
    expect(html).toContain("这次回答的送达结果尚未确认");
    expect(html.match(/<fieldset class="input-question" disabled=""/g)).toHaveLength(3);
    expect(html).toContain('type="submit" disabled=""');
    expect(html.match(/data-testid="input-request-card"/g)).toHaveLength(1);
  });

  test("a pending answer locks every request without marking the other request as submitting", () => {
    const otherRequest = { ...request, id: "input_2" };
    const html = renderToStaticMarkup(<QuestionSheets sessionId="task_1" requests={[request, otherRequest]}
      openRequestId={request.id} onOpenChange={() => { throw new Error("Rendering cannot open a sheet"); }}
      disabled={false} pendingId={request.id} unknownInputIds={[]}
      onAnswer={() => { throw new Error("Rendering cannot answer"); }} />);
    expect(html.match(/<fieldset class="input-question" disabled=""/g)).toHaveLength(6);
    expect(html.match(/aria-busy="true"/g)).toHaveLength(1);
    expect(html.match(/aria-busy="false"/g)).toHaveLength(1);
  });

  test("no selected task exposes no previous task's question form", () => {
    const html = renderToStaticMarkup(<QuestionSheets sessionId={null} requests={[request]}
      openRequestId={request.id} onOpenChange={() => { throw new Error("Rendering cannot open a sheet"); }}
      disabled={false} pendingId={null} unknownInputIds={[]}
      onAnswer={() => { throw new Error("Rendering cannot answer"); }} />);
    expect(html).toBe("");
  });
});
