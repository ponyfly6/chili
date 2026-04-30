import type { ChatToolDisplayStatus, ChatToolInputSummary } from "@chili/sdk";

export interface ToolActivityDetail {
  label: string;
  lines: string[];
  tone: "muted" | "error";
  truncated: boolean;
}

export interface ToolRenderInput {
  id: string;
  callId: string;
  toolName: string;
  status: string;
  displayStatus: ChatToolDisplayStatus;
  inputSummary: ChatToolInputSummary;
  input?: unknown;
  output?: string;
  error?: string;
  showToolDetails: boolean;
  source: "row" | "fallback";
}

export interface ToolRenderer {
  name: string;
  match(toolName: string): boolean;
  label(input: ToolRenderInput): string;
  details?(input: ToolRenderInput): ToolActivityDetail[];
  outputHint?(input: ToolRenderInput): string | undefined;
  compactErrorLines?(input: ToolRenderInput): string[] | undefined;
}

export interface ToolRenderOutput {
  label: string;
  details: ToolActivityDetail[];
  outputHint?: string;
  compactErrorLines?: string[];
}

export type ExplorationToolKind = "read" | "search" | "list";

export class ToolRendererRegistry {
  constructor(
    private readonly renderers: readonly ToolRenderer[] = defaultToolRenderers,
    private readonly fallbackRenderer: ToolRenderer = fallbackToolRenderer,
  ) {}

  rendererFor(toolName: string): ToolRenderer {
    return this.renderers.find((renderer) => renderer.match(toolName)) ?? this.fallbackRenderer;
  }

  render(input: ToolRenderInput): ToolRenderOutput {
    const renderer = this.rendererFor(input.toolName);
    const details = input.showToolDetails
      ? renderer.details?.(input) ?? defaultToolDetails(input)
      : [];
    const hasDetails = details.length > 0;
    const outputHint = hasDetails
      ? undefined
      : renderer.outputHint?.(input) ?? defaultOutputHint(input);
    const compactErrorLines = hasDetails
      ? undefined
      : renderer.compactErrorLines?.(input) ?? defaultCompactErrorLines(input);

    return {
      label: renderer.label(input),
      details,
      ...(outputHint === undefined ? {} : { outputHint }),
      ...(compactErrorLines === undefined ? {} : { compactErrorLines }),
    };
  }
}

export function renderToolActivity(input: ToolRenderInput, registry = defaultToolRendererRegistry): ToolRenderOutput {
  return registry.render(input);
}

const bashRenderer: ToolRenderer = {
  name: "bash",
  match: (toolName) => matchesTool(toolName, ["bash", "run_shell_command"]),
  label: (input) => labelWithTarget(statusVerb(input.displayStatus, "Ran", "Running"), input.inputSummary.command ?? input.inputSummary.detail ?? input.inputSummary.title),
  details: (input) => defaultToolDetails(input, { maxOutputLines: 5 }),
};

const readRenderer: ToolRenderer = {
  name: "read",
  match: (toolName) => explorationToolKind(toolName) === "read",
  label: (input) => labelWithTarget(statusVerb(input.displayStatus, "Read", "Reading"), displayPath(input.inputSummary.path ?? input.inputSummary.detail ?? input.inputSummary.scope ?? "file")),
};

const searchRenderer: ToolRenderer = {
  name: "search",
  match: (toolName) => explorationToolKind(toolName) === "search",
  label: (input) => {
    const target = input.inputSummary.pattern
      ? `${input.inputSummary.pattern}${input.inputSummary.scope ? ` in ${input.inputSummary.scope}` : ""}`
      : input.inputSummary.detail ?? input.inputSummary.scope ?? "pattern";
    return labelWithTarget(statusVerb(input.displayStatus, "Searched", "Searching"), target);
  },
};

const listRenderer: ToolRenderer = {
  name: "list",
  match: (toolName) => explorationToolKind(toolName) === "list",
  label: (input) => {
    const target = input.inputSummary.pattern
      ? `${input.inputSummary.pattern}${input.inputSummary.path ? ` under ${input.inputSummary.path}` : ""}`
      : input.inputSummary.path ?? input.inputSummary.detail ?? input.inputSummary.scope ?? "paths";
    return labelWithTarget(statusVerb(input.displayStatus, "Listed", "Listing"), target);
  },
};

const editRenderer: ToolRenderer = {
  name: "edit",
  match: (toolName) => matchesTool(toolName, ["edit", "replace"]),
  label: (input) => labelWithTarget(statusVerb(input.displayStatus, "Edited", "Editing"), displayPath(input.inputSummary.path ?? input.inputSummary.detail ?? "file")),
};

