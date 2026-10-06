import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRule } from "@chili/policy";
import { resolveFileResourceDenials } from "./resource-policy.js";

async function workspaceTest(run: (cwd: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "chili-resource-policy-"));
  const cwd = await realpath(directory);
  try { await run(cwd); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("resource denials remain canonical and deny-first across operation kinds", async () => workspaceTest(async (cwd) => {
  await writeFile(join(cwd, "secret"), "private");
  await symlink("secret", join(cwd, "alias*"));
  await mkdir(join(cwd, "private"));
  const rules: PermissionRule[] = [
    { permission: "read(./alias*)", pattern: "*", action: "deny" },
    { permission: "grep", pattern: "private/*", action: "deny" },
    { permission: "edit", pattern: "./new.txt", action: "deny" },
    { permission: "write", pattern: join(cwd, "secret"), action: "deny" },
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "*", pattern: "*", action: "ask" },
  ];
  expect(await resolveFileResourceDenials(cwd, [rules])).toEqual({
    readPaths: [join(cwd, "private"), join(cwd, "secret")],
    writePaths: [join(cwd, "new.txt"), join(cwd, "secret")],
  });
}));

test("wildcard resources bind the workspace while absolute resources may be outside it", async () => workspaceTest(async (cwd) => {
  await workspaceTest(async (outside) => {
    await writeFile(join(outside, "secret"), "private");
    expect(await resolveFileResourceDenials(cwd, [[
      { permission: "read", pattern: "*", action: "deny" },
      { permission: `write(${join(outside, "secret")})`, pattern: "*", action: "deny" },
    ]])).toEqual({ readPaths: [cwd], writePaths: [join(outside, "secret")] });
  });
}));

test("unrepresentable glob and hard-linked denied resources fail closed", async () => workspaceTest(async (cwd) => {
  for (const pattern of ["**/.env", "secret*.txt", "private/**/*.key"]) {
    await expect(resolveFileResourceDenials(cwd, [[{ permission: "read", pattern, action: "deny" }]]))
      .rejects.toThrow("Cannot enforce resource deny pattern");
  }
  await writeFile(join(cwd, "secret"), "private");
  await link(join(cwd, "secret"), join(cwd, "alias"));
  await expect(resolveFileResourceDenials(cwd, [[{ permission: "read", pattern: "secret", action: "deny" }]]))
    .rejects.toThrow("multi-link targets");
}));

test("unrelated permissions do not invent filesystem restrictions", async () => workspaceTest(async (cwd) => {
  expect(await resolveFileResourceDenials(cwd, [[
    { permission: "mcp", pattern: "remote.search", action: "deny" },
    { permission: "memory.write", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "printf *", action: "ask" },
  ]])).toBeUndefined();
}));
