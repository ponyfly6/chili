import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelSelection } from "@chili/protocol";
import { defaultChiliHome } from "@chili/providers";

export interface UserModelStateOptions {
  chiliHome?: string;
  now?: () => number;
}

interface UserModelStateFile {
  modelSelection?: ModelSelection;
  updatedAt?: number;
}

const USER_MODEL_STATE_FILE = "last-model.json";

export function userModelStatePath(chiliHome = defaultChiliHome()): string {
  return join(chiliHome, USER_MODEL_STATE_FILE);
}

export async function readUserModelSelection(options: UserModelStateOptions = {}): Promise<ModelSelection | undefined> {
  let text: string;
  try {
    text = await readFile(userModelStatePath(options.chiliHome), "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }

  if (!text.trim()) return undefined;
  try {
    return modelSelectionFromValue(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export async function writeUserModelSelection(
  selection: ModelSelection,
  options: UserModelStateOptions = {},
): Promise<void> {
  const modelSelection = normalizeModelSelection(selection);
  const path = userModelStatePath(options.chiliHome);
  const data: UserModelStateFile = {
    modelSelection,
    updatedAt: options.now?.() ?? Date.now(),
  };
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function modelSelectionFromValue(value: unknown): ModelSelection | undefined {
  if (isModelSelection(value)) return normalizeModelSelection(value);
  if (!isRecord(value)) return undefined;
  const selection = value.modelSelection;
  return isModelSelection(selection) ? normalizeModelSelection(selection) : undefined;
}

function normalizeModelSelection(selection: ModelSelection): ModelSelection {
  const provider = selection.provider.trim();
  const model = selection.model.trim();
  if (!provider || !model) throw new Error("modelSelection requires non-empty provider and model");
  return { provider, model };
}

function isModelSelection(value: unknown): value is ModelSelection {
  return isRecord(value)
    && typeof value.provider === "string"
    && typeof value.model === "string"
    && value.provider.trim().length > 0
    && value.model.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
