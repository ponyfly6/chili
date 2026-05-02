import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface SkillResourceFile {
  path: string;
  bytes: number;
}

export interface SkillResourceListing {
  files: readonly SkillResourceFile[];
  truncated: boolean;
  omittedHidden: number;
  omittedLarge: number;
  omittedUnreadable: number;
}

export interface ListSkillResourceFilesOptions {
  maxFiles?: number;
  maxFileBytes?: number;
}

export const DEFAULT_SKILL_RESOURCE_FILE_LIMIT = 30;
export const DEFAULT_SKILL_RESOURCE_MAX_FILE_BYTES = 1_000_000;

const SKILL_FILENAME = "SKILL.md";
const EXCLUDED_DIRS = new Set([".git", "node_modules"]);

export async function listSkillResourceFiles(
  baseDir: string,
  options: ListSkillResourceFilesOptions = {},
): Promise<SkillResourceListing> {
  const maxFiles = options.maxFiles ?? DEFAULT_SKILL_RESOURCE_FILE_LIMIT;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_SKILL_RESOURCE_MAX_FILE_BYTES;
  const files: SkillResourceFile[] = [];
  const queue = [""];
  let truncated = false;
  let omittedHidden = 0;
  let omittedLarge = 0;
  let omittedUnreadable = 0;

  while (queue.length > 0) {
    const relativeDir = queue.shift() ?? "";
    const absoluteDir = path.join(baseDir, relativeDir);
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      omittedUnreadable += 1;
      continue;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) {
        omittedHidden += 1;
        continue;
      }

      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const normalizedPath = relativePath.split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) queue.push(relativePath);
        continue;
      }
      if (!entry.isFile() || entry.name === SKILL_FILENAME) continue;

      const absolutePath = path.join(baseDir, relativePath);
      let size: number;
      try {
        size = (await stat(absolutePath)).size;
      } catch {
        omittedUnreadable += 1;
        continue;
      }
      if (size > maxFileBytes) {
        omittedLarge += 1;
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push({ path: normalizedPath, bytes: size });
    }
    if (truncated) break;
  }

  return {
    files,
    truncated,
    omittedHidden,
    omittedLarge,
    omittedUnreadable,
  };
}
