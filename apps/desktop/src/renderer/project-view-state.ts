import type { DesktopEvent } from "../shared/contracts.js";

export interface ProjectView { sessionId: string; draft: string }

export class ProjectViewMemory {
  private readonly views = new Map<string, ProjectView>();

  remember(workspace: string | undefined, sessionId: string | undefined, draft: string): void {
    if (workspace && sessionId) this.views.set(workspace, { sessionId, draft });
  }

  read(workspace: string | undefined): ProjectView | undefined {
    return workspace ? this.views.get(workspace) : undefined;
  }
}

export function eventMatchesProject(event: DesktopEvent, projectId: string | undefined): boolean {
  return !("projectId" in event) || event.projectId === undefined || event.projectId === projectId;
}
