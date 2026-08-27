import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDirectWritablePathInsideWorkspace,
  assertExistingPathInsideWorkspace,
  assertPathOutsideProtectedWorkspaceMetadata,
  resolveWorkspacePath,
} from "./workspace-path.js";

test("workspace paths protect only root control metadata names", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-workspace-path-root-metadata-"));
  try {
    for (const path of [
      ".git",
      ".git/config",
      "nested/../.git/config",
      ".chili",
      ".chili/snapshots/manifest.json",
      "nested/../.chili/state.json",
    ]) {
      const target = resolveWorkspacePath(workspace, path);
      await expect(assertDirectWritablePathInsideWorkspace(workspace, target)).rejects.toThrow(
        "protected workspace metadata",
      );
    }

    await mkdir(join(workspace, "packages", "fixture", ".git"), { recursive: true });
    await mkdir(join(workspace, "packages", "fixture", ".chili"), { recursive: true });
    await writeFile(join(workspace, "packages", "fixture", ".git", "config"), "nested git fixture\n", "utf8");

    const nestedGit = resolveWorkspacePath(workspace, "packages/fixture/.git/config");
    const nestedChili = resolveWorkspacePath(workspace, "packages/fixture/.chili/state.json");
    await assertDirectWritablePathInsideWorkspace(workspace, nestedGit);
    await assertDirectWritablePathInsideWorkspace(workspace, nestedChili);
    expect(resolveWorkspacePath(workspace, ".github/workflows/ci.yml").relativePath).toBe(".github/workflows/ci.yml");
    expect(resolveWorkspacePath(workspace, ".chili-notes/readme.md").relativePath).toBe(".chili-notes/readme.md");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("workspace path checks reject protected targets and symlinked parents", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-workspace-path-target-metadata-"));
  try {
    const metadataTarget = join(workspace, "runtime-state");
    await mkdir(metadataTarget);
    await writeFile(join(metadataTarget, "state.json"), "{}\n", "utf8");
    await symlink("runtime-state", join(workspace, ".chili"), "dir");
    await symlink("runtime-state", join(workspace, "state-alias"), "dir");
    const gitMetadataTarget = join(workspace, "git-metadata-target");
    await mkdir(gitMetadataTarget);
    await writeFile(join(gitMetadataTarget, "config"), "[core]\n", "utf8");
    await writeFile(join(workspace, ".git"), "gitdir: git-metadata-target\n", "utf8");
    const linkedTarget = join(workspace, "linked-hook-target");
    await writeFile(linkedTarget, "original\n", "utf8");
    await symlink("../linked-hook-target", join(gitMetadataTarget, "hook-link"));

    const existingTarget = resolveWorkspacePath(workspace, "runtime-state/state.json");
    await assertExistingPathInsideWorkspace(workspace, existingTarget);
    await expect(assertPathOutsideProtectedWorkspaceMetadata(workspace, existingTarget)).rejects.toThrow(
      "protected workspace metadata",
    );
    await expect(assertDirectWritablePathInsideWorkspace(workspace, existingTarget)).rejects.toThrow(
      "protected workspace metadata",
    );

    const missingThroughAlias = resolveWorkspacePath(workspace, "state-alias/new/manifest.json");
    await expect(assertDirectWritablePathInsideWorkspace(workspace, missingThroughAlias)).rejects.toThrow(
      "protected workspace metadata",
    );

    const gitTarget = resolveWorkspacePath(workspace, "git-metadata-target/config");
    await expect(assertDirectWritablePathInsideWorkspace(workspace, gitTarget)).rejects.toThrow(
      "protected workspace metadata",
    );

    const internalSymlinkTarget = resolveWorkspacePath(workspace, "linked-hook-target");
    await expect(assertDirectWritablePathInsideWorkspace(workspace, internalSymlinkTarget)).rejects.toThrow(
      "protected workspace metadata",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("direct writes reject hard-link aliases of protected metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-workspace-path-hardlink-metadata-"));
  try {
    await mkdir(join(workspace, ".git"));
    const protectedFile = join(workspace, ".git", "config");
    await writeFile(protectedFile, "original\n", "utf8");
    const alias = join(workspace, "config-alias");
    await link(protectedFile, alias);

    const target = resolveWorkspacePath(workspace, "config-alias");
    await expect(assertDirectWritablePathInsideWorkspace(workspace, target)).rejects.toThrow(
      "multi-link targets",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("direct writes fail closed when protected symlinks cannot be resolved", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-workspace-path-dangling-metadata-"));
  try {
    await mkdir(join(workspace, ".chili"));
    await symlink("missing-target", join(workspace, ".chili", "dangling"));

    const ordinaryTarget = resolveWorkspacePath(workspace, "ordinary.txt");
    await expect(assertDirectWritablePathInsideWorkspace(workspace, ordinaryTarget)).rejects.toThrow(
      "Cannot safely inspect protected workspace metadata",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("workspace path metadata casing follows the current filesystem", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-workspace-path-case-metadata-"));
  try {
    await mkdir(join(workspace, ".git"));
    const mixedCaseTarget = resolveWorkspacePath(workspace, ".GIT/config");
    let mixedCaseAliasesGit = false;
    try {
      mixedCaseAliasesGit = await realpath(join(workspace, ".GIT")) === await realpath(join(workspace, ".git"));
    } catch {
      // A case-sensitive filesystem treats .GIT as a distinct nested root entry.
    }

    if (mixedCaseAliasesGit) {
      await expect(assertDirectWritablePathInsideWorkspace(workspace, mixedCaseTarget)).rejects.toThrow(
        "protected workspace metadata",
      );
    } else {
      await assertDirectWritablePathInsideWorkspace(workspace, mixedCaseTarget);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
