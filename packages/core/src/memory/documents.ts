import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_MAX_DOCUMENT_CHARS } from "./constants.js";
import { parseProjectRuleMarkdown } from "./project-rules.js";
import type { ChiliMemoryDocument, ChiliMemoryDocumentKind, ChiliMemoryDocumentScope } from "./types.js";
import { readTextIfExists } from "./utils.js";

export async function loadDocument(
  documents: ChiliMemoryDocument[],
  missingPaths: string[],
  input: {
    kind: ChiliMemoryDocumentKind;
    scope: ChiliMemoryDocumentScope;
    label: string;
    path: string;
    maxChars: number;
    projectRoot?: string;
    targetPaths?: readonly string[];
    omittedDocuments?: { path: string; reason: string }[];
  },
): Promise<void> {
  const content = await readTextIfExists(input.path);
  if (content === undefined) {
    missingPaths.push(input.path);
    return;
  }

  const parsedRule = input.kind === "project_rule" ? parseProjectRuleMarkdown(content) : undefined;
  if (parsedRule?.metadata && !projectRuleApplies(parsedRule.metadata, input.projectRoot ?? "", input.targetPaths ?? [])) {
    input.omittedDocuments?.push({ path: input.path, reason: "rule_paths_not_applicable" });
    return;
  }
  const trimmed = (parsedRule?.body ?? content).trim();
  if (!trimmed) return;

  const limit = memoryDocumentCharLimit(input.maxChars);
  const clipped = clipMemoryDocument(trimmed, limit);
  const document: ChiliMemoryDocument = {
    kind: input.kind,
    scope: input.scope,
    label: input.label,
    path: input.path,
    content: clipped.content,
    sourceContent: content,
    truncated: clipped.truncated,
    contentVersion: createHash("sha256").update(content).digest("hex"),
  };
  if (clipped.truncated) document.truncatedAfter = limit;
  if (parsedRule?.metadata !== undefined) document.ruleMetadata = parsedRule.metadata;
  documents.push(document);
}

export function memoryDocumentDebugMetadata(document: ChiliMemoryDocument): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    path: document.path,
    kind: document.kind,
    scope: document.scope,
    truncated: document.truncated,
    truncatedAfter: document.truncatedAfter ?? null,
    contentVersion: document.contentVersion ?? null,
    ...(document.memoryId ? { memoryId: document.memoryId, memoryRevision: document.memoryRevision, memorySource: document.memorySource } : {}),
  };

  if (document.kind === "project_rule") {
    metadata.ruleType = document.ruleMetadata?.alwaysApply === false ? "path_scoped" : "unconditional";
    if (document.ruleMetadata !== undefined) {
      metadata.alwaysApply = document.ruleMetadata.alwaysApply;
      if (document.ruleMetadata.paths !== undefined) metadata.paths = document.ruleMetadata.paths;
      if (document.ruleMetadata.description !== undefined) metadata.description = document.ruleMetadata.description;
      if (document.ruleMetadata.priority !== undefined) metadata.priority = document.ruleMetadata.priority;
    }
  }

  return metadata;
}

export function renderChiliMemoryDocument(document: ChiliMemoryDocument): string {
  const lines = [
    `--- ${document.label}: ${document.path} ---`,
    document.content.trim(),
  ];
  if (document.truncated) {
    lines.push(`[truncated after ${document.truncatedAfter ?? DEFAULT_MAX_DOCUMENT_CHARS} chars]`);
  }
  lines.push(`--- end ${document.label} ---`);
  return lines.join("\n").trimEnd();
}

export function memoryDocumentCharLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_DOCUMENT_CHARS;
  return Math.max(0, Math.trunc(value));
}

export function clipMemoryDocument(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  let end = Math.min(content.length, maxChars);
  const last = content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return {
    content: content.slice(0, end).trimEnd(),
    truncated: true,
  };
}

function projectRuleApplies(metadata: NonNullable<ChiliMemoryDocument["ruleMetadata"]>, root: string, targets: readonly string[]): boolean {
  if (metadata.alwaysApply) return true;
  if (!metadata.paths?.length) return false;
  return targets.some((target) => {
    const absolute = resolve(root, target);
    const path = relative(resolve(root), absolute).replaceAll("\\", "/");
    if (path.startsWith("../") || path === ".." || isAbsolute(path)) return false;
    return metadata.paths!.some((pattern) => new Bun.Glob(pattern.replace(/^\.\//, "")).match(path));
  });
}
