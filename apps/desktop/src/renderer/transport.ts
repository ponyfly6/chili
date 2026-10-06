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
  ServiceTier,
  SessionGoalStatus,
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
  resumeSession(sessionId: string): Promise<RuntimeSnapshot>;
  renameSession(sessionId: string, title: string): Promise<DesktopResponseMap["session.rename"]>;
  archiveSession(sessionId: string): Promise<DesktopResponseMap["session.archive"]>;
  sessionConfig(sessionId: string): Promise<DesktopResponseMap["session.config.get"]>;
  setModel(sessionId: string, modelSelection: ModelSelection): Promise<DesktopResponseMap["session.model.set"]>;
  setReasoning(sessionId: string, reasoningLevel: ReasoningLevel): Promise<DesktopResponseMap["session.reasoning.set"]>;
  setServiceTier(sessionId: string, serviceTier: ServiceTier): Promise<DesktopResponseMap["session.service-tier.set"]>;
  permissionConfig(): Promise<DesktopResponseMap["permissions.get"]>;
  setPermission(profile: RuntimePermissionProfileId): Promise<DesktopResponseMap["permissions.set"]>;
  setDelegation(sessionId: string, policy: DelegationPolicy): Promise<DesktopResponseMap["session.delegation.set"]>;
  setGoal(sessionId: string, objective: string, tokenBudget?: number): Promise<DesktopResponseMap["session.goal.set"]>;
  updateGoal(
    sessionId: string,
    input: { status?: SessionGoalStatus; objective?: string; tokenBudget?: number },
  ): Promise<DesktopResponseMap["session.goal.update"]>;
  clearGoal(sessionId: string): Promise<DesktopResponseMap["session.goal.clear"]>;
  reloadMcp(sessionId?: string): Promise<DesktopResponseMap["mcp.reload"]>;
  send(sessionId: string, text: string, mode: SendMode): Promise<DesktopResponseMap["session.send"]>;
  stop(sessionId: string): Promise<DesktopResponseMap["session.stop"]>;
  sendAgent(sessionId: string, agentId: string, text: string, mode?: SendMode): Promise<DesktopResponseMap["agent.send"]>;
  stopAgent(sessionId: string, agentId: string): Promise<DesktopResponseMap["agent.stop"]>;
  resumeAgent(sessionId: string, agentId: string): Promise<DesktopResponseMap["agent.resume"]>;
  resolveApproval(
    approvalId: string,
    decision: "allow_once" | "allow_session" | "allow_always" | "deny",
  ): Promise<DesktopResponseMap["approval.resolve"]>;
  resolveUserInput(inputId: string, answers: Record<string, string[]>): Promise<DesktopResponseMap["user-input.resolve"]>;
  completeResync(barrierId: string): Promise<DesktopResponseMap["events.resync.complete"]>;
  diff(scope: DiffScope, sessionId: string, turnId?: string): Promise<DesktopResponseMap["diff.get"]>;
  subscribe(listener: (event: DesktopEventEnvelope) => void): () => void;
}
