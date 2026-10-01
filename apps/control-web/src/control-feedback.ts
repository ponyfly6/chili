export interface OrdinaryNotice {
  kind: "error" | "success";
  text: string;
}

export interface UnknownMutationOutcome {
  /** A page-local command identity, not a protocol request or replay identity. */
  id: string;
  sessionId: string;
  sessionTitle: string;
  command: "Queue" | "Steer" | "Stop";
  startedAt: number;
  promptPreview?: string;
}

export interface ControlFeedback {
  notice: OrdinaryNotice | null;
  unknownOutcomes: readonly UnknownMutationOutcome[];
}

export type ControlFeedbackAction =
  | { type: "notice"; notice: OrdinaryNotice | null }
  | { type: "mutation_unknown"; outcome: UnknownMutationOutcome }
  | { type: "confirm_unknown"; id: string };

export const INITIAL_CONTROL_FEEDBACK: ControlFeedback = {
  notice: null,
  unknownOutcomes: [],
};

/** Connection/read/success feedback has no authority to resolve an uncertainty. */
export function reduceControlFeedback(state: ControlFeedback, action: ControlFeedbackAction): ControlFeedback {
  switch (action.type) {
    case "notice":
      return { ...state, notice: action.notice };
    case "mutation_unknown":
      if (state.unknownOutcomes.some((outcome) => outcome.id === action.outcome.id)) return state;
      return { ...state, unknownOutcomes: [...state.unknownOutcomes, action.outcome] };
    case "confirm_unknown":
      return { ...state, unknownOutcomes: state.unknownOutcomes.filter((outcome) => outcome.id !== action.id) };
  }
}

export function promptPreview(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= 120 ? normalized : `${characters.slice(0, 120).join("")}…`;
}