const writeRenderer: ToolRenderer = {
  name: "write",
  match: (toolName) => matchesTool(toolName, ["write", "write_file"]),
  label: (input) => labelWithTarget(statusVerb(input.displayStatus, "Wrote", "Writing"), displayPath(input.inputSummary.path ?? input.inputSummary.detail ?? "file")),
};

const applyPatchRenderer: ToolRenderer = {
  name: "apply_patch",
  match: (toolName) => matchesTool(toolName, ["apply_patch"]),
  label: (input) => labelWithTarget(statusVerb(input.displayStatus, "Patched", "Patching"), displayPath(input.inputSummary.path ?? input.inputSummary.detail ?? "files")),
};

const gitRenderer: ToolRenderer = {
  name: "git",
  match: (toolName) => normalizeToolName(toolName).startsWith("git_"),
  label: (input) => {
    const name = normalizeToolName(input.toolName);
    if (name === "git_status") return labelWithTarget(statusVerb(input.displayStatus, "Checked git status", "Checking git status"), pathListTarget(input) ?? input.inputSummary.detail);
    if (name === "git_diff") return labelWithTarget(statusVerb(input.displayStatus, "Read git diff", "Reading git diff"), gitDiffTarget(input));
    if (name === "git_stage") return labelWithTarget(statusVerb(input.displayStatus, "Staged", "Staging"), pathListTarget(input) ?? "changes");
    if (name === "git_commit") return labelWithTarget(statusVerb(input.displayStatus, "Committed", "Committing"), stringFromInput(input.input, "message") ?? input.inputSummary.detail);
    if (name === "git_branch") return labelWithTarget(statusVerb(input.displayStatus, "Updated git branch", "Updating git branch"), stringFromInput(input.input, "name", "action") ?? input.inputSummary.detail);
    return labelWithTarget(statusVerb(input.displayStatus, `Ran ${input.inputSummary.title}`, `Running ${input.inputSummary.title}`), input.inputSummary.detail ?? pathListTarget(input));
  },
};

const taskRenderer: ToolRenderer = {
  name: "task",
  match: (toolName) => {
    const name = normalizeToolName(toolName);
    return name === "task" || name === "agent" || name === "complete_task" || name.startsWith("task_");
  },
  label: (input) => {
    const name = normalizeToolName(input.toolName);
    if (name === "task" || name === "agent") return labelWithTarget(statusVerb(input.displayStatus, "Started task", "Starting task"), stringFromInput(input.input, "description") ?? input.inputSummary.detail);
    if (name === "complete_task") return labelWithTarget(statusVerb(input.displayStatus, "Completed task", "Completing task"), taskIdTarget(input));
    if (name === "task_list") return labelWithTarget(statusVerb(input.displayStatus, "Listed tasks", "Listing tasks"), stringFromInput(input.input, "status") ?? input.inputSummary.detail);
    if (name === "task_wait") return labelWithTarget(statusVerb(input.displayStatus, "Waited for task", "Waiting for task"), taskIdTarget(input));
    if (name === "task_followup") return labelWithTarget(statusVerb(input.displayStatus, "Sent task follow-up", "Sending task follow-up"), taskIdTarget(input));
    if (name === "task_close") return labelWithTarget(statusVerb(input.displayStatus, "Closed task", "Closing task"), taskIdTarget(input));
    return labelWithTarget(statusVerb(input.displayStatus, `Ran ${input.inputSummary.title}`, `Running ${input.inputSummary.title}`), taskIdTarget(input) ?? input.inputSummary.detail);
  },
};

const teamRenderer: ToolRenderer = {
  name: "team",
  match: (toolName) => normalizeToolName(toolName).startsWith("team_"),
  label: (input) => {
    const name = normalizeToolName(input.toolName);
    const target = teamTarget(input);
    if (name === "team_create") return labelWithTarget(statusVerb(input.displayStatus, "Created team", "Creating team"), stringFromInput(input.input, "name") ?? target);
    if (name === "team_list") return statusVerb(input.displayStatus, "Listed teams", "Listing teams");
    if (name === "team_snapshot") return labelWithTarget(statusVerb(input.displayStatus, "Read team snapshot", "Reading team snapshot"), target);
    if (name.startsWith("team_task_")) return labelWithTarget(statusVerb(input.displayStatus, teamTaskPastVerb(name), teamTaskActiveVerb(name)), stringFromInput(input.input, "title") ?? target);
    if (name.startsWith("team_message_")) return labelWithTarget(statusVerb(input.displayStatus, teamMessagePastVerb(name), teamMessageActiveVerb(name)), target);
    if (name.startsWith("team_member_")) return labelWithTarget(statusVerb(input.displayStatus, "Updated team member", "Updating team member"), stringFromInput(input.input, "path", "name") ?? target);
    return labelWithTarget(statusVerb(input.displayStatus, `Ran ${input.inputSummary.title}`, `Running ${input.inputSummary.title}`), target ?? input.inputSummary.detail);
  },
};

