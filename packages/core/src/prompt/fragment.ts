export type PromptLayer =
  | "base"
  | "developer"
  | "contextual_user"
  | "conversation"
  | "tool_schema";

export type PromptFragmentSource =
  | "core"
  | "memory"
  | "project"
  | "skills"
  | "mcp"
  | "environment"
  | "compaction"
  | "runtime";

export type PromptFragmentLifecycle = "stable" | "session" | "turn";

export type PromptFragmentTrust =
  | "system"
  | "user"
  | "project"
  | "tool"
  | "model_summary";

export interface PromptFragment {
  id: string;
  layer: PromptLayer;
  source: PromptFragmentSource;
  priority: number;
  lifecycle: PromptFragmentLifecycle;
  trust: PromptFragmentTrust;
  content: string;
  marker?: { open: string; close: string };
  maxChars?: number;
  metadata?: Record<string, unknown>;
}

export interface RenderedPromptFragment {
  id: string;
  layer: PromptLayer;
  source: PromptFragmentSource;
  priority: number;
  lifecycle: PromptFragmentLifecycle;
  trust: PromptFragmentTrust;
  content: string;
  chars: number;
  metadata?: Record<string, unknown>;
}

export const PROMPT_LAYER_ORDER: Record<PromptLayer, number> = {
  base: 0,
  developer: 1,
  contextual_user: 2,
  conversation: 3,
  tool_schema: 4,
};
