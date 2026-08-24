import type { CommandDefinition, CommandSuggestion } from "@chili/commands";
import type { TeamLiveView } from "@chili/sdk";
import type { SkillSettingsScope, SkillSummary } from "@chili/skills";
import type {
  DelegationPolicy,
  RuntimeCommandDiagnostic,
  RuntimeMcpAddServerRequest,
  RuntimeMcpAuthRequest,
  RuntimeMcpServerDescriptor,
  ServiceTier,
} from "@chili/protocol";
import type { ModelCandidate, ModelSelection, ReasoningLevel } from "../model-state.js";

export type TuiCommandResult =
  | { type: "open_view"; view: "team" | "help" | "agents" | "status" | "mcp" }
  | { type: "open_permissions_picker" }
  | { type: "open_theme_picker" }
  | { type: "reload_commands" }
  | { type: "reload_skills" }
  | { type: "exit_app" }
  | { type: "close_view" }
  | { type: "new_session" }
  | { type: "open_resume_picker" }
  | { type: "resume_session"; target: string }
  | { type: "open_rename_prompt" }
  | { type: "rename_session"; title: string }
  | { type: "goal_action"; action: "show" | "set" | "pause" | "resume" | "clear"; objective?: string; tokenBudget?: number }
  | { type: "submit_command"; commandId: string; args: string }
  | { type: "insert_prompt"; text: string }
  | { type: "local_message"; level: "info" | "error"; text: string }
  | { type: "auth_action"; action: "login" | "logout" | "status"; provider: "openai-codex" }
  | { type: "open_model_picker"; query?: string }
  | { type: "set_model"; selection: ModelSelection; reasoningLevel?: ReasoningLevel }
  | { type: "open_reasoning_picker" }
  | { type: "set_reasoning"; level: ReasoningLevel }
  | { type: "set_service_tier"; serviceTier: ServiceTier }
  | { type: "set_hide_thinking"; hidden: boolean }
  | { type: "delegation_action"; action: "status" | "set"; policy?: DelegationPolicy }
  | { type: "skills_action"; action: "enable" | "disable"; name: string; scope?: SkillSettingsScope }
  | McpTuiCommandResult
  | { type: "sdk_action"; action: "team_run" | "team_merge" | "approve" | "reject"; payload?: unknown }
  | { type: "confirm"; title: string; result: TuiCommandResult };

export type McpTuiCommandResult =
  | { type: "mcp_action"; action: "list" | "reload" }
  | { type: "mcp_action"; action: "status"; server?: string }
  | { type: "mcp_action"; action: "tools" | "remove" | "logout"; server: string }
  | { type: "mcp_action"; action: "auth"; server: string; request?: RuntimeMcpAuthRequest }
  | { type: "mcp_action"; action: "add"; input: RuntimeMcpAddServerRequest };

export interface TuiCommandContext {
  model: TeamLiveView;
  busy: boolean;
  cwd?: string;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  availableReasoningLevels?: readonly ReasoningLevel[];
  serviceTier?: ServiceTier;
  serviceTierConfigurable?: boolean;
  modelCandidates?: readonly ModelCandidate[];
  skills?: readonly SkillSummary[];
  allSkills?: readonly SkillSummary[];
  mcpServers?: readonly RuntimeMcpServerDescriptor[];
  commandDiagnostics?: readonly RuntimeCommandDiagnostic[];
}

export type TuiCommand = CommandDefinition<TuiCommandContext, TuiCommandResult>;
export type TuiCommandSuggestion = CommandSuggestion;