const fallbackToolRenderer: ToolRenderer = {
  name: "fallback",
  match: () => true,
  label: (input) => {
    const detail = input.inputSummary.command
      ?? input.inputSummary.detail
      ?? input.inputSummary.path
      ?? input.inputSummary.pattern
      ?? input.inputSummary.scope;
    return labelWithTarget(statusVerb(input.displayStatus, `Ran ${input.inputSummary.title}`, `Running ${input.inputSummary.title}`), detail);
  },
};

const defaultToolRenderers: readonly ToolRenderer[] = [
  bashRenderer,
  readRenderer,
  searchRenderer,
  listRenderer,
  editRenderer,
  writeRenderer,
  applyPatchRenderer,
  gitRenderer,
  taskRenderer,
  teamRenderer,
];

export const defaultToolRendererRegistry = new ToolRendererRegistry();

export function inputSummaryFromUnknown(toolName: string, input: unknown): ChatToolInputSummary {
  const title = toolName || "tool";
  const record = recordValue(input);
  const path = record ? firstString(record, ["filePath", "file_path", "path"]) : undefined;
  const pattern = record ? firstString(record, ["pattern", "query"]) : undefined;
  const command = record ? firstString(record, ["command", "cmd"]) : undefined;
  const paths = record ? firstStringArray(record, ["paths", "filePaths", "file_paths"]) : undefined;
  const scope = paths?.length ? paths.join(", ") : path;
  const detail = command ?? (pattern && scope ? `${pattern} in ${scope}` : undefined) ?? scope ?? previewUnknown(input, 120);
  return {
    title,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(scope ? { scope } : {}),
    ...(pattern ? { pattern } : {}),
  };
}

export function explorationToolKind(toolName: string): ExplorationToolKind | undefined {
  const name = normalizeToolName(toolName);
  if (name === "read" || name === "read_file") return "read";
  if (name === "grep" || name === "grep_search" || name === "search" || name === "rg") return "search";
  if (name === "glob" || name === "file_glob" || name === "list" || name === "list_files" || name === "ls") return "list";
  return undefined;
}

export function isExplorationTool(toolName: string): boolean {
  return explorationToolKind(toolName) !== undefined;
}

export function normalizeToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/^tool\./, "");
}

function defaultToolDetails(input: ToolRenderInput, options: { maxOutputLines?: number } = {}): ToolActivityDetail[] {
  const details: ToolActivityDetail[] = [];
  if (input.input !== undefined) {
    const preview = previewTextLines(formatInput(input.input), { maxLines: 8, maxLineLength: 180 });
    details.push({ label: "input", tone: "muted", lines: preview.lines, truncated: preview.truncated });
  }
  if (input.error) {
    const preview = previewTextLines(input.error, { maxLines: 5, maxLineLength: 180 });
    details.push({ label: "error", tone: "error", lines: preview.lines, truncated: preview.truncated });
  }
  if (input.output) {
    const preview = previewTextLines(input.output, {
      maxLines: options.maxOutputLines ?? 8,
      maxLineLength: 180,
    });
    details.push({ label: "output", tone: "muted", lines: preview.lines, truncated: preview.truncated });
  }
  return details;
}

function defaultOutputHint(input: ToolRenderInput): string | undefined {
  if (input.error || !input.output || !isLargeOutput(input.output)) return undefined;
  const lines = Math.max(1, input.output.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length);
  return `output hidden (${lines} ${plural(lines, "line", "lines")}, details available)`;
}

function defaultCompactErrorLines(input: ToolRenderInput): string[] | undefined {
  const value = input.error ?? (input.displayStatus === "failed" ? input.output : undefined);
  if (!value) return undefined;
  return previewTextLines(value, { maxLines: 4, maxLineLength: 180 }).lines;
}

