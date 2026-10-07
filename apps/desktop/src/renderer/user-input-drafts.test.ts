import { expect, test } from "bun:test";
import type { UserInputRequest } from "../shared/contracts.js";
import {
  createUserInputDraft,
  customUserInputAnswer,
  selectedUserInputOptions,
  selectUserInputOption,
  setUserInputCustomAnswer,
} from "./user-input-drafts.js";
import { buildUserInputAnswers } from "./user-input-model.js";

test("single-choice drafts keep custom text and predefined options mutually exclusive", () => {
  const request = inputRequest();
  const question = request.questions[0]!;
  const empty = createUserInputDraft();
  const selected = selectUserInputOption(empty, question, "自然");
  const custom = setUserInputCustomAnswer(selected, question, "  留白更多  ");
  expect(buildUserInputAnswers(request, custom.selected, custom.custom)).toEqual({ style: ["留白更多"] });
  const reselected = selectUserInputOption(custom, question, "简洁");
  expect(buildUserInputAnswers(request, reselected.selected, reselected.custom)).toEqual({ style: ["简洁"] });
  expect(customUserInputAnswer(reselected, "style")).toBe("");
  expect(selectedUserInputOptions(empty, "style")).toEqual([]);
  expect(customUserInputAnswer(custom, "style")).toBe("  留白更多  ");
});

test("multiple-choice drafts retain custom text while options toggle independently", () => {
  const request = inputRequest(true);
  const question = request.questions[0]!;
  const custom = setUserInputCustomAnswer(createUserInputDraft(), question, "温暖");
  const selected = selectUserInputOption(selectUserInputOption(custom, question, "自然"), question, "简洁");
  const toggled = selectUserInputOption(selected, question, "自然");
  expect(buildUserInputAnswers(request, toggled.selected, toggled.custom)).toEqual({ style: ["简洁", "温暖"] });
  expect(selectedUserInputOptions(selected, "style")).toEqual(["自然", "简洁"]);
});

test("unrecognized choices do not mutate a retained draft", () => {
  const draft = createUserInputDraft();
  expect(selectUserInputOption(draft, inputRequest().questions[0]!, "unknown")).toBe(draft);
});

test("question identifiers that match prototype properties remain isolated data", () => {
  for (const id of ["__proto__", "constructor", "toString"]) {
    const question = { ...inputRequest().questions[0]!, id };
    const empty = createUserInputDraft();
    expect(selectedUserInputOptions(empty, id)).toEqual([]);
    expect(customUserInputAnswer(empty, id)).toBe("");
    const selected = selectUserInputOption(empty, question, "自然");
    expect(selectedUserInputOptions(selected, id)).toEqual(["自然"]);
    const custom = setUserInputCustomAnswer(selected, question, "温暖");
    expect(selectedUserInputOptions(custom, id)).toEqual([]);
    expect(customUserInputAnswer(custom, id)).toBe("温暖");
    expect(Object.getPrototypeOf(custom.custom)).toBe(Object.prototype);
  }
});

function inputRequest(multiple = false): UserInputRequest {
  return {
    id: "input_1",
    sessionId: "session_1",
    callId: "call_1",
    createdAt: 1,
    questions: [{
      id: "style",
      header: "风格",
      question: "希望页面是什么感觉？",
      multiple,
      options: [{ label: "自然" }, { label: "简洁" }],
    }],
  };
}
