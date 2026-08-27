import type { UserInputRequest } from "../shared/contracts.js";

export function buildUserInputAnswers(
  request: UserInputRequest,
  selected: Readonly<Record<string, readonly string[]>>,
  custom: Readonly<Record<string, string>>,
): Record<string, string[]> {
  return Object.fromEntries(request.questions.map((question) => {
    const customAnswer = ownValue(custom, question.id)?.trim();
    if (customAnswer && question.multiple !== true) return [question.id, [customAnswer]];
    const values = [...(ownValue(selected, question.id) ?? [])];
    if (customAnswer) values.push(customAnswer);
    return [question.id, [...new Set(values)]];
  }));
}

function ownValue<Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
