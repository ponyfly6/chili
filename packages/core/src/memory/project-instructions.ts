import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { CHILI_MEMORY_DIR, CHILI_MEMORY_FILENAME, PROJECT_INSTRUCTION_FILES } from "./constants.js";
import { projectRuleSources } from "./project-rules.js";
import type { ChiliMemoryDocumentSource, ChiliMemoryLoadOptions, ChiliMemoryPaths, ChiliMemoryScope } from "./types.js";

const execFileAsync = promisify(execFile);

export async function resolveChiliMemoryPaths(options: ChiliMemoryLoadOptions, includeInstructions = true): Promise<ChiliMemoryPaths> {
  const projectRoot = resolve(options.projectRoot ?? (await findProjectRoot(options.cwd)));
  const cwd = resolve(options.cwd);
  const home = resolve(options.homeDir ?? homedir());
  const chiliHome = resolve(options.chiliHome ?? join(home, CHILI_MEMORY_DIR));
  const canonicalRoot = await realpath(projectRoot).catch(() => projectRoot);
  return {
    chiliHome,
    databasePath: join(chiliHome, "memory.sqlite"),
    projectId: options.projectId ?? canonicalRoot,
    projectRoot,
    userMemoryPath: join(chiliHome, CHILI_MEMORY_FILENAME),
    projectMemoryPath: join(projectRoot, CHILI_MEMORY_DIR, CHILI_MEMORY_FILENAME),
    instructions: includeInstructions ? await resolveProjectInstructionSources(projectRoot, cwd, options.targetPaths ?? []) : [],
  };
}

export function memoryPathForScope(
  paths: {
    userMemoryPath: string;
    projectMemoryPath: string;
  },
  scope: ChiliMemoryScope,
): string {
  return scope === "user" ? paths.userMemoryPath : paths.projectMemoryPath;
}

async function resolveProjectInstructionSources(projectRoot: string, cwd: string, targets: readonly string[]): Promise<ChiliMemoryDocumentSource[]> {
  const sources: ChiliMemoryDocumentSource[] = [];
  const dirs = new Set(projectInstructionDirs(projectRoot, cwd));
  for (const target of targets.slice(0, 64)) {
    const absolute = resolve(projectRoot, target);
    if (!isInsideOrEqual(projectRoot, absolute)) continue;
    for (const dir of projectInstructionDirs(projectRoot, dirname(absolute))) dirs.add(dir);
  }
  for (const dir of dirs) {
    for (const file of PROJECT_INSTRUCTION_FILES) {
      sources.push({
        kind: "project_instruction",
        scope: "project",
        label: `Project instruction (${relative(projectRoot, join(dir, file)) || file})`,
        path: join(dir, file),
      });
    }

    for (const rule of await projectRuleSources(dir, projectRoot)) {
      sources.push(rule);
    }
  }
  return sources;
}

function projectInstructionDirs(projectRoot: string, cwd: string): string[] {
  const root = resolve(projectRoot);
  const target = isInsideOrEqual(root, cwd) ? resolve(cwd) : root;
  const rel = relative(root, target);
  const segments = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
  const dirs = [root];
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    dirs.push(current);
  }
  return dirs;
}

function isInsideOrEqual(root: string, target: string): boolean {
  const rel = relative(root, resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function findProjectRoot(cwd: string): Promise<string> {
  const fallback = resolve(cwd);
  try {
    const result = await execFileAsync("git", ["-C", fallback, "rev-parse", "--show-toplevel"], {
      timeout: 1_000,
      maxBuffer: 16_000,
    });
    const root = String(result.stdout).trim();
    return root ? resolve(root) : fallback;
  } catch {
    return fallback;
  }
}
