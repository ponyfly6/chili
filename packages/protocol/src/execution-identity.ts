/** Paths are canonical local resources; IDs never contain credentials. */
export interface ExecutionIdentity {
  profileId: string;
  profilePath: string;
  authPath?: string;
  projectId: string;
  projectRoot: string;
  workspaceId: string;
  workspaceRoot: string;
}