function previewTextLines(value: string, options: { maxLines: number; maxLineLength: number }): { lines: string[]; truncated: boolean } {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  const sourceLines = normalized.length > 0 ? normalized.split("\n") : [""];
  const lines = sourceLines.slice(0, options.maxLines).map((line) => shortenLine(line, options.maxLineLength));
  const truncated = sourceLines.length > options.maxLines || lines.some((line, index) => line !== sourceLines[index]);
  return { lines, truncated };
}

function isLargeOutput(value: string): boolean {
  return value.length > 180 || value.includes("\n") || /^diff --git/m.test(value);
}

function statusVerb(status: ChatToolDisplayStatus, succeeded: string, active: string): string {
  if (status === "succeeded") return succeeded;
  if (status === "running") return active;
  if (status === "queued") return "Queued";
  if (status === "checking") return "Checking";
  if (status === "waiting_permission") return "Waiting approval for";
  if (status === "failed") return "Failed";
  if (status === "rejected") return "Rejected";
  return "Cancelled";
}

function labelWithTarget(verb: string, target: string | undefined): string {
  const trimmed = target?.replace(/\s+/g, " ").trim();
  return trimmed ? `${verb} ${trimmed}` : verb;
}

function gitDiffTarget(input: ToolRenderInput): string | undefined {
  const parts: string[] = [];
  if (booleanFromInput(input.input, "staged")) parts.push("staged");
  if (booleanFromInput(input.input, "stat")) parts.push("stat");
  const base = stringFromInput(input.input, "base");
  if (base) parts.push(base);
  const paths = pathListTarget(input);
  if (paths) parts.push(paths);
  return parts.length > 0 ? parts.join(" ") : input.inputSummary.detail;
}

function pathListTarget(input: ToolRenderInput): string | undefined {
  const paths = stringArrayFromInput(input.input, "paths", "filePaths", "file_paths");
  if (paths?.length) return paths.join(", ");
  if (booleanFromInput(input.input, "all")) return "all changes";
  return input.inputSummary.scope ?? input.inputSummary.path;
}

function taskIdTarget(input: ToolRenderInput): string | undefined {
  return stringFromInput(input.input, "taskId", "task_id") ?? input.inputSummary.detail ?? input.inputSummary.scope;
}

function teamTarget(input: ToolRenderInput): string | undefined {
  return stringFromInput(input.input, "taskId", "task_id", "teamId", "team_id", "messageId", "message_id")
    ?? input.inputSummary.detail
    ?? input.inputSummary.scope;
}

function teamTaskPastVerb(toolName: string): string {
  if (toolName.endsWith("_create")) return "Created team task";
  if (toolName.endsWith("_list")) return "Listed team tasks";
  if (toolName.endsWith("_assign")) return "Assigned team task";
  if (toolName.endsWith("_claim")) return "Claimed team task";
  if (toolName.endsWith("_update")) return "Updated team task";
  if (toolName.endsWith("_dispatch")) return "Dispatched team task";
  if (toolName.endsWith("_sync")) return "Synced team task";
  if (toolName.endsWith("_reconcile")) return "Reconciled team tasks";
  return "Updated team task";
}

function teamTaskActiveVerb(toolName: string): string {
  return teamTaskPastVerb(toolName).replace(/ed\b/, "ing");
}

function teamMessagePastVerb(toolName: string): string {
  if (toolName.endsWith("_send")) return "Sent team message";
  if (toolName.endsWith("_list")) return "Listed team messages";
  return "Handled team message";
}

function teamMessageActiveVerb(toolName: string): string {
  if (toolName.endsWith("_send")) return "Sending team message";
  if (toolName.endsWith("_list")) return "Listing team messages";
  return "Handling team message";
}

function matchesTool(toolName: string, names: readonly string[]): boolean {
  const normalized = normalizeToolName(toolName);
  return names.includes(normalized);
}

function displayPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function previewUnknown(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return shortenLine(formatInput(value).replace(/\s+/g, " ").trim(), maxLength);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function stringFromInput(input: unknown, ...keys: string[]): string | undefined {
  const record = recordValue(input);
  return record ? firstString(record, keys) : undefined;
}

function booleanFromInput(input: unknown, key: string): boolean {
  const record = recordValue(input);
  return record?.[key] === true;
}

function firstStringArray(record: Record<string, unknown>, keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
    if (items.length > 0) return items;
  }
  return undefined;
}

function stringArrayFromInput(input: unknown, ...keys: string[]): string[] | undefined {
  const record = recordValue(input);
  return record ? firstStringArray(record, keys) : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function shortenLine(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}~`;
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}
