import { expect, test } from "bun:test";
import type { UserInputRequest } from "../shared/contracts.js";
import { buildUserInputAnswers } from "./user-input-model.js";

test("custom text replaces a selected option for single-choice input", () => {
  expect(buildUserInputAnswers(request(false), { editor: ["VS Code"] }, { editor: "Zed" })).toEqual({
    editor: ["Zed"],
  });
});

test("multiple-choice input combines selected and custom answers without duplicates", () => {
  expect(buildUserInputAnswers(request(true), { editor: ["VS Code", "Zed"] }, { editor: "Zed" })).toEqual({
    editor: ["VS Code", "Zed"],
  });
});

test("answer projection treats prototype property names as own data keys", () => {
  for (const id of ["__proto__", "constructor"] as const) {
    const selected = Object.fromEntries([[id, ["Zed"]]]) as Record<string, string[]>;
    const answers = buildUserInputAnswers(request(false, id), selected, {});
    expect(Object.prototype.hasOwnProperty.call(answers, id)).toBe(true);
    expect(answers[id]).toEqual(["Zed"]);
  }
  expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
});

function request(multiple: boolean, questionId = "editor"): UserInputRequest {
  return {
    id: "userinput_1",
    sessionId: "session_1",
    callId: "toolcall_1",
    createdAt: 1,
    questions: [{
      id: questionId,
      header: "Editor",
      question: "Which editor should Chili use?",
      options: [
        { label: "VS Code", description: "Use Visual Studio Code." },
        { label: "Zed", description: "Use Zed." },
      ],
      ...(multiple ? { multiple: true } : {}),
    }],
  };
}
