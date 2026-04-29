import type { TeamLiveView } from "@chili/sdk";

export type SlashCommandCategory =
  | "session"
  | "team"
  | "model"
  | "view"
  | "debug";

export type SlashCommandResult =
  | { type: "open_view"; view: "team" | "help" | "agents" | "status" }
  | { type: "open_theme_picker" }
  | { type: "close_view" }
  | { type: "clear_transcript" }
  | { type: "insert_prompt"; text: string }
  | { type: "local_message"; level: "info" | "error"; text: string }
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
