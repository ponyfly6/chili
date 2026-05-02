import type { TeamLiveView } from "@chili/sdk";
import type { ModelCandidate, ModelSelection, ReasoningLevel } from "../model-state.js";

export type SlashCommandCategory =
  | "session"
  | "team"
  | "auth"
  | "model"
  | "skills"
  | "view"
  | "debug";

export type SlashCommandResult =
  | { type: "open_view"; view: "team" | "help" | "agents" | "status" }
  | { type: "open_theme_picker" }
  | { type: "close_view" }
  | { type: "new_session" }
  | { type: "insert_prompt"; text: string }
  | { type: "local_message"; level: "info" | "error"; text: string }
  | { type: "auth_action"; action: "login" | "logout" | "status"; provider: "openai-codex" }
  | { type: "open_model_picker"; query?: string }
  | { type: "set_model"; selection: ModelSelection; reasoningLevel?: ReasoningLevel }
  | { type: "open_reasoning_picker" }
  | { type: "set_reasoning"; level: ReasoningLevel }
  | { type: "sdk_action"; action: "team_run" | "team_merge" | "approve" | "reject"; payload?: unknown };

export interface SlashCompletion {
  value: string;
  label: string;
  description: string;
  category: SlashCommandCategory;
}

export interface SlashCommandContext {
  model: TeamLiveView;
  cwd?: string;
  modelSelection?: ModelSelection | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  modelCandidates?: readonly ModelCandidate[] | undefined;
}

export type SlashCommand = {
  name: string;
  aliases?: string[];
  description: string;
  category: SlashCommandCategory;
  argumentHint?: string;
  hidden?: boolean;
  isSafeConcurrent?: boolean;
  complete?: (ctx: SlashCommandContext, input: string) => SlashCompletion[];
  run: (ctx: SlashCommandContext, args: string) => SlashCommandResult | Promise<SlashCommandResult>;
};
