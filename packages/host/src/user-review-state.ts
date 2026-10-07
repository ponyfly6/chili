import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseRuntimeReviewInstructions, type ModelSelection } from "@chili/protocol";
import { defaultChiliHome } from "@chili/providers";

export interface UserReviewSettings {
  profile: "full-access" | "auto-review";
  reviewInstructions: string;
  reviewerModel?: ModelSelection;
}

export interface UserReviewSettingsOptions {
  chiliHome?: string;
}

export function userReviewSettingsPath(chiliHome = defaultChiliHome()): string {
  return join(chiliHome, "review-settings.json");
}

export async function readUserReviewSettings(
  options: UserReviewSettingsOptions = {},
): Promise<UserReviewSettings | undefined> {
  const path = userReviewSettingsPath(options.chiliHome);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    return parseReviewSettings(JSON.parse(text), path);
  } catch (error) {
    throw new Error(`Invalid review settings in ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function writeUserReviewSettings(
  settings: UserReviewSettings,
  options: UserReviewSettingsOptions = {},
): Promise<void> {
  const path = userReviewSettingsPath(options.chiliHome);
  const normalized = parseReviewSettings(settings, "review settings");
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseReviewSettings(value: unknown, label: string): UserReviewSettings {
  const settings = record(value, label);
  assertFields(settings, ["profile", "reviewInstructions", "reviewerModel"], label);
  if (settings.profile !== "full-access" && settings.profile !== "auto-review") {
    throw new Error(`${label}.profile must be full-access or auto-review`);
  }
  const result: UserReviewSettings = {
    profile: settings.profile,
    reviewInstructions: parseRuntimeReviewInstructions(settings.reviewInstructions, `${label}.reviewInstructions`),
  };
  if (settings.reviewerModel !== undefined) {
    const model = record(settings.reviewerModel, `${label}.reviewerModel`);
    assertFields(model, ["provider", "model"], `${label}.reviewerModel`);
    for (const field of ["provider", "model"] as const) {
      if (typeof model[field] !== "string" || model[field].trim().length === 0) {
        throw new Error(`${label}.reviewerModel.${field} must be a non-empty string`);
      }
    }
    result.reviewerModel = {
      provider: (model.provider as string).trim(),
      model: (model.model as string).trim(),
    };
  }
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) throw new Error(`${label}.${field} is not a supported setting`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
