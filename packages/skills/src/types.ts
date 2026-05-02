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
  disabled?: boolean;
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
  includeDisabled?: boolean;
  disabledSkills?: readonly string[];
}

export interface SkillRoot {
  source: SkillSource;
  rootDir: string;
  compatibilityAlias: boolean;
}

export interface SkillsLoadResult {
  skills: readonly Skill[];
  allSkills: readonly Skill[];
  disabledSkillNames: readonly string[];
  diagnostics: readonly SkillDiagnostic[];
  roots: readonly SkillRoot[];
}

export type SkillSettingsScope = "user" | "project";

export interface SkillSettings {
  disabled: readonly string[];
}

export interface SkillSettingsSnapshot {
  disabledSkillNames: readonly string[];
  userPath: string;
  projectPath: string;
}
