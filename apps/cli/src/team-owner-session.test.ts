import { expect, test } from "bun:test";
import { TeamSessionAuthorityError } from "@chili/core";
import type { SessionId, TeamId } from "@chili/protocol";
import { bindNewTeamOwnerSession, type CliTeamOwnerControl } from "./team-owner-session.js";

test("concurrent CLI owner binding archives only its losing candidate", async () => {
  const teamId = "team_cli_owner_race" as TeamId;
  const candidates = [
    "session_cli_owner_candidate_a",
    "session_cli_owner_candidate_b",
  ] as SessionId[];
  let ownerSessionId: SessionId | undefined;
  let bindingCount = 0;
  let releaseBindings!: () => void;
  const bothBindings = new Promise<void>((resolve) => {
    releaseBindings = resolve;
  });
  const teams: CliTeamOwnerControl = {
    async bindOwnerSession(input) {
      bindingCount += 1;
      if (bindingCount === candidates.length) releaseBindings();
      await bothBindings;
      if (!ownerSessionId) {
        ownerSessionId = input.ownerSessionId;
        return { applied: true, ownerSessionId };
      }
      return { applied: false, reason: "already_bound", ownerSessionId };
    },
    async listTeams() {
      return [{ id: teamId, ...(ownerSessionId ? { sessionId: ownerSessionId } : {}) }];
    },
  };
  const discarded: SessionId[] = [];

  const results = await Promise.allSettled(candidates.map((candidateSessionId) => (
    bindNewTeamOwnerSession({
      teams,
      teamId,
      candidateSessionId,
      discardCandidate: async () => {
        discarded.push(candidateSessionId);
      },
    })
  )));

  if (!ownerSessionId) throw new Error("owner binding race did not produce a winner");
  const loserSessionId = candidates.find((candidate) => candidate !== ownerSessionId);
  if (!loserSessionId) throw new Error("owner binding race did not produce a loser");
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected?.status === "rejected" ? rejected.reason : undefined)
    .toBeInstanceOf(TeamSessionAuthorityError);
  expect(discarded).toEqual([loserSessionId]);
  expect(discarded).not.toContain(ownerSessionId);
});

test("a thrown bind conflict re-reads the winner before discarding the candidate", async () => {
  const teamId = "team_cli_owner_throw" as TeamId;
  const winnerSessionId = "session_cli_owner_winner" as SessionId;
  const candidateSessionId = "session_cli_owner_loser" as SessionId;
  const discarded: SessionId[] = [];
  const teams: CliTeamOwnerControl = {
    async bindOwnerSession() {
      throw new Error("owner operation lost its durable claim");
    },
    async listTeams() {
      return [{ id: teamId, sessionId: winnerSessionId }];
    },
  };

  await expect(bindNewTeamOwnerSession({
    teams,
    teamId,
    candidateSessionId,
    discardCandidate: async () => {
      discarded.push(candidateSessionId);
    },
  })).rejects.toThrow(`already owned by ${winnerSessionId}`);

  expect(discarded).toEqual([candidateSessionId]);
  expect(discarded).not.toContain(winnerSessionId);
});

test("an ambiguous bind failure never discards a candidate when the durable winner cannot be read", async () => {
  const teamId = "team_cli_owner_ambiguous" as TeamId;
  const candidateSessionId = "session_cli_owner_ambiguous" as SessionId;
  let discardCalls = 0;
  const teams: CliTeamOwnerControl = {
    async bindOwnerSession() {
      throw new Error("connection closed after bind attempt");
    },
    async listTeams() {
      throw new Error("database is unavailable");
    },
  };

  await expect(bindNewTeamOwnerSession({
    teams,
    teamId,
    candidateSessionId,
    discardCandidate: async () => {
      discardCalls += 1;
    },
  })).rejects.toThrow("connection closed after bind attempt");

  expect(discardCalls).toBe(0);
});
