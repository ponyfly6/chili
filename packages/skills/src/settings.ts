import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SkillSettings, SkillSettingsScope, SkillSettingsSnapshot } from "./types.js";

const SKILL_SETTINGS_FILENAME = "skills.json";

export interface SkillSettingsOptions {
  cwd: string;
  homeDir?: string;
}

export interface UpdateSkillDisabledOptions extends SkillSettingsOptions {
  scope: SkillSettingsScope;
  name: string;
  disabled: boolean;
}

export async function loadSkillSettings(options: SkillSettingsOptions): Promise<SkillSettingsSnapshot> {
  const paths = resolveSkillSettingsPaths(options);
  const user = await readSkillSettings(paths.userPath);
  const project = await readSkillSettings(paths.projectPath);
  return {
    disabledSkillNames: uniqueSorted([...user.disabled, ...project.disabled]),
    userPath: paths.userPath,
    projectPath: paths.projectPath,
  };
}

export async function updateSkillDisabledSetting(options: UpdateSkillDisabledOptions): Promise<SkillSettingsSnapshot> {
  const name = normalizeSkillName(options.name);
  if (!name) throw new Error("skill name must be non-empty");
  const paths = resolveSkillSettingsPaths(options);
  const settingsPath = options.scope === "user" ? paths.userPath : paths.projectPath;
  const settings = await readSkillSettings(settingsPath);
  const disabled = new Set(settings.disabled);
  if (options.disabled) disabled.add(name);
  else disabled.delete(name);
  await writeSkillSettings(settingsPath, { disabled: uniqueSorted([...disabled]) });
  return loadSkillSettings(options);
}

export function isSkillDisabled(name: string, disabledSkillNames: readonly string[]): boolean {
  return disabledSkillNames.includes(name);
}

function resolveSkillSettingsPaths(options: SkillSettingsOptions): { userPath: string; projectPath: string } {
  const cwd = path.resolve(options.cwd);
  const home = path.resolve(options.homeDir ?? homedir());
  return {
    userPath: path.join(home, ".chili", SKILL_SETTINGS_FILENAME),
    projectPath: path.join(cwd, ".chili", SKILL_SETTINGS_FILENAME),
  };
}

async function readSkillSettings(settingsPath: string): Promise<SkillSettings> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch {
    return { disabled: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { disabled: [] };
    const disabled = readStringArray(parsed.disabled) ?? readStringArray(parsed.disabledSkills) ?? [];
    return { disabled: uniqueSorted(disabled.map(normalizeSkillName).filter(Boolean)) };
  } catch {
    return { disabled: [] };
  }
}

async function writeSkillSettings(settingsPath: string, settings: SkillSettings): Promise<void> {
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const tmpPath = `${settingsPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify({ disabled: settings.disabled }, null, 2)}\n`, "utf8");
  await rename(tmpPath, settingsPath);
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeSkillName(name: string): string {
  return name.trim();
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
