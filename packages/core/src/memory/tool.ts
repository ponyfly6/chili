import { resolve } from "node:path";
import type { ChiliToolDefinition, ValidationResult } from "@chili/tools";
import {
  addChiliMemoryEntry, exportChiliMemory, formatMemoryEntries, getChiliMemoryEntry,
  listChiliMemoryEntries, putChiliMemoryEntry, removeChiliMemoryEntry, searchChiliMemoryEntries,
} from "./entries.js";
import type { ChiliMemoryListScope, ChiliMemoryScope, ChiliMemoryToolInput, ChiliMemoryToolOptions } from "./types.js";
import { resolveChiliMemoryPaths } from "./project-instructions.js";
import { isRecord } from "./utils.js";

interface PreparedMemoryBinding {
  cwd: string;
  chiliHome: string;
  projectRoot: string;
  projectId: string;
}

type PreparedMemoryToolInput = ChiliMemoryToolInput & { memoryBinding: PreparedMemoryBinding };

export function createMemoryTool(options: ChiliMemoryToolOptions = {}): ChiliToolDefinition<PreparedMemoryToolInput> {
  return {
    name: "memory",
    aliases: ["save_memory"],
    searchHint: "Find, save, update, delete or export durable user/project memories by stable ID and revision.",
    description: "Manage long-term Memory in the active profile. List/search/get return stable IDs and revisions. Put/remove require the revision from a fresh read. Markdown is a one-time migration source; export returns a portable copy. Current task state belongs to session history.",
    risk: "write",
    resourcePolicy: "internal",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["add", "list", "search", "get", "put", "remove", "delete", "export"] },
        action: { type: "string", enum: ["add", "list", "search", "get", "put", "remove", "delete", "export"] },
        text: { type: "string" }, fact: { type: "string" }, memory: { type: "string" },
        scope: { type: "string", enum: ["user", "project", "all"] },
        query: { type: "string" }, id: { type: "string" }, expectedRevision: { type: "integer", minimum: 1 },
      },
    },
    async validate(input, context): Promise<ValidationResult<PreparedMemoryToolInput>> {
      const parsed = validateMemoryInput(input);
      if (!parsed.ok) return parsed;
      if (!context) return { ok: false, message: "memory calls require an execution context for resource identity" };
      const resolved = options.optionsForCwd ? await options.optionsForCwd(context.cwd) : options;
      const paths = await resolveChiliMemoryPaths({ ...options, ...resolved, cwd: context.cwd }, false);
      return {
        ok: true,
        value: { ...parsed.value, memoryBinding: {
          cwd: resolve(context.cwd), chiliHome: paths.chiliHome, projectRoot: paths.projectRoot, projectId: paths.projectId,
        } },
      };
    },
    isReadOnly: isRead,
    isConcurrencySafe: isRead,
    resources(input) {
      const binding = input.memoryBinding;
      const profileResource = `profile:${binding.chiliHome}`;
      const projectResource = `${profileResource}/project:${binding.projectId}`;
      return {
        permission: isRead(input) ? "memory.read" : "memory.write",
        patterns: input.scope === "all" ? [`${profileResource}/user`, projectResource]
          : [input.scope === "user" ? `${profileResource}/user` : projectResource],
        metadata: { operation: input.operation, scope: input.scope, projectId: binding.projectId },
      };
    },
    async execute(input, context) {
      const binding = input.memoryBinding;
      if (!binding || binding.cwd !== resolve(context.cwd)) throw new Error("Memory resource identity does not match the prepared execution context");
      const base = { ...binding, ...(context.assertCurrentAuthorization ? { assertCurrentAuthorization: context.assertCurrentAuthorization } : {}) };
      if (input.operation === "add") {
        const result = await addChiliMemoryEntry({ ...input, ...base, source: `tool:${context.sessionId}:${context.turnId}` });
        return { title: `memory ${result.scope}`, output: `Saved ${result.scope} memory ${result.id} (revision ${result.revision})\n- ${result.text}`,
          structuredData: result, metadata: { operation: input.operation, id: result.id, revision: result.revision, scope: result.scope } };
      }
      if (input.operation === "remove") {
        const result = await removeChiliMemoryEntry({ ...input, ...base });
        return { title: `memory ${result.scope}`, output: `Removed ${result.scope} memory ${result.id}\n- ${result.text}`,
          structuredData: result, metadata: { operation: input.operation, id: result.id, revision: result.revision, scope: result.scope } };
      }
      if (input.operation === "put") {
        const result = await putChiliMemoryEntry({ ...input, ...base, source: `tool:${context.sessionId}:${context.turnId}` });
        return { title: `memory ${result.scope}`, output: formatMemoryEntries([result]), structuredData: result, metadata: { operation: input.operation, id: result.id, revision: result.revision, scope: result.scope } };
      }
      if (input.operation === "export") {
        const markdown = await exportChiliMemory({ ...base, scope: input.scope });
        return { title: `memory export ${input.scope}`, output: markdown, structuredData: { format: "markdown", scope: input.scope, content: markdown }, metadata: { operation: input.operation, scope: input.scope } };
      }
      const entries = input.operation === "get"
        ? [await getChiliMemoryEntry({ ...base, scope: input.scope, id: input.id })].filter((entry) => entry !== undefined)
        : await (input.operation === "search" ? searchChiliMemoryEntries : listChiliMemoryEntries)({ ...input, ...base });
      return { title: "memory", output: formatMemoryEntries(entries), structuredData: { entries }, metadata: { operation: input.operation, scope: input.scope, count: entries.length } };
    },
  };
}

