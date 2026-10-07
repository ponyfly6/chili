import type { ServiceTier } from "@chili/protocol";
import type { FileAuthStorage } from "../../auth/storage.js";
import type { EnvironmentSource } from "../../env.js";
import type { ProviderBackpressureCoordinator } from "../../runtime/backpressure.js";
import type { ReasoningLevel } from "../../types.js";
import type { ResponsesRequestBuildOptions } from "../../protocols/responses.js";

export type OpenAICodexReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type OpenAICodexReasoningMode = "pro";
export type OpenAICodexReasoningContext = "auto" | "all_turns" | "current_turn";

export interface OpenAICodexModelOptions {
  /** @deprecated ChatGPT Codex is OAuth-only. Use CodexApiModelOptions with the codex-api provider. */
  apiKey?: string;
  /** @deprecated ChatGPT Codex is OAuth-only. Account IDs come from OAuth credentials. */
  accountId?: string;
  /** @deprecated ChatGPT Codex always uses the fixed ChatGPT endpoint. Use the codex-api provider for custom endpoints. */
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  authPath?: string;
  chiliHome?: string;
  authRefreshTimeoutMs?: number;
  authStorage?: FileAuthStorage;
  backpressureCoordinator?: ProviderBackpressureCoordinator;
  env?: EnvironmentSource;
  reasoningEffort?: ReasoningLevel;
  reasoningMode?: OpenAICodexReasoningMode;
  reasoningContext?: OpenAICodexReasoningContext;
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: ServiceTier;
  textVerbosity?: "low" | "medium" | "high";
}

export interface CodexApiModelOptions {
  backpressureCoordinator?: ProviderBackpressureCoordinator;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  env?: EnvironmentSource;
  reasoningEffort?: ReasoningLevel;
  reasoningMode?: OpenAICodexReasoningMode;
  reasoningContext?: OpenAICodexReasoningContext;
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: ServiceTier;
  textVerbosity?: "low" | "medium" | "high";
}

export type CodexApiRequestBuildOptions = OpenAICodexRequestBuildOptions;

export type OpenAICodexRequestBuildOptions = ResponsesRequestBuildOptions;
export type OpenAIModelOptions = CodexApiModelOptions;
export type OpenAIRequestBuildOptions = ResponsesRequestBuildOptions;
