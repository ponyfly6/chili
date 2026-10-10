import type {
  ChiliDesktopApi,
  DesktopRequest,
  DesktopResponse,
  DesktopState,
} from "../shared/contracts.js";
import type { ControlTransport } from "./transport.js";
import { submissionOutbox } from "./submission-outbox.js";

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
    conversationPage: (input) => invokeAfterWorkspaceSelection({ type: "conversation.page", ...input }),
    historyMessage: (input) => invokeAfterWorkspaceSelection({ type: "conversation.message", ...input }),
    historyContent: (input) => invokeAfterWorkspaceSelection({ type: "conversation.content", ...input }),
    historyTools: (input) => invokeAfterWorkspaceSelection({ type: "conversation.tools", ...input }),
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
    history: (sessionId, beforeEventId) => invokeAfterWorkspaceSelection({ type: "session.history", sessionId,
      ...(beforeEventId ? { beforeEventId } : {}) }),
    openSession: (sessionId) => invokeAfterWorkspaceSelection({ type: "session.open", sessionId }),
    resumeSession: (sessionId) => invokeAfterWorkspaceSelection({ type: "session.resume", sessionId }),
    renameSession: (sessionId, title) => invoke({ type: "session.rename", sessionId, title }),
    archiveSession: (sessionId) => invoke({ type: "session.archive", sessionId }),
    deleteSession: (sessionId) => invoke({ type: "session.delete", sessionId }),
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
      const outbox = submissionOutbox();
      const pending = outbox.reserve({ ...(projectId ? { projectId } : {}), sessionId, text, mode });
      try {
        const result = await invoke({ type: "session.send", sessionId, text, mode, submissionId: pending.submissionId });
        outbox.accepted(pending.submissionId);
        return result;
      } catch (error) {
        if (outbox.snapshot().find((entry) => entry.submissionId === pending.submissionId)?.state === "confirmed") {
          outbox.accepted(pending.submissionId);
          return { status: "accepted" };
        }
        outbox.uncertain(pending.submissionId);
        throw error;
      }
    },
    stop: (sessionId) => invoke({ type: "session.stop", sessionId }),
    cancelInput: (sessionId, inputId, expectedRevision) => invoke({ type: "session.input.cancel", sessionId, inputId, expectedRevision }),
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
