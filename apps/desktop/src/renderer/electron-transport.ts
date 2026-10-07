import type {
  ChiliDesktopApi,
  DesktopRequest,
  DesktopResponse,
  DesktopState,
} from "../shared/contracts.js";
import type { ControlTransport } from "./transport.js";

// An uncertain delivery retains its identity even if the user presses Send again.
// Project-specific transport views share these pending receipts.
const pendingSubmissions = new Map<string, { text: string; submissionId: string }>();

export function createElectronTransport(api: ChiliDesktopApi, projectId?: string): ControlTransport {
  const invoke = <Request extends DesktopRequest>(request: Request) => api.invoke({
    ...request,
    ...(projectId ? { projectId } : {}),
  });
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
    forProject: (id) => createElectronTransport(api, id),
    activateProject: (id) => {
      const selection = invoke({ type: "workspace.activate", id });
      pendingWorkspaceSelections.add(selection);
      void selection.finally(() => pendingWorkspaceSelections.delete(selection)).catch(() => undefined);
      return selection;
    },
    state: () => invoke({ type: "app.state" }),
    selectWorkspace,
    listSessions: (options = {}) => invokeAfterWorkspaceSelection({ type: "sessions.list", ...options }),
    createSession: (options = {}) => invoke({ type: "sessions.create", ...options }),
    listModels: (provider) => invoke({ type: "models.list", ...(provider ? { provider } : {}) }),
    snapshot: (sessionId) => invokeAfterWorkspaceSelection({ type: "session.snapshot", sessionId }),
    openSession: (sessionId) => invokeAfterWorkspaceSelection({ type: "session.open", sessionId }),
    resumeSession: (sessionId) => invokeAfterWorkspaceSelection({ type: "session.resume", sessionId }),
    renameSession: (sessionId, title) => invoke({ type: "session.rename", sessionId, title }),
    archiveSession: (sessionId) => invoke({ type: "session.archive", sessionId }),
    sessionConfig: (sessionId) => invokeAfterWorkspaceSelection({ type: "session.config.get", sessionId }),
    setModel: (sessionId, modelSelection) => invoke({ type: "session.model.set", sessionId, modelSelection }),
    setReasoning: (sessionId, reasoningLevel) => invoke({ type: "session.reasoning.set", sessionId, reasoningLevel }),
    setServiceTier: (sessionId, serviceTier) => invoke({ type: "session.service-tier.set", sessionId, serviceTier }),
    permissionConfig: () => invoke({ type: "permissions.get" }),
    setPermission: (profile, options) => invoke({ type: "permissions.set", profile, ...options }),
    setDelegation: (sessionId, policy) => invoke({ type: "session.delegation.set", sessionId, policy }),
    reloadMcp: (sessionId) => invoke({ type: "mcp.reload", ...(sessionId ? { sessionId } : {}) }),
    connectMcp: (server, sessionId) => invoke({ type: "mcp.connect", server, ...(sessionId ? { sessionId } : {}) }),
    disconnectMcp: (server, sessionId) => invoke({ type: "mcp.disconnect", server, ...(sessionId ? { sessionId } : {}) }),
    send: async (sessionId, text, mode) => {
      const key = JSON.stringify([projectId, sessionId, mode]);
      let pending = pendingSubmissions.get(key);
      if (!pending || pending.text !== text) {
        pending = { text, submissionId: crypto.randomUUID() };
        pendingSubmissions.set(key, pending);
      }
      const result = await invoke({ type: "session.send", sessionId, text, mode, submissionId: pending.submissionId });
      if (pendingSubmissions.get(key) === pending) pendingSubmissions.delete(key);
      return result;
    },
    stop: (sessionId) => invoke({ type: "session.stop", sessionId }),
    sendAgent: (sessionId, agentId, text, mode) => invoke({ type: "agent.send", sessionId, agentId, text, ...(mode === undefined ? {} : { mode }) }),
    stopAgent: (sessionId, agentId) => invoke({ type: "agent.stop", sessionId, agentId }),
    resumeAgent: (sessionId, agentId) => invoke({ type: "agent.resume", sessionId, agentId }),
    resolveUserInput: (inputId, answers) => invoke({ type: "user-input.resolve", inputId, answers }),
    completeResync: (barrierId) => invoke({ type: "events.resync.complete", barrierId }),
    diff: (scope, sessionId, turnId) => invokeAfterWorkspaceSelection({
      type: "diff.get",
      scope,
      sessionId,
      ...(turnId ? { turnId } : {}),
    }),
    readResult: (path) => invokeAfterWorkspaceSelection({ type: "result.read", path }),
    subscribe: (listener) => api.subscribe(listener),
  };
}
