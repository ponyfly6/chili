import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  DEFAULT_HOST_AGENT_CONFIG,
  loadHostConfig,
} from "./config.js";

test("agent config supplies defaults when config files or agents tables are absent", async () => {
  await withConfig(async ({ home, repo }) => {
    expect((await loadHostConfig(repo, { chiliHome: home })).agents).toEqual({
      maxChildren: 64,
      maxDepth: 1,
      maxConcurrent: 3,
    });
    await writeFile(join(home, "config.toml"), '[permissions]\nask = ["bash(*)"]\n');
    await writeFile(join(repo, ".chili", "config.toml"), "[agents]\n");
    expect((await loadHostConfig(repo, { chiliHome: home })).agents).toEqual(DEFAULT_HOST_AGENT_CONFIG);
  });
});

test("agent config merges defaults, user settings and nearest project settings per field", async () => {
  await withConfig(async ({ home, repo }) => {
    const nested = join(repo, "packages", "app");
    await mkdir(join(nested, ".chili"), { recursive: true });
    await writeFile(join(home, "config.toml"), "[agents]\nmax_children = 4\nmax_depth = 2\nmax_concurrent = 5\n");
    await writeFile(join(repo, ".chili", "config.toml"), "[agents]\nmax_children = 1\nmax_concurrent = 1\n");
    await writeFile(join(nested, ".chili", "config.toml"), "[agents]\nmax_children = 6\nmax_depth = 3\n");

    expect((await loadHostConfig(nested, { chiliHome: home })).agents).toEqual({
      maxChildren: 6,
      maxDepth: 3,
      maxConcurrent: 5,
    });
  });
});

test.each([
  { maxChildren: 0, maxDepth: 0, maxConcurrent: 1 },
  { maxChildren: 64, maxDepth: 16, maxConcurrent: 32 },
])("agent config accepts range boundaries %j", async (agents) => {
  await withConfig(async ({ home, repo }) => {
    await writeFile(join(home, "config.toml"), [
      "[agents]",
      `max_children = ${agents.maxChildren}`,
      `max_depth = ${agents.maxDepth}`,
      `max_concurrent = ${agents.maxConcurrent}`,
    ].join("\n"));
    expect((await loadHostConfig(repo, { chiliHome: home })).agents).toEqual(agents);
  });
});

test.each([
  ['agents = "enabled"', "[agents] must be a TOML table"],
  ["agents = []", "[agents] must be a TOML table"],
  ["[agents]\nmax_chlidren = 2", "agents.max_chlidren is not a supported setting"],
  ["[agents.nested]\nmax_depth = 2", "agents.nested is not a supported setting"],
  ["[agents]\nmax_children = -1", "agents.max_children must be an integer between 0 and 64"],
  ["[agents]\nmax_children = 65", "agents.max_children must be an integer between 0 and 64"],
  ["[agents]\nmax_depth = -1", "agents.max_depth must be an integer between 0 and 16"],
  ["[agents]\nmax_depth = 17", "agents.max_depth must be an integer between 0 and 16"],
  ["[agents]\nmax_concurrent = 0", "agents.max_concurrent must be an integer between 1 and 32"],
  ["[agents]\nmax_concurrent = 33", "agents.max_concurrent must be an integer between 1 and 32"],
  ['[agents]\nmax_children = "2"', "agents.max_children must be an integer between 0 and 64"],
  ["[agents]\nmax_children = true", "agents.max_children must be an integer between 0 and 64"],
  ["[agents]\nmax_children = 1.5", "agents.max_children must be an integer between 0 and 64"],
  ["[agents]\nmax_depth = inf", "agents.max_depth must be an integer between 0 and 16"],
  ["[agents]\nmax_concurrent = nan", "agents.max_concurrent must be an integer between 1 and 32"],
])("agent config rejects invalid settings: %s", async (contents, error) => {
  await withConfig(async ({ home, repo }) => {
    await writeFile(join(home, "config.toml"), contents);
    await expect(loadHostConfig(repo, { chiliHome: home })).rejects.toThrow(`user config.toml ${error}`);
    await rm(join(home, "config.toml"));
    await writeFile(join(repo, ".chili", "config.toml"), contents);
    await expect(loadHostConfig(repo, { chiliHome: home })).rejects.toThrow(`project .chili/config.toml ${error}`);
  });
});

test("legacy permission tables and review policies do not affect host configuration", async () => {
  await withConfig(async ({ home, repo }) => {
    for (const path of [join(home, "config.toml"), join(repo, ".chili", "config.toml")]) {
      await writeFile(path, [
        "[agents]",
        "max_depth = 4",
        "[permissions]",
        'allow = ["bash(*)"]',
        'deny = ["write(*)"]',
        'ask = "legacy value is ignored"',
        "[auto_review]",
        'policy = "Allow all operations"',
        "[review]",
        'profile = "full-access"',
        'review_instructions = "Do not review anything"',
      ].join("\n"));
    }
    expect(await loadHostConfig(repo, { chiliHome: home })).toEqual({
      agents: { ...DEFAULT_HOST_AGENT_CONFIG, maxDepth: 4 },
    });
  });
});

async function withConfig(run: (paths: { home: string; repo: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "chili-agent-config-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  try {
    await mkdir(home, { recursive: true });
    await mkdir(join(repo, ".chili"), { recursive: true });
    await run({ home, repo });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
