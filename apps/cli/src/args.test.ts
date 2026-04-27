import { expect, test } from "bun:test";
import { parseArgs } from "./args.js";

test("parses DeepSeek as a CLI model", () => {
  expect(parseArgs(["--model", "deepseek", "hello"])).toMatchObject({
    command: "run",
    model: "deepseek",
    prompt: "hello",
  });
});

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

test("parses team run loop command and runner flags", () => {
  expect(parseArgs(["team-run-loop", "team_1", "--once", "--max-cycles", "3", "--timeout-ms", "5000", "--json"])).toMatchObject({
    command: "team-run-loop",
    teamId: "team_1",
    once: true,
    maxCycles: 3,
    timeoutMs: 5000,
    json: true,
  });
  expect(parseArgs(["team", "run-loop", "team_1"])).toMatchObject({
    command: "team-run-loop",
    teamId: "team_1",
  });
});

test("parses memory commands", () => {
  expect(parseArgs(["memory", "show"])).toMatchObject({
    command: "memory-show",
  });
  expect(parseArgs(["memory", "add", "--user", "prefer", "small", "patches"])).toMatchObject({
    command: "memory-add",
    memoryScope: "user",
    prompt: "prefer small patches",
  });
  expect(parseArgs(["memory", "reload", "--project"])).toMatchObject({
    command: "memory-reload",
    memoryScope: "project",
  });
});
