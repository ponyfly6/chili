import type { Message } from "./message.js";
import type { ModelSelection, ReasoningLevel, ServiceTier } from "./runtime.js";
import type { ToolDefinition } from "./tool.js";
import type { ExecutionIdentity } from "./execution-identity.js";

/** Resolved authentication identity; never includes tokens or API keys. */
export interface PreparedModelIdentity {
  provider: string;
  model: string;
  accountId?: string;
  credentialVersion?: string | number;
  profileId?: string;
}

/** Immutable, credential-free input at the shared model adapter boundary. */
export interface PreparedModelRequest {
  version: 1;
  purpose: "turn" | "compaction";
  contentVersion: string;
  sessionRevision: number;
  sourceEventId?: string;
  toolCatalogRevision?: number;
  executionIdentity?: ExecutionIdentity;
  modelIdentity?: PreparedModelIdentity;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  maxTokens?: number;
  system: string[];
  developer: string[];
  contextualUser: string[];
  messages: Message[];
  tools: Array<Pick<ToolDefinition, "name" | "description" | "risk" | "inputSchema">>;
  sources: Array<{
    id: string;
    kind: "system" | "developer" | "contextual_user" | "message" | "tool";
    version: string;
    status: "included" | "truncated" | "omitted";
    reason?: string;
    metadata?: Record<string, unknown>;
  }>;
  budget: Record<string, number>;
}
