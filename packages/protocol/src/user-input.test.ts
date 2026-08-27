import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs, ToolCallId, UserInputId, UserInputQuestion } from "./index.js";
import { parseUserInputAnswers, parseUserInputQuestions } from "./index.js";

const questions: UserInputQuestion[] = [
  {
    id: "editor",
    header: "Editor",
    question: "Which editor should Chili configure?",
    options: [
      { label: "VS Code", description: "Configure Visual Studio Code." },
      { label: "Zed", description: "Configure Zed." },
    ],
  },
  {
    id: "features",
    header: "Features",
    question: "Which optional features should be enabled?",
    options: [
      { label: "Lint", description: "Enable linting." },
      { label: "Format", description: "Enable formatting." },
    ],
    multiple: true,
  },
];

test("user input schemas validate and defensively copy questions and answers", () => {
  const parsedQuestions = parseUserInputQuestions(questions);
  const answers = parseUserInputAnswers({ editor: ["VS Code"], features: ["Lint", "Format"] }, parsedQuestions);

  expect(parsedQuestions).toEqual(questions);
  expect(answers).toEqual({ editor: ["VS Code"], features: ["Lint", "Format"] });
  expect(parsedQuestions).not.toBe(questions);
  expect(parsedQuestions[0]!.options).not.toBe(questions[0]!.options);
});

test("user input schemas reject malformed or over-capacity values", () => {
  expect(() => parseUserInputQuestions([])).toThrow("between 1 and 3");
  expect(() => parseUserInputQuestions([...questions, questions[0], questions[1]])).toThrow("between 1 and 3");
  expect(() => parseUserInputQuestions([{ ...questions[0], id: "bad id" }])).toThrow("letters, numbers");
  expect(() => parseUserInputQuestions([{ ...questions[0], header: "thirteen chars" }])).toThrow("12 characters");
  expect(() => parseUserInputQuestions([{ ...questions[0], options: [questions[0]!.options[0]!] }])).toThrow("between 2 and 3");
  expect(() => parseUserInputQuestions([{ ...questions[0], extra: true }])).toThrow("unexpected field");
  expect(() => parseUserInputQuestions([questions[0], { ...questions[0] }])).toThrow("must be unique");

  const parsedQuestions = parseUserInputQuestions(questions);
  expect(() => parseUserInputAnswers({ editor: ["VS Code"] }, parsedQuestions)).toThrow("every question");
  expect(() => parseUserInputAnswers({ editor: ["VS Code", "Zed"], features: ["Lint"] }, parsedQuestions)).toThrow("between 1 and 1");
  expect(() => parseUserInputAnswers({ editor: ["VS Code"], unknown: ["Lint"] }, parsedQuestions)).toThrow("unknown question id");
  expect(() => parseUserInputAnswers({ editor: ["\u0000"], features: ["Lint"] }, parsedQuestions)).toThrow("control characters");
});

test("user input identifiers cannot address prototype properties", () => {
  const protoAnswers = JSON.parse('{"__proto__":["polluted"]}') as unknown;
  const constructorAnswers = JSON.parse('{"constructor":["polluted"]}') as unknown;

  expect(() => parseUserInputAnswers(protoAnswers)).toThrow("prototype property name");
  expect(() => parseUserInputAnswers(constructorAnswers)).toThrow("prototype property name");
  expect(() => parseUserInputQuestions([{ ...questions[0], id: "constructor" }])).toThrow("prototype property name");
  expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
});

test("user input lifecycle events are part of ChiliEvent", () => {
  const sessionId = "session_user_input" as SessionId;
  const inputId = "userinput_1" as UserInputId;
  const callId = "toolcall_1" as ToolCallId;
  const requested: ChiliEvent = {
    id: "event_requested",
    type: "user_input.requested",
    time: 1 as TimestampMs,
    sessionId,
    payload: { inputId, callId, questions: parseUserInputQuestions(questions) },
  };
  const resolved: ChiliEvent = {
    id: "event_resolved",
    type: "user_input.resolved",
    time: 2 as TimestampMs,
    sessionId,
    payload: { inputId, answers: { editor: ["VS Code"], features: ["Lint"] } },
  };
  const cancelled: ChiliEvent = {
    id: "event_cancelled",
    type: "user_input.cancelled",
    time: 3 as TimestampMs,
    sessionId,
    payload: { inputId, reason: "session interrupted" },
  };

  expect([requested.type, resolved.type, cancelled.type]).toEqual([
    "user_input.requested",
    "user_input.resolved",
    "user_input.cancelled",
  ]);
});
