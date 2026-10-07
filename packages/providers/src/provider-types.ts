/** Shared contracts; this module must not depend on vendor implementations. */
export interface ProviderDefinition {
  displayName: string;
  aliases: readonly string[];
  modelPrefixes: readonly string[];
  auth: "api_key" | "oauth";
  defaultRequestMaxTokens: number;
  /** Conservative request allowance for custom model/deployment IDs without metadata. */
  unknownModelRequestMaxTokens?: number;
  reasoning: "toggle" | "toggle-effort" | "effort" | "responses";
  serviceTier: boolean;
  connectionLabel?: string;
  canonicalizeModel?: (model: string) => string;
}

export interface ProviderEnvironmentSpec {
  apiKey?: readonly string[];
  baseUrl?: readonly string[];
  model?: readonly string[];
}
