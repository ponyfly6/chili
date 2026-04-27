import { expect, test } from "bun:test";
import { parseArgs } from "./args.js";

test("parses team status and nested team view commands", () => {
  expect(parseArgs(["team", "status", "team_1", "--json"])).toMatchObject({
    command: "team",
    teamId: "team_1",
    json: true,
  });
  expect(parseArgs(["team", "tasks", "team_1"])).toMatchObject({
    command: "team-tasks",
    teamId: "team_1",
  });
  expect(parseArgs(["team", "members", "team_1"])).toMatchObject({
    command: "team-members",
    teamId: "team_1",
  });
  expect(parseArgs(["team", "messages", "team_1"])).toMatchObject({
    command: "team-messages",
    teamId: "team_1",
  });
});

test("keeps legacy team command aliases working", () => {
  expect(parseArgs(["team", "team_1"])).toMatchObject({
    command: "team",
    teamId: "team_1",
  });
  expect(parseArgs(["team-status", "team_1"])).toMatchObject({
    command: "team",
    teamId: "team_1",
  });
  expect(parseArgs(["team-tasks", "team_1", "--json"])).toMatchObject({
    command: "team-tasks",
    teamId: "team_1",
    json: true,
  });
});
