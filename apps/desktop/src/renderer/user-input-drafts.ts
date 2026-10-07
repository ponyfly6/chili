import type { UserInputRequest } from "../shared/contracts.js";

export interface UserInputDraft {
  selected: Record<string, string[]>;
  custom: Record<string, string>;
}

type UserInputQuestion = UserInputRequest["questions"][number];

export function createUserInputDraft(): UserInputDraft {
  return { selected: {}, custom: {} };
}

export function selectUserInputOption(
  draft: UserInputDraft,
  question: UserInputQuestion,
  label: string,
): UserInputDraft {
  if (!question.options.some((option) => option.label === label)) return draft;
  const current = ownValue(draft.selected, question.id) ?? [];
  const selected = question.multiple
    ? current.includes(label) ? current.filter((value) => value !== label) : [...current, label]
    : [label];
  return {
    selected: { ...draft.selected, [question.id]: selected },
    custom: question.multiple ? draft.custom : { ...draft.custom, [question.id]: "" },
  };
}

export function setUserInputCustomAnswer(
  draft: UserInputDraft,
  question: UserInputQuestion,
  value: string,
): UserInputDraft {
  return {
    selected: !question.multiple && value.trim()
      ? { ...draft.selected, [question.id]: [] }
      : draft.selected,
    custom: { ...draft.custom, [question.id]: value },
  };
}

export function selectedUserInputOptions(draft: UserInputDraft, questionId: string): readonly string[] {
  return ownValue(draft.selected, questionId) ?? [];
}

export function customUserInputAnswer(draft: UserInputDraft, questionId: string): string {
  return ownValue(draft.custom, questionId) ?? "";
}

function ownValue<Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
