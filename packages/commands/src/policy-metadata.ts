import { parseRuntimeStringArray } from "@chili/protocol";

export interface CommandToolPolicy {
  allowedTools?: string[];
  writeScope?: string[];
  executeScope?: string[];
}

/** A missing restriction and an explicitly empty capability set are different. */
export function commandToolPolicy(
  metadata: Readonly<Record<string, unknown>>,
): CommandToolPolicy | undefined {
  const policy: CommandToolPolicy = {};
  for (const field of ["allowedTools", "writeScope", "executeScope"] as const) {
    if (metadata[field] === undefined) continue;
    policy[field] = parseRuntimeStringArray(metadata[field], `command.metadata.${field}`)
      .map((value) => value.trim()).filter(Boolean);
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}
