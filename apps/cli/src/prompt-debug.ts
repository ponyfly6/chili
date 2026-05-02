import type { PromptDebugManifest, RenderedPromptFragment } from "@chili/core";
import type { SessionId, ThreadId } from "@chili/protocol";

export interface CliPromptDebugOutput {
  sessionId: SessionId;
  threadId: ThreadId;
  cwd: string;
  created: boolean;
  debug: PromptDebugManifest;
  fragments?: readonly RenderedPromptFragment[];
}

const PROMPT_DEBUG_METADATA_KEYS = [
  "path",
  "kind",
  "scope",
  "truncated",
  "truncatedAfter",
  "ruleType",
] as const;

export function formatPromptDebugText(output: CliPromptDebugOutput): string {
  const lines = [
    `[prompt-debug] totalChars=${output.debug.totalChars}`,
    `sessionId=${output.sessionId}`,
    `threadId=${output.threadId}`,
    `cwd=${output.cwd}`,
    `created=${output.created}`,
    "[fragments]",
  ];

  for (const fragment of output.debug.fragments) {
    lines.push(
      [
        `id=${fragment.id}`,
        `layer=${fragment.layer}`,
        `source=${fragment.source}`,
        `trust=${fragment.trust}`,
        `lifecycle=${fragment.lifecycle}`,
        `priority=${fragment.priority}`,
        `chars=${fragment.chars}`,
      ].join("\t"),
    );
    const metadata = formatPromptDebugMetadata(fragment.metadata);
    if (metadata) lines.push(`  metadata: ${metadata}`);
  }

  if (output.fragments && output.fragments.length > 0) {
    lines.push("[content]");
    const contentById = new Map(output.fragments.map((fragment) => [fragment.id, fragment.content]));
    for (const fragment of output.debug.fragments) {
      lines.push(`--- fragment ${fragment.id} begin ---`);
      lines.push(contentById.get(fragment.id) ?? "");
      lines.push(`--- fragment ${fragment.id} end ---`);
    }
  }

  return lines.join("\n");
}

export function formatPromptDebugJson(output: CliPromptDebugOutput): string {
  return JSON.stringify(output, null, 2);
}

function formatPromptDebugMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return "";
  const keys = [
    ...PROMPT_DEBUG_METADATA_KEYS.filter((key) => metadata[key] !== undefined),
    ...Object.keys(metadata)
      .filter((key) => !PROMPT_DEBUG_METADATA_KEYS.includes(key as (typeof PROMPT_DEBUG_METADATA_KEYS)[number]))
      .filter((key) => isSimpleMetadataValue(metadata[key]))
      .sort(),
  ];
  return keys.map((key) => `${key}=${formatMetadataValue(metadata[key])}`).join(" ");
}

function isSimpleMetadataValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  return Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
}

function formatMetadataValue(value: unknown): string {
  if (typeof value === "string" && /^[^\s]+$/.test(value)) return value;
  return JSON.stringify(value);
}
