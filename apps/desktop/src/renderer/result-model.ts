import type { ChatTranscriptItem } from "@chili/sdk";
import { resultFileType } from "../shared/result-preview.js";

export interface DesktopResult {
  id: string;
  path: string;
  label: string;
  source: "assistant" | "tool";
  messageId: string;
  updatedAt: number;
}

/** File references are evidence of a candidate; only the host can verify it exists. */
export function discoverDesktopResults(items: readonly ChatTranscriptItem[], workspace: string | undefined): DesktopResult[] {
  if (!workspace) return [];
  const results = new Map<string, DesktopResult>();
  const add = (rawPath: string, label: string, source: DesktopResult["source"], messageId: string, updatedAt: number) => {
    const path = localResultPath(rawPath, workspace);
    if (!path || !resultFileType(path)) return;
    results.delete(path);
    results.set(path, { id: path, path, label: label.trim().slice(0, 120) || path.split("/").at(-1) || path, source, messageId, updatedAt });
    if (results.size > 80) results.delete(results.keys().next().value!);
  };
  const links = (text: string, source: DesktopResult["source"], id: string, time: number) => {
    const prose = text.slice(0, 512_000).replace(/```[^\n]*\n[\s\S]*?(?:```|$)/gu, "");
    for (const match of prose.matchAll(/!?\[([^\]\n]{1,200})\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/gu)) {
      add(match[2] ?? match[3] ?? "", match[1] ?? "", source, id, time);
    }
  };
  for (const item of items.slice(-5_000)) {
    if (item.kind === "message" && item.role === "assistant") {
      for (const part of item.parts) {
        if (part.type === "text") links(part.text, "assistant", String(item.id), item.completedAt ?? item.createdAt);
        if (part.type === "image" && part.sourcePath) add(part.sourcePath, part.filename ?? "", "assistant", String(item.id), item.completedAt ?? item.createdAt);
      }
    }
    if (item.kind !== "tool" || item.displayStatus !== "succeeded" || item.error) continue;
    if (["write", "write_file", "edit"].includes(item.toolName) && isRecord(item.input)) {
      const path = item.input.filePath ?? item.input.file_path ?? item.input.path;
      if (typeof path === "string") add(path, "", "tool", String(item.id), item.updatedAt);
    }
    if (item.toolName === "apply_patch" && item.output) {
      for (const match of item.output.matchAll(/^[AM] (.+)$/gmu)) add(match[1] ?? "", "", "tool", String(item.id), item.updatedAt);
    }
  }
  return [...results.values()].reverse();
}

export function localResultPath(rawPath: string, workspace: string): string | undefined {
  let path = rawPath.trim();
  if (!path || path.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(path)) return undefined;
  if (path.startsWith("file:")) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return undefined;
      path = decodeURIComponent(url.pathname);
    } catch { return undefined; }
  } else if (/^[a-z][a-z0-9+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path)) return undefined;
  else {
    try { path = decodeURIComponent(path); } catch { return undefined; }
  }
  path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)$/u, "").replaceAll("\\", "/");
  const root = workspace.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (path.startsWith("/") || /^[a-z]:\//iu.test(path)) {
    if (!path.startsWith(`${root}/`)) return undefined;
    path = path.slice(root.length + 1);
  }
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (!segments.length) return undefined; segments.pop(); }
    else segments.push(segment);
  }
  const result = segments.join("/");
  return result && !/[\u0000-\u001f\u007f]/u.test(result) ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
