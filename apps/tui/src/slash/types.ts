import type { TeamLiveView } from "@chili/sdk";
import type { SkillSettingsScope, SkillSummary } from "@chili/skills";
import type { ModelCandidate, ModelSelection, ReasoningLevel } from "../model-state.js";

export type SlashCommandCategory =
  | "session"
  | "team"
  | "auth"
  | "model"
  | "policy"
  | "skills"
  | "custom"
  | "view"
  | "debug";

export type SlashCommandResult =
  | { type: "open_view"; view: "team" | "help" | "agents" | "status" }
  | { type: "open_permissions_picker" }
  | { type: "open_theme_picker" }
  | { type: "reload_commands" }
  | { type: "close_view" }
  | { type: "new_session" }
  | { type: "submit_command"; commandName: string; args: string }
  | { type: "insert_prompt"; text: string }
  | { type: "local_message"; level: "info" | "error"; text: string }
  | { type: "auth_action"; action: "login" | "logout" | "status"; provider: "openai-codex" }
  | { type: "open_model_picker"; query?: string }
  | { type: "set_model"; selection: ModelSelection; reasoningLevel?: ReasoningLevel }
  | { type: "open_reasoning_picker" }
  | { type: "set_reasoning"; level: ReasoningLevel }
  | { type: "set_hide_thinking"; hidden: boolean }
  | { type: "skills_action"; action: "enable" | "disable"; name: string; scope?: SkillSettingsScope }
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
  skills?: readonly SkillSummary[] | undefined;
  allSkills?: readonly SkillSummary[] | undefined;
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
