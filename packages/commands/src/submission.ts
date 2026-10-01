import { parseRuntimeString, type RuntimeCommandInvocation } from "@chili/protocol";
import type { PromptCommandControl, PromptCommandRunResult } from "./control.js";

export interface PromptCommandSubmission {
  text: string;
  displayText: string;
  toolPolicy?: {
    allowedTools?: string[];
    writeScope?: string[];
    executeScope?: string[];
  };
}

/**
 * Expand commands identically for every application entry point. Callers must
 * validate the session, workspace and submission options before invoking this:
 * an MCP command can contact its server while rendering the prompt.
 */
export async function preparePromptCommandSubmission(
  control: Pick<PromptCommandControl, "run">,
  invocation: RuntimeCommandInvocation,
): Promise<PromptCommandSubmission> {
  const command = await control.run(invocation);
  const args = invocation.args?.trim();
  // Validate the expanded content before any entry point can persist it.
  const text = parseRuntimeString(command.prompt, "command.prompt", { allowEmpty: true });
  const displayText = parseRuntimeString(
    args ? `${command.command.path} ${args}` : command.command.path,
    "command.displayText",
    { allowEmpty: true },
  );
  const toolPolicy = commandToolPolicy(command.metadata);
  return {
    text,
    displayText,
    ...(toolPolicy ? { toolPolicy } : {}),
  };
}

function commandToolPolicy(
  metadata: PromptCommandRunResult["metadata"],
): PromptCommandSubmission["toolPolicy"] {
  const allowedTools = metadataStringArray(metadata.allowedTools);
  const writeScope = metadataStringArray(metadata.writeScope);
  const executeScope = metadataStringArray(metadata.executeScope);
  if (!allowedTools && !writeScope && !executeScope) return undefined;
  return {
    ...(allowedTools ? { allowedTools } : {}),
    ...(writeScope ? { writeScope } : {}),
    ...(executeScope ? { executeScope } : {}),
  };
}

function metadataStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  return strings.length > 0 ? strings : undefined;
}
