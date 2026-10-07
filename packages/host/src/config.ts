import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { defaultChiliHome } from "@chili/providers";

export interface HostConfig {
  agents?: HostAgentConfig;
}

export interface HostAgentConfig {
  maxChildren: number;
  maxDepth: number;
  maxConcurrent: number;
}

export const DEFAULT_HOST_AGENT_CONFIG: Readonly<HostAgentConfig> = Object.freeze({
  maxChildren: 64,
  maxDepth: 1,
  maxConcurrent: 3,
});

export interface LoadHostConfigOptions {
  chiliHome?: string;
}

const AGENT_CONFIG_FIELDS = {
  max_children: { property: "maxChildren", min: 0, max: 64 },
  max_depth: { property: "maxDepth", min: 0, max: 16 },
  max_concurrent: { property: "maxConcurrent", min: 1, max: 32 },
} as const;

export async function loadHostConfig(
  cwd: string,
  options: LoadHostConfigOptions = {},
): Promise<HostConfig & { agents: HostAgentConfig }> {
  const chiliHome = options.chiliHome ?? defaultChiliHome();
  const userLayer = await loadConfigLayer(userConfigPath(chiliHome), "user config.toml");
  const projectConfig = await findProjectConfigPath(cwd, userConfigPath(chiliHome));
  const projectLayer = projectConfig
    ? await loadConfigLayer(projectConfig, "project .chili/config.toml")
    : undefined;

  return {
    agents: { ...DEFAULT_HOST_AGENT_CONFIG, ...userLayer.agents, ...projectLayer?.agents },
  };
}

async function loadConfigLayer(path: string, source: string): Promise<{ agents: Partial<HostAgentConfig> }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { agents: {} };
    throw error;
  }

  // Permission rules and review policies are not read from repository configuration.
  return { agents: agentConfigFromConfig(Bun.TOML.parse(text), source) };
}

function agentConfigFromConfig(config: unknown, source: string): Partial<HostAgentConfig> {
  const root = record(config, source);
  if (!("agents" in root)) return {};
  const agents = record(root.agents, `${source} [agents]`);
  const result: Partial<HostAgentConfig> = {};
  for (const [key, value] of Object.entries(agents)) {
    if (!Object.hasOwn(AGENT_CONFIG_FIELDS, key)) {
      throw new Error(`${source} agents.${key} is not a supported setting`);
    }
    const field = AGENT_CONFIG_FIELDS[key as keyof typeof AGENT_CONFIG_FIELDS];
    if (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max) {
      throw new Error(`${source} agents.${key} must be an integer between ${field.min} and ${field.max}`);
    }
    result[field.property] = value;
  }
  return result;
}

function userConfigPath(chiliHome: string): string {
  return join(chiliHome, "config.toml");
}

async function findProjectConfigPath(cwd: string, userConfig: string): Promise<string | undefined> {
  let current = resolve(cwd);
  const ignoredConfig = resolve(userConfig);
  while (true) {
    const candidate = join(current, ".chili", "config.toml");
    if (resolve(candidate) !== ignoredConfig) {
      try {
        await access(candidate);
        return candidate;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${label} must be a TOML table`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
