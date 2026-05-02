import { loadSkills } from "./loader.js";
import type { DiscoverSkillsOptions, Skill, SkillDiagnostic, SkillSummary } from "./types.js";

export class SkillRegistry {
  private readonly byName: Map<string, Skill>;
  private readonly byPath: Map<string, Skill>;
  private readonly allSkills: readonly Skill[];

  constructor(
    skills: readonly Skill[],
    private readonly loadDiagnostics: readonly SkillDiagnostic[] = [],
    allSkills: readonly Skill[] = skills,
  ) {
    this.byName = new Map(skills.map((skill) => [skill.name, skill]));
    this.allSkills = [...allSkills];
    this.byPath = new Map(this.allSkills.map((skill) => [skill.filePath, skill]));
  }

  list(): SkillSummary[] {
    return [...this.byName.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => {
        const summary: SkillSummary = {
          name: skill.name,
          description: skill.metadata.description,
          source: skill.source,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
        };
        if (skill.metadata.when_to_use !== undefined) summary.when_to_use = skill.metadata.when_to_use;
        if (skill.metadata.hidden !== undefined) summary.hidden = skill.metadata.hidden;
        return summary;
      });
  }

  get(name: string): Skill | undefined {
    return this.byName.get(name);
  }

  getByPath(filePath: string): Skill | undefined {
    return this.byPath.get(filePath);
  }

  findByName(name: string): Skill[] {
    return this.allSkills
      .filter((skill) => skill.name === name)
      .sort(compareSkills);
  }

  listAll(): SkillSummary[] {
    return this.allSkills
      .slice()
      .sort(compareSkills)
      .map((skill) => skillSummary(skill));
  }

  diagnostics(): SkillDiagnostic[] {
    return [...this.loadDiagnostics];
  }
}

export async function discoverSkills(options: DiscoverSkillsOptions): Promise<SkillRegistry> {
  const result = await loadSkills(options);
  return new SkillRegistry(result.skills, result.diagnostics, result.allSkills);
}

function skillSummary(skill: Skill): SkillSummary {
  const summary: SkillSummary = {
    name: skill.name,
    description: skill.metadata.description,
    source: skill.source,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
  };
  if (skill.metadata.when_to_use !== undefined) summary.when_to_use = skill.metadata.when_to_use;
  if (skill.metadata.hidden !== undefined) summary.hidden = skill.metadata.hidden;
  return summary;
}

function compareSkills(left: Skill, right: Skill): number {
  return left.name.localeCompare(right.name)
    || left.source.localeCompare(right.source)
    || left.filePath.localeCompare(right.filePath);
}
