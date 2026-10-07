export type ChiliMemoryScope = "user" | "project";
export type ChiliMemoryListScope = ChiliMemoryScope | "all";
export type ChiliMemoryDocumentKind = "user_memory" | "project_memory" | "project_instruction" | "project_rule";
export type ChiliMemoryDocumentScope = "user" | "project";

export interface ChiliProjectRuleMetadata {
  paths?: string[];
  alwaysApply: boolean;
  description?: string;
  priority?: number;
}

export interface ChiliMemoryLoadOptions {
  cwd: string;
  /** Trusted executor hook; never accepted from model tool arguments. */
  assertCurrentAuthorization?: () => Promise<void>;
  homeDir?: string;
  /** Profile directory, e.g. ~/.chili. Takes precedence over homeDir. */
  chiliHome?: string;
  projectRoot?: string;
  projectId?: string;
  maxDocumentChars?: number;
  query?: string;
  targetPaths?: readonly string[];
  maxMemoryEntries?: number;
  /** Prompt selection filter supplied by the Host after checking memory.read policy. */
  memoryScopes?: readonly ChiliMemoryScope[];
}

export interface ChiliMemoryDocument {
  kind: ChiliMemoryDocumentKind;
  scope: ChiliMemoryDocumentScope;
  label: string;
  path: string;
  /** Model preview. Source content is retained separately before display limits. */
  content: string;
  /** Exact loaded file text or persisted Memory entry, for source provenance. */
  sourceContent?: string;
  truncated: boolean;
  truncatedAfter?: number;
  ruleMetadata?: ChiliProjectRuleMetadata;
  contentVersion?: string;
  memoryId?: string;
  memoryRevision?: number;
  memorySource?: string;
}

export interface ChiliMemorySnapshot {
  cwd: string;
  projectRoot: string;
  userMemoryPath: string;
  projectMemoryPath: string;
  instructionPaths: string[];
  documents: ChiliMemoryDocument[];
  missingPaths: string[];
  omittedDocuments?: { path: string; reason: string }[];
}

export interface ChiliMemoryEntry {
  id: string;
  revision: number;
  source: string;
  updatedAt: number;
  scope: ChiliMemoryScope;
  path: string;
  index: number;
  text: string;
}

export interface ChiliMemoryAddInput extends ChiliMemoryLoadOptions {
  text: string;
  scope?: ChiliMemoryScope;
  maxEntryChars?: number;
  source?: string;
}

export interface ChiliMemoryAddResult {
  id: string;
  revision: number;
  scope: ChiliMemoryScope;
  path: string;
  text: string;
  created: boolean;
}

export interface ChiliMemoryListInput extends ChiliMemoryLoadOptions {
  scope?: ChiliMemoryListScope;
}

export interface ChiliMemoryRemoveInput extends ChiliMemoryLoadOptions {
  scope?: ChiliMemoryScope;
  index?: number;
  id?: string;
  expectedRevision?: number;
}

export interface ChiliMemoryRemoveResult {
  id: string;
  revision: number;
  scope: ChiliMemoryScope;
  path: string;
  index: number;
  text: string;
}

export type ChiliMemoryToolInput =
  | { operation: "add"; text: string; scope: ChiliMemoryScope }
  | { operation: "put"; text: string; scope: ChiliMemoryScope; id: string; expectedRevision: number }
  | { operation: "list" | "search"; scope: ChiliMemoryListScope; query?: string }
  | { operation: "get"; scope: ChiliMemoryScope; id: string }
  | { operation: "remove"; scope: ChiliMemoryScope; id: string; expectedRevision: number }
  | { operation: "export"; scope: ChiliMemoryScope };

export interface ChiliMemoryToolOptions {
  /** Trusted Host resolver; evaluated once per prepared call for its execution cwd. */
  optionsForCwd?: (cwd: string) => Promise<ChiliMemoryToolOptions>;
  homeDir?: string;
  chiliHome?: string;
  projectRoot?: string;
  projectId?: string;
}

export interface ChiliMemoryPaths {
  chiliHome: string;
  databasePath: string;
  projectId: string;
  projectRoot: string;
  userMemoryPath: string;
  projectMemoryPath: string;
  instructions: ChiliMemoryDocumentSource[];
}

export interface ChiliMemoryDocumentSource {
  kind: Extract<ChiliMemoryDocumentKind, "project_instruction" | "project_rule">;
  scope: "project";
  label: string;
  path: string;
  ruleMetadata?: ChiliProjectRuleMetadata;
}
