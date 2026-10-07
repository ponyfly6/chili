export type ChiliMemoryScope = "user" | "project";
export type ChiliMemoryListScope = ChiliMemoryScope | "all";

export interface ChiliMemoryOptions {
  cwd: string;
  homeDir?: string;
  /** Profile directory. Takes precedence over homeDir. */
  chiliHome?: string;
  projectRoot?: string;
  projectId?: string;
}

export interface ChiliMemoryDirectories {
  root: string;
  personal: string;
  project: string;
  projectId: string;
}

export interface ChiliMemoryEntry {
  scope: ChiliMemoryScope;
  path: string;
  text: string;
}

export interface ChiliMemoryAddInput extends ChiliMemoryOptions {
  text: string;
  scope?: ChiliMemoryScope;
  maxEntryChars?: number;
}

export type ChiliMemoryAddResult = ChiliMemoryEntry;

export interface ChiliMemoryListInput extends ChiliMemoryOptions {
  scope?: ChiliMemoryListScope;
}
