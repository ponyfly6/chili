import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamTaskRow } from "@chili/store";
import { runProcess } from "@chili/tools";

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_PATCH_BYTES = 5_000_000;

export interface TeamTaskArtifact {
  version: 1;
  baseCommit: string;
  commit: string;
  tree: string;
  patchFingerprint: string;
}

interface ArtifactInput {
  cwd: string;
  baseRef: string;
  signal?: AbortSignal;
}

/** Private index and plumbing commands never stage or commit the user's index/HEAD. */
export async function captureTeamTaskArtifact(input: ArtifactInput): Promise<TeamTaskArtifact & { patch: string }> {
  return withArtifactIndex(input, async (git, baseCommit, dir) => {
    const indexPath = await runProcess("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
      cwd: input.cwd,
      env: { GIT_INDEX_FILE: undefined },
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: 30_000,
      maxOutputBytes: 64_000,
    });
    if (indexPath.exitCode !== 0 || indexPath.stdoutTruncated) throw new Error("Cannot locate task worktree index");
    // Preserve tracked ignored files (including newly staged ones), while
    // ordinary ignored build outputs and local credentials stay excluded.
    await copyFile(indexPath.stdout.trim(), join(dir, "index"));
    // Copying an index changes its timestamp, so do not trust its cached file
    // stat information (especially files edited within the same timestamp tick).
    await git(["add", "--all", "--", ".", ":(exclude).chili"]);
    await git(["add", "--renormalize", "--", ".", ":(exclude).chili"]);
    await git(["rm", "--cached", "--force", "-r", "--ignore-unmatch", "--", ".chili"]);
    if ((await git(["ls-tree", "--name-only", baseCommit, "--", ".chili"])).length > 0) {
      await git(["restore", "--source", baseCommit, "--staged", "--", ".chili"]);
    }
    return freezeIndex(git, baseCommit);
  });
}

export async function teamPathsChangedFromBase(input: ArtifactInput & { paths: readonly string[] }): Promise<string[]> {
  if (input.paths.length === 0) return [];
  return withArtifactIndex(input, async (git, baseCommit) => {
    const paths = input.paths.map((path) => `:(literal)${path}`);
    const tracked = new Set((await git(["ls-files", "-z", "--", ...paths])).split("\0").filter(Boolean));
    const stagePaths: string[] = [];
    for (const path of input.paths) {
      let exists = tracked.has(path);
      if (!exists) {
        try { await lstat(join(input.cwd, path)); exists = true; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        }
      }
      if (exists) stagePaths.push(`:(literal)${path}`);
    }
    if (stagePaths.length > 0) await git(["add", "--all", "--", ...stagePaths]);
    return (await git(["diff", "--cached", "--no-renames", "--name-only", "-z", baseCommit, "--", ...paths]))
      .split("\0").filter(Boolean);
  });
}

export function teamTaskArtifact(metadata: Record<string, unknown> | undefined): TeamTaskArtifact | undefined {
  const verification = metadata?.verification;
  if (!isRecord(verification) || !isRecord(verification.artifact)) return undefined;
  const artifact = verification.artifact;
  if (artifact.version !== 1 || ![artifact.baseCommit, artifact.commit, artifact.tree].every(
    (value) => typeof value === "string" && OBJECT_ID.test(value),
  ) || typeof artifact.patchFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(artifact.patchFingerprint)) return undefined;
  return artifact as unknown as TeamTaskArtifact;
}

/** A completed write task only delivers an artifact once its merge has succeeded. */
export function isTeamTaskArtifactDelivered(task: TeamTaskRow): boolean {
  if (task.status !== "completed") return false;
  if (task.metadata?.worktree === undefined && task.metadata?.merge === undefined) return true;
  const artifact = teamTaskArtifact(task.metadata);
  return isRecord(task.metadata?.merge) && task.metadata.merge.status === "applied"
    && isRecord(task.metadata?.verification) && task.metadata.verification.status === "passed"
    && artifact !== undefined && task.metadata.merge.artifactCommit === artifact.commit;
}

