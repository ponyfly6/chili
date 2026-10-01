import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { SessionId } from "@chili/protocol";
import type { TeamRow, TeamTaskRow } from "@chili/store";

export interface TeamSessionAuthority {
  sessionId: SessionId;
  cwd: string;
}

export interface ResolvedTeamSession {
  cwd: string;
  status?: "active" | "archived";
  source?: "interactive" | "subagent";
}

export type TeamSessionResolver = (
  sessionId: SessionId,
) => Promise<ResolvedTeamSession> | ResolvedTeamSession;

export class TeamSessionAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamSessionAuthorityError";
  }
}

export async function resolveTeamSessionAuthority(input: {
  team: TeamRow;
  tasks: readonly TeamTaskRow[];
  requestedSessionId?: SessionId;
  requestedCwd?: unknown;
  resolveSession: TeamSessionResolver;
}): Promise<TeamSessionAuthority> {
  const sessionId = boundTeamSessionId({
    team: input.team,
    ...(input.requestedSessionId ? { requestedSessionId: input.requestedSessionId } : {}),
  });
  if (!sessionId) {
    throw new TeamSessionAuthorityError(`Team ${input.team.id} has no persisted root session`);
  }
  const session = await input.resolveSession(sessionId);
  if (session.status !== undefined && session.status !== "active") {
    throw new TeamSessionAuthorityError(`Team owner session ${sessionId} is not active (${session.status})`);
  }
  if (session.source === "subagent") {
    throw new TeamSessionAuthorityError(`Team owner session ${sessionId} is reserved for a subagent`);
  }
  const cwd = await authoritativeTeamWorkspaceCwd(session.cwd, input.requestedCwd);
  return { sessionId, cwd };
}

export function boundTeamSessionId(input: {
  team: TeamRow;
  tasks?: readonly TeamTaskRow[];
  requestedSessionId?: SessionId;
}): SessionId | undefined {
  if (input.team.status !== "active") {
    throw new TeamSessionAuthorityError(`Cannot operate on archived team ${input.team.id}`);
  }
  // Team task session ids identify the actor that produced the task event. They
  // are provenance, not workspace ownership, and may legitimately be owner
  // descendants. Only the persisted team owner session is authoritative.
  const persistedSessionId = input.team.sessionId;
  if (
    input.requestedSessionId
    && persistedSessionId
    && input.requestedSessionId !== persistedSessionId
  ) {
    throw new TeamSessionAuthorityError(
      `Requested session ${input.requestedSessionId} does not own team ${input.team.id}; expected ${persistedSessionId}`,
    );
  }
  return persistedSessionId;
}

export async function authoritativeTeamWorkspaceCwd(
  persistedCwd: string,
  requestedCwd: unknown,
): Promise<string> {
  const authoritativeCwd = await canonicalTeamWorkspacePath(persistedCwd);
  if (requestedCwd === undefined) return authoritativeCwd;
  if (
    typeof requestedCwd !== "string"
    || requestedCwd.trim().length === 0
    || requestedCwd.includes("\0")
  ) {
    throw new TeamSessionAuthorityError("Requested workspace must be a non-empty valid filesystem path");
  }
  const requestedWorkspace = await canonicalTeamWorkspacePath(requestedCwd);
  if (requestedWorkspace !== authoritativeCwd) {
    throw new TeamSessionAuthorityError(
      `Requested workspace ${requestedWorkspace} does not match session workspace ${authoritativeCwd}`,
    );
  }
  return authoritativeCwd;
}

export async function canonicalTeamWorkspacePath(value: string): Promise<string> {
  const absolute = resolve(value);
  const missingSegments: string[] = [];
  let candidate = absolute;

  while (true) {
    try {
      const canonicalBase = await realpath(candidate);
      return resolve(canonicalBase, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return absolute;
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}
