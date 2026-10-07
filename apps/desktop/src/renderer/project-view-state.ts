import type { DesktopEvent } from "../shared/contracts.js";

export interface ProjectView { sessionId: string; draft: string }

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
}

export function eventMatchesProject(event: DesktopEvent, projectId: string | undefined): boolean {
  return !("projectId" in event) || event.projectId === undefined || event.projectId === projectId;
}
