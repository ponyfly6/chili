import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { PromptFragment } from "../prompt/index.js";
import { DEFAULT_MAX_DOCUMENT_CHARS, MEMORY_MECHANICS_PROMPT } from "./constants.js";
import { loadDocument, memoryDocumentDebugMetadata, renderChiliMemoryDocument } from "./documents.js";
import { searchChiliMemoryEntries } from "./entries.js";
import { resolveChiliMemoryPaths } from "./project-instructions.js";
import type { ChiliMemoryDocument, ChiliMemoryLoadOptions, ChiliMemorySnapshot } from "./types.js";

export async function loadChiliMemoryContext(options: ChiliMemoryLoadOptions): Promise<ChiliMemorySnapshot> {
  const paths = await resolveChiliMemoryPaths(options);
  const documents: ChiliMemoryDocument[] = [];
  const missingPaths: string[] = [];
  const maxChars = options.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS;

  const omittedDocuments: { path: string; reason: string }[] = [];
  const memoryScopes = options.memoryScopes ?? ["user", "project"];
  for (const scope of ["user", "project"] as const) {
    if (!memoryScopes.includes(scope)) omittedDocuments.push({ path: `${paths.databasePath}#${scope}`, reason: "memory_read_not_authorized" });
  }
  for (const entry of await searchChiliMemoryEntries(options)) {
    const truncated = entry.text.length > maxChars;
    documents.push({
      kind: entry.scope === "user" ? "user_memory" : "project_memory",
      scope: entry.scope,
      label: `${entry.scope === "user" ? "User" : "Project"} memory (${entry.id})`,
      path: entry.path,
      content: entry.text.slice(0, maxChars),
      truncated,
      ...(truncated ? { truncatedAfter: maxChars } : {}),
      contentVersion: createHash("sha256").update(`${entry.id}:${entry.revision}:${entry.text}`).digest("hex"),
      memoryId: entry.id,
      memoryRevision: entry.revision,
      memorySource: entry.source,
    });
  }
  for (const instruction of paths.instructions) {
    await loadDocument(documents, missingPaths, {
      kind: instruction.kind,
      scope: instruction.scope,
      label: instruction.label,
      path: instruction.path,
      maxChars,
      projectRoot: paths.projectRoot,
      targetPaths: options.targetPaths ?? [],
      omittedDocuments,
    });
  }

  return {
    cwd: resolve(options.cwd),
    projectRoot: paths.projectRoot,
    userMemoryPath: paths.userMemoryPath,
    projectMemoryPath: paths.projectMemoryPath,
    instructionPaths: paths.instructions.map((instruction) => instruction.path),
    documents,
    missingPaths,
    omittedDocuments,
  };
}

export async function buildChiliMemoryPromptFragments(options: ChiliMemoryLoadOptions): Promise<PromptFragment[]> {
  return chiliMemoryPromptFragments(await loadChiliMemoryContext(options));
}

export function chiliMemoryPromptFragments(snapshot: ChiliMemorySnapshot): PromptFragment[] {
  const fragments: PromptFragment[] = [
    {
      id: "chili.memory.mechanics",
      layer: "developer",
      source: "memory",
      priority: 0,
      lifecycle: "session",
      trust: "system",
      content: MEMORY_MECHANICS_PROMPT,
      metadata: { omittedDocuments: snapshot.omittedDocuments ?? [] },
    },
  ];

  snapshot.documents.forEach((document, index) => {
    const source = document.kind === "project_instruction" || document.kind === "project_rule" ? "project" : "memory";
    const trust = document.kind === "user_memory" ? "user" : "project";
    fragments.push({
      id: document.memoryId ? `chili.context.${document.kind}.${document.memoryId}` : `chili.context.${document.kind}.${index}`,
      layer: "contextual_user",
      source,
      priority: 100 + index,
      lifecycle: "session",
      trust,
      content: renderChiliMemoryDocument(document),
      metadata: memoryDocumentDebugMetadata(document),
    });
  });

  return fragments;
}
