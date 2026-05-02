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
  homeDir?: string;
  projectRoot?: string;
  maxDocumentChars?: number;
}

export interface ChiliMemoryDocument {
  kind: ChiliMemoryDocumentKind;
  scope: ChiliMemoryDocumentScope;
  label: string;
  path: string;
  content: string;
  truncated: boolean;
  truncatedAfter?: number;
  ruleMetadata?: ChiliProjectRuleMetadata;
}

export interface ChiliMemorySnapshot {
  cwd: string;
  projectRoot: string;
  userMemoryPath: string;
  projectMemoryPath: string;
  instructionPaths: string[];
  documents: ChiliMemoryDocument[];
  missingPaths: string[];
}

export interface ChiliMemoryEntry {
  scope: ChiliMemoryScope;
  path: string;
  index: number;
  text: string;
}

export interface ChiliMemoryAddInput extends ChiliMemoryLoadOptions {
  text: string;
  scope?: ChiliMemoryScope;
  maxEntryChars?: number;
}

export interface ChiliMemoryAddResult {
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
  index: number;
}

export interface ChiliMemoryRemoveResult {
  scope: ChiliMemoryScope;
  path: string;
  index: number;
  text: string;
}

export type ChiliMemoryToolInput =
  | {
      operation: "add";
      text: string;
      scope: ChiliMemoryScope;
    }
  | {
      operation: "list";
      scope: ChiliMemoryListScope;
    }
  | {
      operation: "remove";
      scope: ChiliMemoryScope;
      index: number;
    };

export interface ChiliMemoryToolOptions {
  homeDir?: string;
  projectRoot?: string;
}

export interface ChiliMemoryPaths {
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
