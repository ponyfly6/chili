import { resolve } from "node:path";
import type { PromptFragment } from "../prompt/index.js";
import { DEFAULT_MAX_DOCUMENT_CHARS, MEMORY_MECHANICS_PROMPT } from "./constants.js";
import { loadDocument, memoryDocumentDebugMetadata, renderChiliMemoryDocument } from "./documents.js";
import { resolveChiliMemoryPaths } from "./project-instructions.js";
import type { ChiliMemoryDocument, ChiliMemoryLoadOptions, ChiliMemorySnapshot } from "./types.js";

export async function loadChiliMemoryContext(options: ChiliMemoryLoadOptions): Promise<ChiliMemorySnapshot> {
  const paths = await resolveChiliMemoryPaths(options);
  const documents: ChiliMemoryDocument[] = [];
  const missingPaths: string[] = [];
  const maxChars = options.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS;

  await loadDocument(documents, missingPaths, {
    kind: "user_memory",
    scope: "user",
    label: "User memory",
    path: paths.userMemoryPath,
    maxChars,
  });
  await loadDocument(documents, missingPaths, {
    kind: "project_memory",
    scope: "project",
    label: "Project memory",
    path: paths.projectMemoryPath,
    maxChars,
  });
  for (const instruction of paths.instructions) {
    await loadDocument(documents, missingPaths, {
      kind: instruction.kind,
      scope: instruction.scope,
      label: instruction.label,
      path: instruction.path,
      maxChars,
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
    },
  ];

  snapshot.documents.forEach((document, index) => {
    const source = document.kind === "project_instruction" || document.kind === "project_rule" ? "project" : "memory";
    const trust = document.kind === "user_memory" ? "user" : "project";
    fragments.push({
      id: `chili.context.${document.kind}.${index}`,
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
