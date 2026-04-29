export interface PromptPart {
  type: "text";
  text: string;
}

export type LocalTranscriptItem =
  | { id: string; kind: "local"; level: "info" | "error"; text: string };

