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
  },
): Promise<void> {
  const content = await readTextIfExists(input.path);
  if (content === undefined) {
    missingPaths.push(input.path);
    return;
  }

  const parsedRule = input.kind === "project_rule" ? parseProjectRuleMarkdown(content) : undefined;
  const trimmed = (parsedRule?.body ?? content).trim();
  if (!trimmed) return;

  const clipped = clipDocument(trimmed, input.maxChars);
  const document: ChiliMemoryDocument = {
    kind: input.kind,
    scope: input.scope,
    label: input.label,
    path: input.path,
    content: clipped.content,
    truncated: clipped.truncated,
  };
  if (clipped.truncated) document.truncatedAfter = input.maxChars;
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
  };

  if (document.kind === "project_rule") {
    metadata.ruleType = "unconditional";
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

function clipDocument(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  return {
    content: content.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}
