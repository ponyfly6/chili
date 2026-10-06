import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Message, SessionId } from "@chili/protocol";

const FILE_TOOLS = new Set(["read", "read_file", "write", "write_file", "edit", "replace", "read_image", "view_image", "image_read", "apply_patch", "glob", "file_glob", "grep", "grep_search"]);
const MAX_TARGETS = 64;
const MAX_MESSAGES = 256;
const MAX_PARTS = 128;

/** Known session file targets inform rule selection, not authorization or file access. */
export async function targetPathsForSession(
  store: { messages(sessionId: SessionId): Promise<Message[]> },
  sessionId: SessionId,
  cwd: string,
): Promise<string[]> {
  const root = await realpath(resolve(cwd)).catch(() => resolve(cwd));
  const candidates: string[] = [];
  const messages = await store.messages(sessionId);
  // Recent actual tool inputs take precedence; never infer instructions from tool output text.
  for (const message of messages.slice(-MAX_MESSAGES).reverse()) {
    if (message.role !== "assistant" && message.role !== "tool") continue;
    for (const part of message.parts.slice(-MAX_PARTS).reverse()) {
      if (part.type === "patch") candidates.push(...part.files.slice(0, MAX_TARGETS));
      if (part.type === "tool_call" && message.role === "assistant" && FILE_TOOLS.has(part.toolName) && isRecord(part.input)) {
        candidates.push(...inputPaths(part.input));
      }
      if (candidates.length >= MAX_TARGETS * 4) break;
    }
    if (candidates.length >= MAX_TARGETS * 4) break;
  }
  const targets = new Set<string>();
  for (const candidate of candidates.slice(0, MAX_TARGETS * 4)) {
    if (!candidate.trim() || candidate.length > 4096 || candidate.includes("\0")) continue;
    const logical = resolve(root, candidate);
    if (!inside(root, logical)) continue;
    const canonical = await canonicalCandidate(logical);
    if (!canonical || !inside(root, canonical)) continue;
    targets.add(canonical);
    if (targets.size >= MAX_TARGETS) break;
  }
  return [...targets];
}

function inputPaths(input: Record<string, unknown>): string[] {
  const targets: string[] = [];
  for (const key of ["path", "file_path", "filePath", "movePath"]) if (typeof input[key] === "string") targets.push(input[key]);
  if (Array.isArray(input.paths)) targets.push(...input.paths.filter((item): item is string => typeof item === "string").slice(0, MAX_TARGETS));
  if (Array.isArray(input.operations)) {
    for (const operation of input.operations.slice(0, MAX_TARGETS)) {
      if (!isRecord(operation)) continue;
      for (const key of ["path", "movePath"]) if (typeof operation[key] === "string") targets.push(operation[key]);
    }
  }
  if (typeof input.patchText === "string") {
    for (const line of input.patchText.slice(0, 1024 * 1024).split("\n").slice(0, 5000)) {
      const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/.exec(line);
      if (match?.[1]) targets.push(match[1].trim());
      if (targets.length >= MAX_TARGETS) break;
    }
  }
  return targets;
}

async function canonicalCandidate(path: string): Promise<string | undefined> {
  const suffix: string[] = [];
  let current = path;
  for (let depth = 0; depth < 128; depth++) {
    try { return resolve(await realpath(current), ...suffix); }
    catch (error) {
      if (!isRecord(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
  return undefined;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
