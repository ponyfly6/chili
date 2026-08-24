import { TeamSessionAuthorityError } from "@chili/core";
import type { SessionId, TeamId } from "@chili/protocol";

interface TeamOwnerBinding {
  applied: boolean;
  ownerSessionId?: SessionId;
  reason?: string;
}

export interface CliTeamOwnerControl {
  bindOwnerSession(input: { teamId: TeamId; ownerSessionId: SessionId }): Promise<TeamOwnerBinding>;
  listTeams(): Promise<Array<{ id: TeamId; sessionId?: SessionId }>>;
}

export async function bindNewTeamOwnerSession(input: {
  teams: CliTeamOwnerControl;
  teamId: TeamId;
  candidateSessionId: SessionId;
  discardCandidate(): Promise<void>;
}): Promise<SessionId> {
  let binding: TeamOwnerBinding;
  try {
    binding = await input.teams.bindOwnerSession({
      teamId: input.teamId,
      ownerSessionId: input.candidateSessionId,
    });
  } catch (error) {
    const current = await readCurrentTeamOwner(input.teams, input.teamId);
    if (current.ownerSessionId === input.candidateSessionId) return input.candidateSessionId;
    // A thrown bind is ambiguous: it may have committed before the transport or
    // operation boundary failed. Discard only after a successful durable read
    // proves this candidate is not the winner.
    if (current.readSucceeded) {
      await discardUnusedCandidate(input, current.ownerSessionId);
    }
    throw ownerBindingError(input, current.ownerSessionId, error);
  }

  if (
    binding.ownerSessionId === input.candidateSessionId
    && (binding.applied || binding.reason === "already_bound")
  ) {
    return input.candidateSessionId;
  }

  const current = binding.ownerSessionId === undefined
    ? await readCurrentTeamOwner(input.teams, input.teamId)
    : { readSucceeded: true, ownerSessionId: binding.ownerSessionId };
  const ownerSessionId = current.ownerSessionId;
  if (ownerSessionId === input.candidateSessionId) return input.candidateSessionId;
  if (!binding.applied || current.readSucceeded) {
    await discardUnusedCandidate(input, ownerSessionId);
  }
  throw ownerBindingError(input, ownerSessionId, binding.reason ?? "unknown");
}

async function readCurrentTeamOwner(
  teams: CliTeamOwnerControl,
  teamId: TeamId,
): Promise<{ readSucceeded: boolean; ownerSessionId?: SessionId }> {
  try {
    const ownerSessionId = (await teams.listTeams()).find((team) => team.id === teamId)?.sessionId;
    return { readSucceeded: true, ...(ownerSessionId ? { ownerSessionId } : {}) };
  } catch {
    return { readSucceeded: false };
  }
}

async function discardUnusedCandidate(
  input: {
    teamId: TeamId;
    candidateSessionId: SessionId;
    discardCandidate(): Promise<void>;
  },
  ownerSessionId: SessionId | undefined,
): Promise<void> {
  try {
    await input.discardCandidate();
  } catch (error) {
    const cleanupError = error instanceof Error ? error : new Error(String(error));
    const owner = ownerSessionId ? `; winner ${ownerSessionId} remains authoritative` : "";
    throw new TeamSessionAuthorityError(
      `Could not discard unused owner candidate ${input.candidateSessionId} for team ${input.teamId}${owner}: ${cleanupError.message}`,
    );
  }
}

function ownerBindingError(
  input: { teamId: TeamId; candidateSessionId: SessionId },
  ownerSessionId: SessionId | undefined,
  cause: unknown,
): TeamSessionAuthorityError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const owner = ownerSessionId ? `; already owned by ${ownerSessionId}` : "";
  const error = new TeamSessionAuthorityError(
    `Could not persist owner session ${input.candidateSessionId} for team ${input.teamId} (${reason}${owner})`,
  );
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}
