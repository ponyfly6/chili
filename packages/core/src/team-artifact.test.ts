import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { TaskId, TeamId } from "@chili/protocol";
import type { TeamTaskRow } from "@chili/store";
import { runProcess } from "@chili/tools";
import {
  captureTeamTaskArtifact,
  composeTeamTaskDependencyBase,
  type TeamTaskArtifact,
} from "./team-artifact.js";

test("artifact capture preserves HEAD and exact index bytes while recording working files", async () => {
  const dir = await createArtifactRepo();
  try {
    const head = await git(dir, ["rev-parse", "HEAD"]);
    await writeFile(join(dir, "tracked.txt"), "staged version\n");
    await git(dir, ["add", "tracked.txt"]);
    await writeFile(join(dir, "tracked.txt"), "working version\n");
    const indexPath = await git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = await readFile(indexPath);

    const artifact = await captureTeamTaskArtifact({ cwd: dir, baseRef: head });

    expect(await git(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(await git(dir, ["show", ":tracked.txt"])).toBe("staged version");
    expect(await git(dir, ["show", `${artifact.commit}:tracked.txt`])).toBe("working version");
    expect(await git(dir, ["rev-parse", `refs/chili/artifacts/${artifact.commit}`])).toBe(artifact.commit);
    const repeated = await captureTeamTaskArtifact({ cwd: dir, baseRef: head });
    expect(repeated).toEqual(artifact);
    expect(await readFile(indexPath)).toEqual(indexBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact capture excludes ordinary ignored output and Chili state", async () => {
  const dir = await createArtifactRepo();
  try {
    await mkdir(join(dir, "ignored"));
    await mkdir(join(dir, ".chili"));
    await writeFile(join(dir, "ignored", "build.txt"), "ignored build output\n");
    await writeFile(join(dir, "result.cache"), "ignored cache\n");
    await writeFile(join(dir, ".chili", "state.json"), '{"local":true}\n');
    await writeFile(join(dir, "new.txt"), "delivered source\n");

    const artifact = await captureTeamTaskArtifact({ cwd: dir, baseRef: "HEAD" });
    const paths = (await git(dir, ["ls-tree", "-r", "--name-only", artifact.commit])).split("\n");

    expect(paths).toContain("new.txt");
    expect(paths).not.toContain("ignored/build.txt");
    expect(paths).not.toContain("result.cache");
    expect(paths).not.toContain(".chili/state.json");
    expect(artifact.patch).not.toContain("ignored build output");
    expect(artifact.patch).not.toContain('"local":true');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact capture excludes staged Chili state without changing the original index", async () => {
  const dir = await createArtifactRepo();
  try {
    await mkdir(join(dir, ".chili"));
    await writeFile(join(dir, ".chili", "state.json"), '{"staged":true}\n');
    await git(dir, ["add", ".chili/state.json"]);
    const indexPath = await git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = await readFile(indexPath);

    const artifact = await captureTeamTaskArtifact({ cwd: dir, baseRef: "HEAD" });

    expect(await git(dir, ["ls-tree", "-r", "--name-only", artifact.commit, ".chili"])).toBe("");
    expect(artifact.patch).toBe("");
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(await git(dir, ["show", ":.chili/state.json"])).toBe('{"staged":true}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact capture rehashes rapid same-size edits despite unchanged cached file timestamps", async () => {
  const dir = await createArtifactRepo();
  try {
    await git(dir, ["config", "core.trustctime", "false"]);
    await git(dir, ["config", "core.checkStat", "minimal"]);
    const path = join(dir, "tracked.txt");
    const timestamp = new Date("2000-01-01T00:00:00.000Z");
    await writeFile(path, "value = 0000\n");
    await utimes(path, timestamp, timestamp);
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-q", "-m", "baseline with fixed timestamp"]);
    const baseRef = await git(dir, ["rev-parse", "HEAD"]);
    const indexPath = await git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = await readFile(indexPath);
    const trees = new Set<string>();

    for (const value of ["0001", "0002", "0003", "0004"]) {
      await writeFile(path, `value = ${value}\n`);
      await utimes(path, timestamp, timestamp);
      const artifact = await captureTeamTaskArtifact({ cwd: dir, baseRef });
      expect(await git(dir, ["show", `${artifact.commit}:tracked.txt`])).toBe(`value = ${value}`);
      trees.add(artifact.tree);
    }

    expect(trees.size).toBe(4);
    expect(await git(dir, ["rev-parse", "HEAD"])).toBe(baseRef);
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(await git(dir, ["show", ":tracked.txt"])).toBe("value = 0000");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["staged", "committed"] as const)("artifact capture retains newly %s ignored files", async (state) => {
  const dir = await createArtifactRepo();
  try {
    const baseRef = await git(dir, ["rev-parse", "HEAD"]);
    await writeFile(join(dir, "intentional.cache"), "intentionally tracked\n");
    await git(dir, ["add", "--force", "intentional.cache"]);
    if (state === "committed") await git(dir, ["commit", "-q", "-m", "track ignored file"]);
    await writeFile(join(dir, "intentional.cache"), "latest tracked content\n");
    await writeFile(join(dir, "ordinary.cache"), "ordinary ignored output\n");

    const artifact = await captureTeamTaskArtifact({ cwd: dir, baseRef });

    expect(await git(dir, ["show", `${artifact.commit}:intentional.cache`])).toBe("latest tracked content");
    expect(artifact.patch).toContain("latest tracked content");
    expect(artifact.patch).not.toContain("ordinary ignored output");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["mode", "binary", "untracked", "deletion", "symlink"] as const)("artifact identity changes for a %s change", async (kind) => {
  const dir = await createArtifactRepo();
  try {
    const before = await captureTeamTaskArtifact({ cwd: dir, baseRef: "HEAD" });
    if (kind === "mode") await chmod(join(dir, "run.sh"), 0o755);
    if (kind === "binary") await writeFile(join(dir, "binary.bin"), Buffer.from([0, 255, 127, 128, 1]));
    if (kind === "untracked") await writeFile(join(dir, "new file\nname.txt"), "new content\n");
    if (kind === "deletion") await rm(join(dir, "delete.txt"));
    if (kind === "symlink") {
      await rm(join(dir, "link"));
      await symlink("delete.txt", join(dir, "link"));
    }

    const after = await captureTeamTaskArtifact({ cwd: dir, baseRef: "HEAD" });

    expect(after.baseCommit).toBe(before.baseCommit);
    expect(after.tree).not.toBe(before.tree);
    expect(after.commit).not.toBe(before.commit);
    expect(after.patchFingerprint).not.toBe(before.patchFingerprint);
    if (kind === "mode") {
      expect(await git(dir, ["ls-tree", after.commit, "run.sh"])).toStartWith("100755 blob ");
      expect(after.patch).toContain("old mode 100644\nnew mode 100755");
    }
    if (kind === "binary") {
      expect(await git(dir, ["rev-parse", `${after.commit}:binary.bin`])).toBe(await git(dir, ["hash-object", "binary.bin"]));
      expect(after.patch).toContain("GIT binary patch");
    }
    if (kind === "untracked") expect(await git(dir, ["show", `${after.commit}:new file\nname.txt`])).toBe("new content");
    if (kind === "deletion") expect(await git(dir, ["ls-tree", after.commit, "delete.txt"])).toBe("");
    if (kind === "symlink") {
      expect(await git(dir, ["ls-tree", after.commit, "link"])).toStartWith("120000 blob ");
      expect(await git(dir, ["show", `${after.commit}:link`])).toBe("delete.txt");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dependency composition applies a diamond ancestor once and excludes dirty main files", async () => {
  const dir = await createArtifactRepo();
  try {
    const baseRef = await git(dir, ["rev-parse", "HEAD"]);
    const ancestorCwd = await createWorktree(dir, "ancestor", baseRef);
    await writeFile(join(ancestorCwd, "ancestor.txt"), "ancestor result\n");
    const ancestor = await captureTeamTaskArtifact({ cwd: ancestorCwd, baseRef });
    const leftCwd = await createWorktree(dir, "left", ancestor.commit);
    await writeFile(join(leftCwd, "left.txt"), "left result\n");
    const left = await captureTeamTaskArtifact({ cwd: leftCwd, baseRef: ancestor.commit });
    const rightCwd = await createWorktree(dir, "right", ancestor.commit);
    await writeFile(join(rightCwd, "right.txt"), "right result\n");
    const right = await captureTeamTaskArtifact({ cwd: rightCwd, baseRef: ancestor.commit });
    const tasks = [
      deliveredTask("ancestor", [], ancestor),
      deliveredTask("left", ["ancestor"], left),
      deliveredTask("right", ["ancestor"], right),
    ];
    const target = taskFixture("target", ["left", "right"]);
    await writeFile(join(dir, "tracked.txt"), "unrelated dirty main content\n");
    await writeFile(join(dir, "unrelated.txt"), "unrelated untracked file\n");
    const indexPath = await git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = await readFile(indexPath);

    const commit = await composeTeamTaskDependencyBase({ cwd: dir, baseRef, task: target, tasks });

    expect(await git(dir, ["show", `${commit}:ancestor.txt`])).toBe("ancestor result");
    expect(await git(dir, ["show", `${commit}:left.txt`])).toBe("left result");
    expect(await git(dir, ["show", `${commit}:right.txt`])).toBe("right result");
    expect(await git(dir, ["show", `${commit}:tracked.txt`])).toBe("base content");
    expect(await git(dir, ["ls-tree", commit, "unrelated.txt"])).toBe("");
    expect(await git(dir, ["rev-parse", "HEAD"])).toBe(baseRef);
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(await readFile(join(dir, "tracked.txt"), "utf8")).toBe("unrelated dirty main content\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dependency composition rejects a requested HEAD that already contains the artifact", async () => {
  const dir = await createArtifactRepo();
  try {
    const baseRef = await git(dir, ["rev-parse", "HEAD"]);
    await writeFile(join(dir, "delivered.txt"), "delivered content\n");
    const artifact = await captureTeamTaskArtifact({ cwd: dir, baseRef });
    await git(dir, ["add", "delivered.txt"]);
    await git(dir, ["commit", "-q", "-m", "main includes delivered change"]);
    const head = await git(dir, ["rev-parse", "HEAD"]);
    const indexPath = await git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = await readFile(indexPath);

    await expect(composeTeamTaskDependencyBase({
      cwd: dir,
      baseRef: "HEAD",
      task: taskFixture("target", ["dependency"]),
      tasks: [deliveredTask("dependency", [], artifact)],
    })).rejects.toThrow("already exists in index");

    expect(await git(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(await readFile(join(dir, "delivered.txt"), "utf8")).toBe("delivered content\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["unverified", "unapplied", "different_artifact"] as const)("dependency composition rejects %s delivery metadata", async (state) => {
  const dir = await createArtifactRepo();
  try {
    await writeFile(join(dir, "dependency.txt"), "dependency result\n");
    const artifact = await captureTeamTaskArtifact({ cwd: dir, baseRef: "HEAD" });
    const dependency: TeamTaskRow = {
      ...deliveredTask("dependency", [], artifact),
      metadata: {
        verification: { status: state === "unverified" ? "failed" : "passed", artifact },
        merge: {
          status: state === "unapplied" ? "pending" : "applied",
          artifactCommit: state === "different_artifact" ? artifact.baseCommit : artifact.commit,
        },
      },
    };

    await expect(composeTeamTaskDependencyBase({
      cwd: dir,
      baseRef: "HEAD",
      task: taskFixture("target", ["dependency"]),
      tasks: [dependency],
    })).rejects.toThrow("Team dependency dependency has no delivered artifact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createArtifactRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-artifact-test-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "core.fileMode", "true"]);
  await writeFile(join(dir, ".gitignore"), "ignored/\n*.cache\n");
  await writeFile(join(dir, "tracked.txt"), "base content\n");
  await writeFile(join(dir, "delete.txt"), "delete this\n");
  await writeFile(join(dir, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  await writeFile(join(dir, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await symlink("tracked.txt", join(dir, "link"));
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "baseline"]);
  return dir;
}

async function createWorktree(dir: string, name: string, baseRef: string): Promise<string> {
  const path = join(dir, ".chili", "worktrees", name);
  await mkdir(join(dir, ".chili", "worktrees"), { recursive: true });
  await git(dir, ["worktree", "add", "--detach", "-q", path, baseRef]);
  return path;
}

function taskFixture(id: string, dependsOn: string[]): TeamTaskRow {
  return {
    id: id as TaskId,
    teamId: "team_artifacts" as TeamId,
    title: id,
    status: "pending",
    dependsOn: dependsOn as TaskId[],
    createdAt: 1,
    updatedAt: 1,
  };
}

function deliveredTask(id: string, dependsOn: string[], artifact: TeamTaskArtifact): TeamTaskRow {
  return {
    ...taskFixture(id, dependsOn),
    status: "completed",
    metadata: {
      verification: { status: "passed", artifact },
      merge: { status: "applied", artifactCommit: artifact.commit },
    },
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000, maxOutputBytes: 1_000_000 });
  if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}