function isRead(input: ChiliMemoryToolInput): boolean {
  return input.operation !== "add" && input.operation !== "put" && input.operation !== "remove";
}
function normalizeWriteScope(raw: unknown): ChiliMemoryScope | undefined {
  return raw === undefined ? "project" : raw === "user" || raw === "project" ? raw : undefined;
}
function normalizeListScope(raw: unknown): ChiliMemoryListScope | undefined {
  return raw === undefined ? "all" : raw === "user" || raw === "project" || raw === "all" ? raw : undefined;
}

function validateMemoryInput(input: unknown): ValidationResult<ChiliMemoryToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const raw = input.operation ?? input.action ?? (input.text ?? input.fact ?? input.memory ? "add" : "list");
  const operation = raw === "delete" ? "remove" : raw;
  if (operation === "list" || operation === "search") {
    const scope = normalizeListScope(input.scope);
    if (!scope) return { ok: false, message: "scope must be user, project, or all" };
    if (input.query !== undefined && typeof input.query !== "string") return { ok: false, message: "query must be a string" };
    return { ok: true, value: { operation, scope, ...(typeof input.query === "string" ? { query: input.query } : {}) } };
  }
  const scope = normalizeWriteScope(input.scope);
  if (!scope) return { ok: false, message: "scope must be user or project" };
  if (operation === "export") return { ok: true, value: { operation, scope } };
  if (operation === "get" || operation === "put" || operation === "remove") {
    if (typeof input.id !== "string" || !input.id.trim()) return { ok: false, message: "use a stable id from memory list/search/get; positional deletion is no longer supported by the tool" };
    if (operation === "get") return { ok: true, value: { operation, scope, id: input.id } };
    if (typeof input.expectedRevision !== "number" || !Number.isInteger(input.expectedRevision) || input.expectedRevision <= 0) {
      return { ok: false, message: "put/remove requires expectedRevision from a fresh read" };
    }
    if (operation === "remove") return { ok: true, value: { operation, scope, id: input.id, expectedRevision: input.expectedRevision } };
    if (typeof input.text !== "string" || !input.text.trim()) return { ok: false, message: "put requires text" };
    return { ok: true, value: { operation, scope, id: input.id, expectedRevision: input.expectedRevision, text: input.text } };
  }
  if (operation === "add") {
    const text = input.text ?? input.fact ?? input.memory;
    if (typeof text !== "string" || !text.trim()) return { ok: false, message: "add requires text or fact" };
    return { ok: true, value: { operation, scope, text } };
  }
  return { ok: false, message: "unsupported memory operation" };
}
