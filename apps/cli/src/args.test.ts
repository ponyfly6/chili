import { expect, test } from "bun:test";
import { parseArgs } from "./args.js";

test("parses DeepSeek as a CLI model", () => {
  expect(parseArgs(["--model", "deepseek", "hello"])).toMatchObject({
    command: "run",
    model: "deepseek",
    prompt: "hello",
  });
});

test("parses Kimi as a CLI model", () => {
  expect(parseArgs(["--model", "kimi", "hello"])).toMatchObject({
    command: "run",
    model: "kimi",
    prompt: "hello",
  });
});

test("parses ChatGPT Codex as a CLI model", () => {
  expect(parseArgs(["--model", "codex", "hello"])).toMatchObject({
    command: "run",
    model: "codex",
    prompt: "hello",
  });
  expect(parseArgs(["--model", "openai-codex", "hello"])).toMatchObject({
    command: "run",
    model: "openai-codex",
    prompt: "hello",
  });
});

test("keeps legacy model aliases parseable", () => {
  for (const alias of ["fake", "minimax", "deepseek", "kimi", "moonshot", "codex", "openai-codex", "legacy-minimax"]) {
    expect(parseArgs(["--model", alias, "hello"])).toMatchObject({
      command: "run",
      model: alias,
      prompt: "hello",
    });
  }
});

test("parses provider and concrete model references", () => {
  expect(parseArgs(["--provider", "openai-codex", "--model", "gpt-5.5", "hello"])).toMatchObject({
    command: "run",
    provider: "openai-codex",
    model: "gpt-5.5",
    prompt: "hello",
  });
  expect(parseArgs(["--model", "openai-codex/gpt-5.3-codex", "hello"])).toMatchObject({
    command: "run",
    model: "openai-codex/gpt-5.3-codex",
    prompt: "hello",
  });
  expect(parseArgs(["--model", "gpt-5.5", "hello"])).toMatchObject({
    command: "run",
    model: "gpt-5.5",
    prompt: "hello",
  });
});

test("parses thinking and reasoning levels", () => {
  expect(parseArgs(["--model", "gpt-5.3-codex:high", "hello"])).toMatchObject({
    command: "run",
    model: "gpt-5.3-codex",
    reasoningLevel: "high",
    prompt: "hello",
  });
  expect(parseArgs(["--thinking", "xhigh", "hello"])).toMatchObject({
    command: "run",
    reasoningLevel: "xhigh",
    prompt: "hello",
  });
  expect(parseArgs(["--reasoning", "off", "hello"])).toMatchObject({
    command: "run",
    reasoningLevel: "off",
    prompt: "hello",
  });
});

test("parses MCP startup flags for CLI runs", () => {
  expect(parseArgs(["--mcp", "hello"])).toMatchObject({
    command: "run",
    mcpMode: "eager",
    prompt: "hello",
  });
  expect(parseArgs(["--no-mcp", "hello"])).toMatchObject({
    command: "run",
    mcpMode: "off",
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

test("parses team merge command", () => {
  expect(parseArgs(["team-merge", "team_1", "--task", "task_1", "--json"])).toMatchObject({
    command: "team-merge",
    teamId: "team_1",
    taskId: "task_1",
    json: true,
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

test("parses prompt-debug command and flags", () => {
  expect(parseArgs(["prompt-debug", "--resume", "session_1", "--thread", "thread_1", "--content", "--json"])).toMatchObject({
    command: "prompt-debug",
    resume: "session_1",
    threadId: "thread_1",
    content: true,
    json: true,
  });
  expect(parseArgs(["prompt-debug", "--text", "use $reviewer"])).toMatchObject({
    command: "prompt-debug",
    prompt: "use $reviewer",
  });
  expect(parseArgs(["prompt-debug", "--cwd", "/repo"])).toMatchObject({
    command: "prompt-debug",
    cwd: "/repo",
    content: false,
    json: false,
  });
});

test("parses skills commands", () => {
  expect(parseArgs(["skills"])).toMatchObject({
    command: "skills-list",
  });
  expect(parseArgs(["skills", "list", "--json"])).toMatchObject({
    command: "skills-list",
    json: true,
  });
  expect(parseArgs(["skills", "disable", "--user", "reviewer"])).toMatchObject({
    command: "skills-disable",
    skillScope: "user",
    skillName: "reviewer",
  });
  expect(parseArgs(["skills", "enable", "--project", "reviewer"])).toMatchObject({
    command: "skills-enable",
    skillScope: "project",
    skillName: "reviewer",
  });
});

test("parses mcp management commands", () => {
  expect(parseArgs(["mcp"])).toMatchObject({
    command: "mcp",
    mcpAction: "list",
  });
  expect(parseArgs(["mcp", "status", "github", "--json"])).toMatchObject({
    command: "mcp",
    mcpAction: "status",
    mcpServer: "github",
    json: true,
  });
  expect(parseArgs(["mcp", "reload", "--json"])).toMatchObject({
    command: "mcp",
    mcpAction: "reload",
    json: true,
  });
  expect(parseArgs([
    "mcp",
    "add",
    "filesystem",
    "--transport",
    "stdio",
    "--command",
    "npx",
    "--arg",
    "-y",
    "--arg",
    "@modelcontextprotocol/server-filesystem",
    "--env",
    "ROOT=/repo",
    "--disabled",
  ])).toMatchObject({
    command: "mcp",
    mcpAction: "add",
    mcpServer: "filesystem",
    mcpTransport: "stdio",
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-filesystem"],
    mcpEnv: { ROOT: "/repo" },
    mcpEnabled: false,
  });
  expect(parseArgs(["mcp", "auth", "github", "--callback-url", "http://localhost/callback", "--scope", "repo"])).toMatchObject({
    command: "mcp",
    mcpAction: "auth",
    mcpServer: "github",
    mcpCallbackUrl: "http://localhost/callback",
    mcpScopes: ["repo"],
  });
  expect(parseArgs(["mcp", "remove", "github"])).toMatchObject({
    command: "mcp",
    mcpAction: "remove",
    mcpServer: "github",
  });
});
