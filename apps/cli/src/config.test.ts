import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { evaluatePolicy } from "@chili/policy";
import {
  addPersistentPermissionGrants,
  formatPermissionSpec,
  loadCliConfig,
  parsePermissionRuleSpec,
  permissionRulesFromConfig,
} from "./config.js";

test("CLI config loads user and project permission layers with Tool(content) rules", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  try {
    await mkdir(join(repo, ".chili"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.toml"),
      [
        "[permissions]",
        'ask = ["bash(*)"]',
        'allow = ["bash(git status*)", "read(*)"]',
        'deny = ["write(.chili/**)"]',
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(repo, ".chili", "config.toml"), '[permissions]\nask = ["bash(git status*)"]\n', "utf8");

    const config = await loadCliConfig(repo, { chiliHome: home });

    expect(config.userPermissions).toContainEqual(
      expect.objectContaining({ permission: "bash", pattern: "git status*", action: "allow" }),
    );
    expect(config.projectPermissions).toEqual([
      expect.objectContaining({ permission: "bash", pattern: "git status*", action: "ask" }),
    ]);
    expect(evaluatePolicy("bash", "git status --short", [config.userPermissions]).action).toBe("allow");
    expect(evaluatePolicy("bash", "git status --short", [config.userPermissions, config.projectPermissions]).action).toBe("ask");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI config discovers project permission config from child directories", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  const repo = join(root, "repo");
  const child = join(repo, "packages", "cli");
  try {
    await mkdir(join(repo, ".chili"), { recursive: true });
    await mkdir(child, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(repo, ".chili", "config.toml"), '[permissions]\ndeny = ["bash(rm -rf build)"]\n', "utf8");

    const config = await loadCliConfig(child, { chiliHome: home });

    expect(config.projectPermissions).toEqual([
      expect.objectContaining({ permission: "bash", pattern: "rm -rf build", action: "deny" }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project config rejects allow rules", () => {
  expect(() =>
    permissionRulesFromConfig(
      { permissions: { allow: ["bash(git status*)"] } },
      { source: "project .chili/config.toml", allowedActions: ["ask", "deny"] },
    ),
  ).toThrow("permissions.allow is not allowed");
});

test("permission config does not accept bare legacy rules", () => {
  expect(() => parsePermissionRuleSpec("read")).toThrow("Tool(content)");
  expect(() => permissionRulesFromConfig({ permissions: { allow: ["write"] } })).toThrow("Tool(content)");
});

test("persistent grants write stable user TOML and dedupe allow rules", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  try {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.toml"), '[permissions]\nask = ["bash(*)"]\nallow = ["read(*)"]\n', "utf8");

    await addPersistentPermissionGrants(
      [
        { permission: "bash", pattern: "git status*" },
        { permission: "read", pattern: "*" },
        { permission: "write", pattern: "src/**" },
      ],
      { chiliHome: home },
    );

    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(
      [
        "[permissions]",
        'allow = ["read(*)", "write(src/**)", "bash(git status*)"]',
        'ask = ["bash(*)"]',
        "",
      ].join("\n"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent grants preserve unrelated user config tables", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  try {
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.toml"),
      [
        "# user settings",
        'model = "gpt-5.5"',
        "",
        "[permissions]",
        'ask = ["bash(*)"]',
        "",
        "[profiles.fast]",
        'model = "gpt-5.4"',
        "",
      ].join("\n"),
      "utf8",
    );

    await addPersistentPermissionGrants([{ permission: "bash", pattern: "npm test" }], { chiliHome: home });

    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(
      [
        "# user settings",
        'model = "gpt-5.5"',
        "",
        "[permissions]",
        'allow = ["bash(npm test)"]',
        'ask = ["bash(*)"]',
        "[profiles.fast]",
        'model = "gpt-5.4"',
        "",
      ].join("\n"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent grants append permissions without replacing existing config", async () => {
  const root = await mkdtempName();
  const home = join(root, "home");
  try {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.toml"), '# user settings\nmodel = "gpt-5.5"\n', "utf8");

    await addPersistentPermissionGrants([{ permission: "read", pattern: "README.md" }], { chiliHome: home });

    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(
      [
        "# user settings",
        'model = "gpt-5.5"',
        "",
        "[permissions]",
        'allow = ["read(README.md)"]',
        "",
      ].join("\n"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permission specs escape parentheses in patterns", () => {
  const spec = formatPermissionSpec("bash", "echo (ok)");
  expect(spec).toBe("bash(echo \\(ok\\))");
  expect(parsePermissionRuleSpec(spec)).toEqual({ permission: "bash", pattern: "echo (ok)" });

  const shellEscaped = formatPermissionSpec("bash", "echo \\(ok\\)");
  expect(parsePermissionRuleSpec(shellEscaped)).toEqual({ permission: "bash", pattern: "echo \\(ok\\)" });
});

async function mkdtempName(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chili-config-"));
}