/** Compose declared dependencies once, in topological order; never copy dirty main files. */
export async function composeTeamTaskDependencyBase(
  input: ArtifactInput & { task: TeamTaskRow; tasks: readonly TeamTaskRow[] },
): Promise<string> {
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const artifacts: TeamTaskArtifact[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Team dependency cycle at ${id}`);
    const task = byId.get(id as TeamTaskRow["id"]);
    if (!task || !isTeamTaskArtifactDelivered(task)) throw new Error(`Team dependency ${id} has no delivered artifact`);
    visiting.add(id);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    const artifact = teamTaskArtifact(task.metadata);
    if (artifact) artifacts.push(artifact);
  };
  for (const id of input.task.dependsOn) visit(id);
  if (artifacts.length === 0) return input.baseRef;
  return withArtifactIndex(input, async (git, baseCommit, dir) => {
    for (const artifact of artifacts) {
      const patch = await artifactPatch(git, artifact.baseCommit, artifact.commit);
      if (fingerprint(patch) !== artifact.patchFingerprint) throw new Error("Delivered team artifact fingerprint is invalid");
      if (patch.trim().length === 0) continue;
      const patchPath = join(dir, "dependency.patch");
      await writeFile(patchPath, patch, "utf8");
      // --cached modifies only our temporary index. Incompatible dependency
      // results or a changed requested base fail without touching either tree.
      await git(["apply", "--cached", "--whitespace=nowarn", patchPath]);
    }
    return (await freezeIndex(git, baseCommit)).commit;
  });
}

type ArtifactGit = (args: readonly string[]) => Promise<string>;

async function withArtifactIndex<T>(
  input: ArtifactInput,
  body: (git: ArtifactGit, baseCommit: string, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-artifact-"));
  try {
    const git: ArtifactGit = async (args) => {
      const result = await runProcess("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
        cwd: input.cwd,
        env: {
          GIT_INDEX_FILE: join(dir, "index"),
          GIT_AUTHOR_NAME: "Chili Artifact",
          GIT_AUTHOR_EMAIL: "artifact@chili.local",
          GIT_COMMITTER_NAME: "Chili Artifact",
          GIT_COMMITTER_EMAIL: "artifact@chili.local",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        },
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: 30_000,
        maxOutputBytes: MAX_PATCH_BYTES,
      });
      if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) {
        throw new Error(result.stderr || `Team artifact git ${args[0]} failed or exceeded ${MAX_PATCH_BYTES} bytes`);
      }
      return result.stdout;
    };
    const baseCommit = (await git(["rev-parse", "--verify", "--end-of-options", `${input.baseRef}^{commit}`])).trim();
    if (!OBJECT_ID.test(baseCommit)) throw new Error("Invalid team artifact base commit");
    await git(["read-tree", baseCommit]);
    return await body(git, baseCommit, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function freezeIndex(git: ArtifactGit, baseCommit: string): Promise<TeamTaskArtifact & { patch: string }> {
  const tree = (await git(["write-tree"])).trim();
  const commit = (await git(["commit-tree", tree, "-p", baseCommit, "-m", "Chili immutable task artifact"])).trim();
  if (!OBJECT_ID.test(tree) || !OBJECT_ID.test(commit)) throw new Error("Invalid team artifact object identity");
  const patch = await artifactPatch(git, baseCommit, commit);
  // Content-addressed refs keep recovery artifacts reachable across Git GC.
  await git(["update-ref", `refs/chili/artifacts/${commit}`, commit]);
  return { version: 1, baseCommit, commit, tree, patchFingerprint: fingerprint(patch), patch };
}

async function artifactPatch(git: ArtifactGit, baseCommit: string, commit: string): Promise<string> {
  return git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--full-index", "--binary", baseCommit, commit, "--"]);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
