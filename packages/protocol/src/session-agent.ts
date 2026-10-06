import type { AgentPath } from "./agent-path.js";
import type { SessionId } from "./ids.js";

/** JSON-safe tool constraints, structurally compatible with ToolAccessPolicy. */
export interface PersistedToolPolicy {
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
  writeScope?: readonly string[];
  executeScope?: readonly string[];
}

/** Stable child identity and authority; the containing SessionId is the AgentId. */
export interface SessionAgentMetadata {
  parentSessionId: SessionId;
  name: string;
  path: AgentPath;
  policy: PersistedToolPolicy;
}
