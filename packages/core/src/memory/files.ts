import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** A plain directory walk: nested Markdown is allowed; symlinks are never followed. */
export function readMemoryMarkdownFiles(root: string, scopeDirectory: string): { path: string; text: string }[] {
  if (!scopeDirectories(root, scopeDirectory, false)) return [];
  const canonicalScope = realpathSync(scopeDirectory);
  const result: { path: string; text: string }[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      // Recheck a path discovered earlier so a replaced directory cannot lead a
      // read outside this scope. The file itself is opened without following links.
      let canonical: string;
      try { canonical = realpathSync(path); } catch (error) { if (isMissing(error)) continue; throw error; }
      if (!inside(canonicalScope, canonical)) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        let fd: number;
        try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
        catch (error) { if (isMissing(error) || hasCode(error, "ELOOP")) continue; throw error; }
        try {
          // Fatal UTF-8 decoding avoids quietly replacing malformed source bytes.
          const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(fd));
          result.push({ path, text });
        } finally { closeSync(fd); }
      }
    }
  };
  visit(scopeDirectory);
  return result;
}

/** Write a complete file before exposing its final name; never replace an existing file. */
export function writeNewMemoryMarkdown(root: string, path: string, text: string): void {
  const directory = dirname(path);
  scopeDirectories(root, directory, true);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temporary, path);
  } finally { unlinkSync(temporary); }
  syncDirectory(directory);
}

/** Scope components beneath the chosen profile cannot redirect to another scope. */
function scopeDirectories(root: string, directory: string, create: boolean): boolean {
  const base = resolve(root);
  const target = resolve(directory);
  if (!inside(base, target)) throw new Error("Memory directory must stay inside the profile Memory root");
  if (create) mkdirSync(dirname(base), { recursive: true, mode: 0o700 });
  const components = [base];
  const tail = relative(base, target);
  let current = base;
  for (const component of tail.split(/[\\/]+/).filter(Boolean)) { current = join(current, component); components.push(current); }
  for (const path of components) {
    if (create) {
      try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    }
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (!create && isMissing(error)) return false; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Memory scope must be an ordinary directory: ${path}`);
  }
  if (create) for (const path of components.toReversed()) syncDirectory(dirname(path));
  return true;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function isMissing(error: unknown): boolean { return hasCode(error, "ENOENT"); }

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
