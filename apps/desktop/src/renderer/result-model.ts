import type { ChatTranscriptItem } from "@chili/sdk";

export interface DesktopResult {
  id: string;
  path: string;
  label: string;
  description?: string;
  source: "assistant" | "tool";
  messageId: string;
  updatedAt: number;
}

/** Only a successful, explicit file delivery belongs in the result surface. */
export function discoverDesktopResults(items: readonly ChatTranscriptItem[], workspace: string | undefined): DesktopResult[] {
  if (!workspace) return [];
  const results = new Map<string, DesktopResult>();
  for (const item of items) {
    if (item.kind !== "tool" || item.toolName !== "present_file" || item.displayStatus !== "succeeded" || item.error || !item.output) continue;
    let output: unknown;
    try { output = JSON.parse(item.output); } catch { continue; }
    if (!isRecord(output) || output.type !== "presented_file" || typeof output.path !== "string"
      || (output.title !== undefined && typeof output.title !== "string")
      || (output.description !== undefined && typeof output.description !== "string")) continue;
    const path = localResultPath(output.path, workspace);
    if (!path || (results.get(path)?.updatedAt ?? -Infinity) > item.updatedAt) continue;
    const title = typeof output.title === "string" ? output.title.trim().slice(0, 120) : "";
    const description = typeof output.description === "string" ? output.description.trim().slice(0, 500) : "";
    // Re-insertion makes a later delivery win when timestamps are equal.
    results.delete(path);
    results.set(path, { id: path, path, label: title || path.split("/").at(-1) || path,
      ...(description ? { description } : {}), source: "tool", messageId: String(item.id), updatedAt: item.updatedAt });
  }
  return [...results.values()].reverse().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Convert a tool's canonical absolute path without interpreting it as a URL. */
export function localResultPath(rawPath: string, workspace: string): string | undefined {
  if (!rawPath || rawPath.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(rawPath)) return undefined;
  const windows = /^[a-z]:[\\/]/iu.test(workspace);
  const path = windows ? rawPath.replaceAll("\\", "/") : rawPath;
  const root = (windows ? workspace.replaceAll("\\", "/") : workspace).replace(/\/+$/u, "");
  const prefix = `${root}/`;
  if (!(windows ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix))) return undefined;
  const relative = path.slice(prefix.length);
  if (!relative || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return relative;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
