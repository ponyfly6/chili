import { constants } from "node:fs";
import { open, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { MAX_RESULT_IMAGE_BYTES, MAX_RESULT_TEXT_BYTES, resultFileType, type DesktopResultRead } from "../shared/result-preview.js";

// Darwin's O_NOFOLLOW_ANY is not exposed by Node's fs.constants. Unlike
// O_NOFOLLOW, it rejects symlinks in every component of the canonical path.
// The two flags cannot be combined on Darwin (the kernel returns EINVAL).
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

/** No filesystem URL reaches the renderer. Reads are confined to the chosen project. */
export async function readDesktopResult(workspace: string, requestedPath: string): Promise<DesktopResultRead> {
  if (!requestedPath || requestedPath.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(requestedPath)) {
    return { status: "unavailable", reason: "outside_workspace" };
  }
  try {
    const root = await realpath(workspace);
    const target = resolve(root, requestedPath);
    if (!within(root, target)) return { status: "unavailable", reason: "outside_workspace" };
    const canonical = await realpath(target);
    if (!within(root, canonical)) return { status: "unavailable", reason: "outside_workspace" };
    const type = resultFileType(canonical);
    if (!type) return { status: "unavailable", reason: "unsupported" };
    const initial = await stat(canonical);
    if (!initial.isFile()) return { status: "unavailable", reason: "not_file" };
    const limit = type.kind === "image" ? MAX_RESULT_IMAGE_BYTES : MAX_RESULT_TEXT_BYTES;
    if (initial.size > limit) return { status: "unavailable", reason: "too_large" };
    // Pin the read to a validated handle. Checking pathnames again alone cannot
    // prevent a parent directory from being replaced between realpath and open.
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return { status: "unavailable", reason: "unavailable" };
    }
    const noFollow = process.platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : constants.O_NOFOLLOW;
    const file = await open(canonical, constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
    try {
      // Linux exposes the kernel's actual path for the already opened inode.
      // Use readlink directly: realpath would resolve the returned pathname and
      // reintroduce the directory substitution race. Missing procfs fails closed.
      if (process.platform === "linux" && await readlink(`/proc/self/fd/${file.fd}`) !== canonical) {
        return { status: "unavailable", reason: "outside_workspace" };
      }
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino) {
        return { status: "unavailable", reason: "not_file" };
      }
      if (opened.size > limit) return { status: "unavailable", reason: "too_large" };
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > limit) return { status: "unavailable", reason: "too_large" };
      const currentPath = await realpath(target);
      const current = await stat(currentPath);
      const after = await file.stat();
      if (!within(root, currentPath) || currentPath !== canonical || current.dev !== opened.dev
        || current.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
        return { status: "unavailable", reason: "unavailable" };
      }
      if (process.platform === "linux" && await readlink(`/proc/self/fd/${file.fd}`) !== canonical) {
        return { status: "unavailable", reason: "outside_workspace" };
      }
      const bytes = buffer.subarray(0, length);
      let content: string;
      if (type.kind === "image") {
        if (!matchesImageSignature(bytes, type.mimeType)) return { status: "unavailable", reason: "unsupported" };
        content = bytes.toString("base64");
      } else {
        if (bytes.includes(0)) return { status: "unavailable", reason: "invalid_text" };
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { return { status: "unavailable", reason: "invalid_text" }; }
      }
      return { status: "ready", path: relative(root, canonical), ...type, content, bytes: length };
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: "unavailable", reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable" };
  }
}

function within(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(remainder);
}

function matchesImageSignature(bytes: Buffer, mime: string): boolean {
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6));
  if (mime === "image/webp") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return false;
}
