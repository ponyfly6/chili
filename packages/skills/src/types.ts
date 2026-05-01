export type SkillSource = "user" | "project";

export interface SkillMetadata {
  name: string;
  description: string;
  when_to_use?: string;
  allowedTools?: readonly string[];
  model?: string;
  argumentHint?: string;
  paths?: readonly string[];
  context?: string;
  hidden?: boolean;
  shouldDefer?: boolean;
}

export interface Skill {
  name: string;
  source: SkillSource;
  filePath: string;
  baseDir: string;
  metadata: SkillMetadata;
  body: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  source: SkillSource;
  filePath: string;
  baseDir: string;
  when_to_use?: string;
  hidden?: boolean;
}

export interface SkillDiagnostic {
  level: "warning" | "error";
  code: string;
  message: string;
  source?: SkillSource;
  skillName?: string;
  filePath?: string;
}

export interface DiscoverSkillsOptions {
  cwd: string;
  homeDir?: string;
  includeAgentsAlias?: boolean;
}

export interface SkillRoot {
  source: SkillSource;
  rootDir: string;
  compatibilityAlias: boolean;
}

export interface SkillsLoadResult {
  skills: readonly Skill[];
  diagnostics: readonly SkillDiagnostic[];
  roots: readonly SkillRoot[];
}
