import { expect, test } from "bun:test";
import { parseArgs, usage } from "./args.js";

test("--yes selects Full Access explicitly and help describes automated review", () => {
  expect(parseArgs(["--yes", "hello"]).yes).toBe(true);
  expect(parseArgs(["-y", "hello"]).yes).toBe(true);
  expect(parseArgs(["hello"]).yes).toBe(false);
  expect(usage()).toContain("Full Access: execute tools without automatic review");
});

test("parses an explicit profile directory for every CLI entry point", () => {
  expect(parseArgs(["skills", "list", "--chili-home", "/tmp/profile"]))
    .toMatchObject({ command: "skills-list", chiliHome: "/tmp/profile" });
  expect(() => parseArgs(["--chili-home"])).toThrow("--chili-home requires a value");
});

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

test("parses Z.ai as a CLI model", () => {
  expect(parseArgs(["--model", "zai", "hello"])).toMatchObject({
    command: "run",
    model: "zai",
    prompt: "hello",
  });
});

test("parses xAI and Grok as CLI models", () => {
  expect(parseArgs(["--model", "grok", "hello"])).toMatchObject({
    command: "run",
    model: "grok",
    prompt: "hello",
  });
  expect(parseArgs(["--provider", "xai", "--model", "grok-4.6", "hello"])).toMatchObject({
    command: "run",
    provider: "xai",
    model: "grok-4.6",
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

test("parses the separate Codex API provider", () => {
  expect(parseArgs(["--model", "codex-api", "hello"])).toMatchObject({
    command: "run",
    model: "codex-api",
    prompt: "hello",
  });
  expect(parseArgs(["--provider", "codex-api", "--model", "gpt-5.6-sol", "hello"])).toMatchObject({
    command: "run",
    provider: "codex-api",
    model: "gpt-5.6-sol",
    prompt: "hello",
  });
});

test("keeps current model aliases parseable", () => {
  for (const alias of ["fake", "minimax", "deepseek", "kimi", "moonshot", "zai", "glm", "xai", "x.ai", "grok", "codex", "openai-codex", "codex-api"]) {
    expect(parseArgs(["--model", alias, "hello"])).toMatchObject({
      command: "run",
      model: alias,
      prompt: "hello",
    });
  }
});

test("CLI help exposes the registered vendors and their selection aliases", () => {
  const help = usage();
  for (const provider of ["alibaba", "doubao", "zhipu", "anthropic", "openai", "openai-codex", "codex-api"]) {
    expect(help).toContain(provider);
    expect(parseArgs(["--provider", provider, "hello"])).toMatchObject({ provider, prompt: "hello" });
  }
  for (const alias of ["qwen=alibaba", "dashscope=alibaba", "ark=doubao", "bigmodel=zhipu"]) {
    expect(help).toContain(alias);
  }
});

test("parses provider and concrete model references", () => {
  expect(parseArgs(["--provider", "openai-codex", "--model", "gpt-5.6", "hello"])).toMatchObject({
    command: "run",
    provider: "openai-codex",
    model: "gpt-5.6",
    prompt: "hello",
  });
  expect(parseArgs(["--model", "openai-codex/gpt-5.6-terra", "hello"])).toMatchObject({
    command: "run",
    model: "openai-codex/gpt-5.6-terra",
    prompt: "hello",
  });
  expect(parseArgs(["--model", "codex-api/gpt-5.6-terra", "hello"])).toMatchObject({
    command: "run",
    model: "codex-api/gpt-5.6-terra",
    prompt: "hello",
  });
  expect(parseArgs(["--model", "gpt-5.6", "hello"])).toMatchObject({
    command: "run",
    model: "gpt-5.6",
    prompt: "hello",
  });
});

test("parses thinking and reasoning levels", () => {
  expect(parseArgs(["--model", "gpt-5.6-luna:high", "hello"])).toMatchObject({
    command: "run",
    model: "gpt-5.6-luna",
    reasoningLevel: "high",
    prompt: "hello",
  });
  expect(parseArgs(["--thinking", "xhigh", "hello"])).toMatchObject({
    command: "run",
    reasoningLevel: "xhigh",
    prompt: "hello",
  });
  expect(parseArgs(["--model", "gpt-5.6-sol:max", "hello"])).toMatchObject({
    command: "run",
    model: "gpt-5.6-sol",
    reasoningLevel: "max",
    prompt: "hello",
  });
  expect(parseArgs(["--thinking", "ultra", "hello"])).toMatchObject({
    command: "run",
    reasoningLevel: "ultra",
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

test("parses the read-only store doctor command", () => {
  expect(parseArgs(["store", "doctor"])).toMatchObject({ command: "store-doctor" });
  expect(parseArgs(["store", "doctor", "--json"])).toMatchObject({
    command: "store-doctor",
    json: true,
  });
  expect(() => parseArgs(["store", "recover"])).toThrow("Unknown store command: recover");
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
  expect(parseArgs(["memory", "show", "--scope", "all"])).toMatchObject({
    command: "memory-show",
    memoryScope: "all",
  });
  expect(() => parseArgs(["memory", "add", "--all", "ambiguous write scope"])).toThrow("memory add scope must be user or project");
});

test("Memory commands expose no legacy reload or migration path", () => {
  expect(() => parseArgs(["memory", "reload"])).toThrow("Unknown memory command: reload");
  expect(() => parseArgs(["memory", "refresh"])).toThrow("Unknown memory command: refresh");
  expect(() => parseArgs(["memory", "migrate"])).toThrow("Unknown memory command: migrate");
  expect(() => parseArgs(["memory", "show", "--to", "./export"])).toThrow("Unknown memory option: --to");
  expect(usage()).not.toContain("memory migrate");
  expect(usage()).not.toContain("memory reload");
});

test("parses prompt-debug command and session-only flags", () => {
  expect(parseArgs(["prompt-debug", "--resume", "session_1", "--content", "--json"])).toMatchObject({
    command: "prompt-debug",
    resume: "session_1",
    content: true,
    json: true,
  });
  expect(() => parseArgs(["prompt-debug", "--thread", "thread_1"])).toThrow("Unknown option: --thread");
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

test("agent controls identify the parent session and the target agent separately", () => {
  expect(parseArgs(["agents", "--resume", "session_parent", "--json"])).toMatchObject({
    command: "agents", resume: "session_parent", json: true,
  });
  expect(parseArgs(["agent-stop", "session_child", "--resume", "session_parent"])).toMatchObject({
    command: "agent-stop", agentId: "session_child", resume: "session_parent",
  });
  expect(parseArgs(["agent-resume", "session_child", "--resume", "session_parent"])).toMatchObject({
    command: "agent-resume", agentId: "session_child", resume: "session_parent",
  });
  expect(() => parseArgs(["agent-stop"])).toThrow("requires a value");
});

test("retired workflow flags are rejected and help exposes only agent controls", () => {
  for (const flag of ["--team", "--task", "--status", "--until-drained", "--max-cycles", "--max-concurrent-dispatches"]) {
    expect(() => parseArgs([flag, "1"])).toThrow(`Unknown option: ${flag}`);
  }
  expect(usage()).toContain("agent-stop <agent-id>");
  expect(usage()).toContain("agent-resume <agent-id>");
  expect(usage()).not.toContain("team-run");
  expect(usage()).not.toContain("recover-tasks");
  expect(parseArgs(["task", "is", "to", "review", "code"]).prompt).toBe("task is to review code");
});
