import type { UserInputRequest } from "../shared/contracts.js";
import {
  customUserInputAnswer,
  selectedUserInputOptions,
  selectUserInputOption,
  setUserInputCustomAnswer,
  type UserInputDraft,
} from "./user-input-drafts.js";
import { buildUserInputAnswers } from "./user-input-model.js";
import "./user-input-card.css";

export interface UserInputCardProps {
  request: UserInputRequest;
  draft: UserInputDraft;
  onDraftChange: (draft: UserInputDraft) => void;
  disabled: boolean;
  submit: (answers: Record<string, string[]>) => Promise<void>;
}

export function UserInputCard({ request, draft, onDraftChange, disabled, submit }: UserInputCardProps) {
  const answers = buildUserInputAnswers(request, draft.selected, draft.custom);
  const complete = request.questions.length > 0 && Object.values(answers).every((values) => values.length > 0);

  return (
    <section className="request-card input-card user-input-card" aria-label="补充信息">
      <div className="user-input-heading">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1v-9.5a8.5 8.5 0 0 1 17 0Z" />
          <path d="M9.5 8.5a2.5 2.5 0 1 1 4.3 1.7c-1.1.7-1.8 1-1.8 2.3M12 16h.01" />
        </svg>
        <span>{request.questions.length > 1 ? "请补充以下信息" : "请补充一个信息"}</span>
      </div>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && complete) void submit(answers);
      }}>
        {request.questions.map((question) => (
          <fieldset key={question.id} disabled={disabled}>
            <legend><span>{question.header}{question.multiple ? " · 可多选" : ""}</span>{question.question}</legend>
            <div className="user-input-options">
              {question.options.map((option) => {
                const active = selectedUserInputOptions(draft, question.id).includes(option.label);
                return (
                  <button
                    type="button"
                    key={option.label}
                    className={`user-input-option${active ? " is-selected" : ""}`}
                    aria-pressed={active}
                    onClick={() => onDraftChange(selectUserInputOption(draft, question, option.label))}
                  >
                    <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      {active ? <path d="m5 12 4 4L19 6" /> : <path d="M7 17 17 7M7 7h10v10" />}
                    </svg>
                  </button>
                );
              })}
            </div>
            <label className="user-input-custom">
              <span>{question.multiple ? "也可以补充其他想法" : "也可以直接说明"}</span>
              <input
                aria-label={`Custom answer for ${question.header}`}
                value={customUserInputAnswer(draft, question.id)}
                onChange={(event) => onDraftChange(setUserInputCustomAnswer(draft, question, event.target.value))}
                placeholder="写下你的想法…"
              />
            </label>
          </fieldset>
        ))}
        <div className="request-actions user-input-actions">
          <span>{request.questions.length > 1 ? "每个问题都回答后即可继续" : "选择一项，或直接说明"}</span>
          <button type="submit" className="primary" aria-label="Submit answer" disabled={disabled || !complete}>提交并继续<span aria-hidden="true"> →</span></button>
        </div>
      </form>
    </section>
  );
}
