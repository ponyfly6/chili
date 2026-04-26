const SEGMENT_PATTERN = /^[a-z0-9_][a-z0-9_-]*$/;

export type AgentPath = `/${string}`;

export const ROOT_AGENT_PATH = "/root" as AgentPath;

export function assertAgentSegment(segment: string): string {
  if (!SEGMENT_PATTERN.test(segment)) {
    throw new Error(`Invalid agent path segment: ${segment}`);
  }
  return segment;
}

export function normalizeAgentPath(path: string): AgentPath {
  if (!path.startsWith("/")) {
    throw new Error(`Agent path must be absolute: ${path}`);
  }

  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return ROOT_AGENT_PATH;

  for (const segment of segments) {
    assertAgentSegment(segment);
  }

  return `/${segments.join("/")}` as AgentPath;
}

export function joinAgentPath(parent: AgentPath, child: string): AgentPath {
  const segment = assertAgentSegment(child);
  const base = normalizeAgentPath(parent);
  return normalizeAgentPath(base === "/" ? `/${segment}` : `${base}/${segment}`);
}

export function parentAgentPath(path: AgentPath): AgentPath | undefined {
  const normalized = normalizeAgentPath(path);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 1) return undefined;
  return normalizeAgentPath(`/${segments.slice(0, -1).join("/")}`);
}
