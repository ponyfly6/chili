import type { ChiliDesktopApi, DesktopRequest } from "../shared/contracts.js";
import type { ControlTransport } from "./transport.js";

export function createElectronTransport(api: ChiliDesktopApi): ControlTransport {
  const invoke = <Request extends DesktopRequest>(request: Request) => api.invoke(request);
  return {
    state: () => invoke({ type: "app.state" }),
    selectWorkspace: () => invoke({ type: "workspace.select" }),
    listSessions: () => invoke({ type: "sessions.list" }),
    createSession: () => invoke({ type: "sessions.create" }),
    snapshot: (sessionId) => invoke({ type: "session.snapshot", sessionId }),
    send: (sessionId, text, mode) => invoke({ type: "session.send", sessionId, text, mode }),
    stop: (sessionId) => invoke({ type: "session.stop", sessionId }),
    resolveApproval: (approvalId, decision) => invoke({ type: "approval.resolve", approvalId, decision }),
    resolveUserInput: (inputId, answers) => invoke({ type: "user-input.resolve", inputId, answers }),
    completeResync: (barrierId) => invoke({ type: "events.resync.complete", barrierId }),
    diff: (scope, sessionId, turnId) => invoke({
      type: "diff.get",
      scope,
      sessionId,
      ...(turnId ? { turnId } : {}),
    }),
    subscribe: (listener) => api.subscribe(listener),
  };
}
