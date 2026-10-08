import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { RemoteInputRequest } from "./view-model.js";

export type InputAnswerDraft = Readonly<Record<string, readonly string[]>>;

const MAX_ANSWER_CHARS = 8_000;
const MAX_TOTAL_ANSWER_CHARS = 24_000;

/** Only complete answers using the request's own choices may be submitted. */
export function buildInputAnswers(request: RemoteInputRequest, draft: InputAnswerDraft): Record<string, string[]> | null {
  const questionIds = new Set(request.questions.map((question) => question.id));
  if (questionIds.size === 0 || questionIds.size !== request.questions.length
    || Object.keys(draft).some((id) => !questionIds.has(id))) return null;

  const answers: [string, string[]][] = [];
  let totalChars = 0;
  for (const question of request.questions) {
    const selected = draftValues(draft, question.id);
    if (selected.length === 0 || selected.some((answer) => typeof answer !== "string"
      || answer.length > MAX_ANSWER_CHARS || /[\u0000-\u001f\u007f]/u.test(answer))) return null;
    totalChars += selected.reduce((total, answer) => total + answer.length, 0);
    if (totalChars > MAX_TOTAL_ANSWER_CHARS) return null;
    if (question.options.length === 0) {
      if (selected.length !== 1 || !selected[0]?.trim()) return null;
      answers.push([question.id, [selected[0].trim()]]);
      continue;
    }

    const labels = new Set(question.options.map((option) => option.label));
    if (labels.size !== question.options.length || new Set(selected).size !== selected.length
      || selected.some((answer) => !labels.has(answer))
      || (!question.multiple && selected.length !== 1)) return null;
    // Keep multi-select answers in the same order as the displayed choices.
    answers.push([question.id, [...labels].filter((label) => selected.includes(label))]);
  }
  return Object.fromEntries(answers);
}

export function canSubmitInput(request: RemoteInputRequest, draft: InputAnswerDraft): boolean {
  return buildInputAnswers(request, draft) !== null;
}

function draftValues(draft: InputAnswerDraft, id: string): readonly string[] {
  const values = Object.hasOwn(draft, id) ? draft[id] : undefined;
  return Array.isArray(values) ? values : [];
}

/** A controlled draft can outlive this card; remount when the question changes. */
export function InputRequestCard({ request, disabled, pending, onAnswer, draft: controlledDraft, onDraftChange }: {
  request: RemoteInputRequest;
  disabled: boolean;
  pending: boolean;
  onAnswer: (answers: Record<string, string[]>) => Promise<void> | void;
  draft?: InputAnswerDraft;
  onDraftChange?: (draft: InputAnswerDraft) => void;
}) {
  const instanceId = useId();
  const [localDraft, setLocalDraft] = useState<InputAnswerDraft>({});
  const draft = controlledDraft ?? localDraft;
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const submitPending = useRef(false);
  const busy = pending || submitting;
  const locked = disabled || busy;
  const complete = canSubmitInput(request, draft);
  const status = busy ? "正在提交回答…" : disabled ? "当前无法提交回答"
    : complete ? "已填写完成，可以提交" : "请回答全部问题后提交";

  function setAnswer(id: string, answers: string[]) {
    if (locked || submitPending.current) return;
    setSubmissionError(null);
    const nextDraft = { ...draft, [id]: answers };
    if (controlledDraft === undefined) setLocalDraft(nextDraft);
    onDraftChange?.(nextDraft);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || submitPending.current) return;
    const answers = buildInputAnswers(request, draft);
    if (!answers) return;
    submitPending.current = true;
    setSubmitting(true);
    setSubmissionError(null);
    try {
      await onAnswer(answers);
    } catch {
      setSubmissionError("回答未能确认提交，请检查任务状态后再继续。");
    } finally {
      submitPending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="input-request-card" aria-labelledby={`${instanceId}-title`} data-testid="input-request-card">
      <header className="input-request-heading">
        <h3 id={`${instanceId}-title`}>需要你的回答</h3>
        <p>回答以下问题，让任务继续。</p>
      </header>
      <form onSubmit={submit} aria-busy={busy}>
        <div className="input-request-questions">
          {request.questions.map((question, index) => {
            const selected = draftValues(draft, question.id);
            const questionId = `${instanceId}-question-${index}`;
            return (
              <fieldset className="input-question" disabled={locked} key={question.id} aria-describedby={`${questionId}-hint`}>
                <legend>
                  <span className="input-question-header">{question.header}</span>
                  <span className="input-question-text">{question.question}</span>
                </legend>
                <p className="input-question-hint" id={`${questionId}-hint`}>
                  {question.options.length === 0 ? "请填写回答（最多 8000 字）" : question.multiple ? "可选择多项" : "请选择一项"}
                </p>
                {question.options.length > 0 ? (
                  <div className="input-options">
                    {question.options.map((option) => {
                      const checked = selected.includes(option.label);
                      return (
                        <label className={`input-option${checked ? " is-selected" : ""}`} key={option.label}>
                          <input
                            type={question.multiple ? "checkbox" : "radio"}
                            name={questionId}
                            value={option.label}
                            checked={checked}
                            onChange={(event) => setAnswer(question.id, question.multiple
                              ? event.currentTarget.checked ? [...selected, option.label] : selected.filter((answer) => answer !== option.label)
                              : [option.label])}
                          />
                          <span className="input-option-content">
                            <strong>{option.label}</strong>
                            {option.description && <span className="input-option-description">{option.description}</span>}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <input
                    type="text"
                    className="input-text-answer"
                    aria-label={`${question.header}：${question.question}`}
                    aria-describedby={`${questionId}-hint`}
                    value={selected[0] ?? ""}
                    maxLength={MAX_ANSWER_CHARS}
                    placeholder="在这里填写回答"
                    onChange={(event) => setAnswer(question.id, [event.currentTarget.value])}
                  />
                )}
              </fieldset>
            );
          })}
        </div>
        {submissionError && <p className="input-request-error" role="alert">{submissionError}</p>}
        <footer className="input-request-footer">
          <span className="input-request-status" role="status">{status}</span>
          <button className="primary-button" type="submit" disabled={locked || !complete}>
            {busy ? "正在提交…" : "提交回答"}
          </button>
        </footer>
      </form>
    </section>
  );
}
