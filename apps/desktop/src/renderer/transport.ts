import type { RuntimeSessionSummary } from "@chili/sdk";
import type {
  DesktopCreateSessionOptions,
  DesktopEventEnvelope,
  DesktopResponseMap,
  DesktopState,
  DiffScope,
  RuntimeSnapshot,
  SendMode,
  SessionListStatus,
} from "../shared/contracts.js";
import type {
  DelegationPolicy,
  ModelSelection,
  ReasoningLevel,
  RuntimePermissionProfileId,
  RuntimePermissionUpdateOptions,
  ServiceTier,
} from "@chili/protocol";

/**
 * The renderer's host boundary. A future paired/remote transport can implement
 * this interface without changing React components or importing Electron.
 */
export interface ControlTransport {
  forProject?(projectId: string): ControlTransport;
  activateProject?(projectId: string): Promise<DesktopState>;
  state(): Promise<DesktopState>;
  selectWorkspace(): Promise<DesktopState>;
  listSessions(options?: { query?: string; status?: SessionListStatus }): Promise<RuntimeSessionSummary[]>;
  createSession(options?: DesktopCreateSessionOptions): Promise<DesktopResponseMap["sessions.create"]>;
  listModels(provider?: string): Promise<DesktopResponseMap["models.list"]>;
  snapshot(sessionId: string): Promise<RuntimeSnapshot>;
  openSession(sessionId: string): Promise<RuntimeSnapshot>;
  resumeSession(sessionId: string): Promise<RuntimeSnapshot>;
  renameSession(sessionId: string, title: string): Promise<DesktopResponseMap["session.rename"]>;
  archiveSession(sessionId: string): Promise<DesktopResponseMap["session.archive"]>;
  sessionConfig(sessionId: string): Promise<DesktopResponseMap["session.config.get"]>;
  setModel(sessionId: string, modelSelection: ModelSelection): Promise<DesktopResponseMap["session.model.set"]>;
  setReasoning(sessionId: string, reasoningLevel: ReasoningLevel): Promise<DesktopResponseMap["session.reasoning.set"]>;
  setServiceTier(sessionId: string, serviceTier: ServiceTier): Promise<DesktopResponseMap["session.service-tier.set"]>;
  permissionConfig(): Promise<DesktopResponseMap["permissions.get"]>;
  setPermission(profile: RuntimePermissionProfileId, options?: RuntimePermissionUpdateOptions): Promise<DesktopResponseMap["permissions.set"]>;
  setDelegation(sessionId: string, policy: DelegationPolicy): Promise<DesktopResponseMap["session.delegation.set"]>;
  reloadMcp(sessionId?: string): Promise<DesktopResponseMap["mcp.reload"]>;
  connectMcp?(server: string, sessionId?: string): Promise<DesktopResponseMap["mcp.connect"]>;
  disconnectMcp?(server: string, sessionId?: string): Promise<DesktopResponseMap["mcp.disconnect"]>;
  send(sessionId: string, text: string, mode: SendMode): Promise<DesktopResponseMap["session.send"]>;
  stop(sessionId: string): Promise<DesktopResponseMap["session.stop"]>;
  sendAgent(sessionId: string, agentId: string, text: string, mode?: SendMode): Promise<DesktopResponseMap["agent.send"]>;
  stopAgent(sessionId: string, agentId: string): Promise<DesktopResponseMap["agent.stop"]>;
  resumeAgent(sessionId: string, agentId: string): Promise<DesktopResponseMap["agent.resume"]>;
  resolveUserInput(inputId: string, answers: Record<string, string[]>): Promise<DesktopResponseMap["user-input.resolve"]>;
  completeResync(barrierId: string): Promise<DesktopResponseMap["events.resync.complete"]>;
  diff(scope: DiffScope, sessionId: string, turnId?: string): Promise<DesktopResponseMap["diff.get"]>;
  readResult?(path: string): Promise<DesktopResponseMap["result.read"]>;
  subscribe(listener: (event: DesktopEventEnvelope) => void): () => void;
}
