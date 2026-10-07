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
  /** Stable material identity; changes replace this ID within one assembly. */
  id: string;
  layer: PromptLayer;
  source: PromptFragmentSource;
  /** Ascending material selection order within a role, not instruction authority. */
  priority: number;
  /** Expected lifetime of the material, not permission to reuse a cached value. */
  lifecycle: PromptFragmentLifecycle;
  trust: PromptFragmentTrust;
  content: string;
  /** Exact loaded source used for provenance; only content is sent to the model. */
  sourceContent?: string;
  marker?: { open: string; close: string };
  maxChars?: number;
  metadata?: Record<string, unknown>;
}

export const DEFAULT_PROMPT_FRAGMENT_MAX_CHARS = 80_000;

export interface RenderedPromptFragment {
  id: string;
  layer: PromptLayer;
  source: PromptFragmentSource;
  priority: number;
  lifecycle: PromptFragmentLifecycle;
  trust: PromptFragmentTrust;
  content: string;
  sourceContent?: string;
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
