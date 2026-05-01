import { loadSkills } from "./loader.js";
import type { DiscoverSkillsOptions, Skill, SkillDiagnostic, SkillSummary } from "./types.js";

export class SkillRegistry {
  private readonly byName: Map<string, Skill>;

  constructor(
    skills: readonly Skill[],
    private readonly loadDiagnostics: readonly SkillDiagnostic[] = [],
  ) {
    this.byName = new Map(skills.map((skill) => [skill.name, skill]));
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

  diagnostics(): SkillDiagnostic[] {
    return [...this.loadDiagnostics];
  }
}

export async function discoverSkills(options: DiscoverSkillsOptions): Promise<SkillRegistry> {
  const result = await loadSkills(options);
  return new SkillRegistry(result.skills, result.diagnostics);
}
