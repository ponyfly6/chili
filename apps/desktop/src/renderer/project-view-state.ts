import type { DesktopEvent } from "../shared/contracts.js";

export interface ProjectView { sessionId: string; draft: string }

/** Explicit selection survives a newer background list request replacing its original request. */
export class PendingSessionSelection {
  private selection: { projectId: string | undefined; sessionId: string } | undefined;

  request(projectId: string | undefined, sessionId: string): void {
    this.selection = { projectId, sessionId };
  }

  read(projectId: string | undefined): string | undefined {
    return this.selection?.projectId === projectId ? this.selection?.sessionId : undefined;
  }

  consume(projectId: string | undefined, sessionId: string): void {
    if (this.read(projectId) === sessionId) this.clear();
  }

  clear(): void {
    this.selection = undefined;
  }
}

export class ProjectViewMemory {
  private readonly views = new Map<string, ProjectView>();
  private readonly drafts = new Map<string, Map<string | undefined, string>>();

  remember(workspace: string | undefined, sessionId: string | undefined, draft: string): void {
    if (!workspace) return;
    let drafts = this.drafts.get(workspace);
    if (!drafts) {
      drafts = new Map();
      this.drafts.set(workspace, drafts);
    }
    drafts.set(sessionId, draft);
    if (sessionId) this.views.set(workspace, { sessionId, draft });
  }

  read(workspace: string | undefined): ProjectView | undefined {
    return workspace ? this.views.get(workspace) : undefined;
  }

  readDraft(workspace: string | undefined, sessionId: string | undefined): string | undefined {
    return workspace ? this.drafts.get(workspace)?.get(sessionId) : undefined;
  }

  forgetSession(workspace: string | undefined, sessionId: string): void {
    if (!workspace) return;
    this.drafts.get(workspace)?.delete(sessionId);
    if (this.views.get(workspace)?.sessionId === sessionId) this.views.delete(workspace);
  }
}

export function eventMatchesProject(event: DesktopEvent, projectId: string | undefined): boolean {
  return !("projectId" in event) || event.projectId === undefined || event.projectId === projectId;
}
