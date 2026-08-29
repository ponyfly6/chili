import type {
  ChiliDesktopApi,
  DesktopRequest,
  DesktopResponse,
  DesktopState,
} from "../shared/contracts.js";
import type { ControlTransport } from "./transport.js";

export function createElectronTransport(api: ChiliDesktopApi): ControlTransport {
  const invoke = <Request extends DesktopRequest>(request: Request) => api.invoke(request);
  const pendingWorkspaceSelections = new Set<Promise<DesktopState>>();
  const selectWorkspace = (): Promise<DesktopState> => {
    const selection = invoke({ type: "workspace.select" });
    pendingWorkspaceSelections.add(selection);
    void selection.finally(() => pendingWorkspaceSelections.delete(selection)).catch(() => undefined);
    return selection;
  };
  const invokeAfterWorkspaceSelection = async <Request extends DesktopRequest>(
    request: Request,
  ): Promise<DesktopResponse<Request>> => {
    while (pendingWorkspaceSelections.size > 0) {
      await Promise.allSettled([...pendingWorkspaceSelections]);
    }
    return invoke(request);
  };
  return {
    state: () => invoke({ type: "app.state" }),
    selectWorkspace,
    listSessions: (options = {}) => invokeAfterWorkspaceSelection({ type: "sessions.list", ...options }),
    createSession: (options = {}) => invoke({ type: "sessions.create", ...options }),
    listModels: (provider) => invoke({ type: "models.list", ...(provider ? { provider } : {}) }),
    snapshot: (sessionId) => invokeAfterWorkspaceSelection({ type: "session.snapshot", sessionId }),
    resumeSession: (sessionId) => invokeAfterWorkspaceSelection({ type: "session.resume", sessionId }),
    renameSession: (sessionId, title) => invoke({ type: "session.rename", sessionId, title }),
    archiveSession: (sessionId) => invoke({ type: "session.archive", sessionId }),
    sessionConfig: (sessionId) => invokeAfterWorkspaceSelection({ type: "session.config.get", sessionId }),
    setModel: (sessionId, modelSelection) => invoke({ type: "session.model.set", sessionId, modelSelection }),
    setReasoning: (sessionId, reasoningLevel) => invoke({ type: "session.reasoning.set", sessionId, reasoningLevel }),
    setServiceTier: (sessionId, serviceTier) => invoke({ type: "session.service-tier.set", sessionId, serviceTier }),
    permissionConfig: () => invoke({ type: "permissions.get" }),
    setPermission: (profile) => invoke({ type: "permissions.set", profile }),
    setDelegation: (sessionId, policy) => invoke({ type: "session.delegation.set", sessionId, policy }),
    setGoal: (sessionId, objective, tokenBudget) => invoke({
      type: "session.goal.set",
      sessionId,
      objective,
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    }),
    updateGoal: (sessionId, input) => invoke({ type: "session.goal.update", sessionId, ...input }),
    clearGoal: (sessionId) => invoke({ type: "session.goal.clear", sessionId }),
    reloadMcp: (sessionId) => invoke({ type: "mcp.reload", ...(sessionId ? { sessionId } : {}) }),
    send: (sessionId, text, mode) => invoke({ type: "session.send", sessionId, text, mode }),
    stop: (sessionId) => invoke({ type: "session.stop", sessionId }),
    resolveApproval: (approvalId, decision) => invoke({ type: "approval.resolve", approvalId, decision }),
    resolveUserInput: (inputId, answers) => invoke({ type: "user-input.resolve", inputId, answers }),
    completeResync: (barrierId) => invoke({ type: "events.resync.complete", barrierId }),
    diff: (scope, sessionId, turnId) => invokeAfterWorkspaceSelection({
      type: "diff.get",
      scope,
      sessionId,
      ...(turnId ? { turnId } : {}),
    }),
    subscribe: (listener) => api.subscribe(listener),
  };
}
