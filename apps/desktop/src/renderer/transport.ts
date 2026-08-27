import type { RuntimeSessionSummary } from "@chili/sdk";
import type {
  DesktopEventEnvelope,
  DesktopResponseMap,
  DesktopState,
  DiffScope,
  RuntimeSnapshot,
  SendMode,
} from "../shared/contracts.js";

/**
 * The renderer's host boundary. A future paired/remote transport can implement
 * this interface without changing React components or importing Electron.
 */
export interface ControlTransport {
  state(): Promise<DesktopState>;
  selectWorkspace(): Promise<DesktopState>;
  listSessions(): Promise<RuntimeSessionSummary[]>;
  createSession(): Promise<{ sessionId: string }>;
  snapshot(sessionId: string): Promise<RuntimeSnapshot>;
  send(sessionId: string, text: string, mode: SendMode): Promise<DesktopResponseMap["session.send"]>;
  stop(sessionId: string): Promise<DesktopResponseMap["session.stop"]>;
  resolveApproval(
    approvalId: string,
    decision: "allow_once" | "allow_session" | "allow_always" | "deny",
  ): Promise<DesktopResponseMap["approval.resolve"]>;
  resolveUserInput(inputId: string, answers: Record<string, string[]>): Promise<DesktopResponseMap["user-input.resolve"]>;
  completeResync(barrierId: string): Promise<DesktopResponseMap["events.resync.complete"]>;
  diff(scope: DiffScope, sessionId: string, turnId?: string): Promise<DesktopResponseMap["diff.get"]>;
  subscribe(listener: (event: DesktopEventEnvelope) => void): () => void;
}
