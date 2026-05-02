import { homedir } from "node:os";
import { join } from "node:path";
import type { ChiliToolDefinition, ValidationResult } from "@chili/tools";
import { CHILI_MEMORY_DIR, CHILI_MEMORY_FILENAME } from "./constants.js";
import {
  addChiliMemoryEntry,
  formatMemoryEntries,
  listChiliMemoryEntries,
  removeChiliMemoryEntry,
} from "./entries.js";
import type { ChiliMemoryListScope, ChiliMemoryScope, ChiliMemoryToolInput, ChiliMemoryToolOptions } from "./types.js";
import { isRecord } from "./utils.js";

export function createMemoryTool(options: ChiliMemoryToolOptions = {}): ChiliToolDefinition<ChiliMemoryToolInput> {
  return {
    name: "memory",
    aliases: ["save_memory"],
    searchHint: "Persist or inspect Chili memory entries; add/list/remove user or project memory.",
    description: "Manage persistent Chili memory stored in Markdown files.",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["add", "list", "remove"] },
        action: { type: "string", enum: ["add", "list", "remove"] },
        text: { type: "string" },
        fact: { type: "string" },
        scope: { type: "string", enum: ["user", "project", "all"] },
        index: { type: "number" },
      },
    },
    validate(input): ValidationResult<ChiliMemoryToolInput> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const rawOperation = pickString(input, "operation", "action");
      const operation = normalizeOperation(rawOperation, input);
      if (!operation) return { ok: false, message: "operation must be add, list, or remove" };

      if (operation === "add") {
        const text = pickString(input, "text", "fact", "memory");
        if (typeof text !== "string" || text.trim().length === 0) {
          return { ok: false, message: "add requires text or fact" };
        }
        const scope = normalizeWriteScope(input.scope);
        if (!scope) return { ok: false, message: "add scope must be user or project" };
        return { ok: true, value: { operation, text, scope } };
      }

      if (operation === "list") {
        const scope = normalizeListScope(input.scope);
        if (!scope) return { ok: false, message: "list scope must be user, project, or all" };
        return { ok: true, value: { operation, scope } };
      }

      const scope = normalizeWriteScope(input.scope);
      if (!scope) return { ok: false, message: "remove scope must be user or project" };
      if (!isPositiveInteger(input.index)) return { ok: false, message: "remove requires a positive integer index" };
      return { ok: true, value: { operation, scope, index: input.index } };
    },
    isReadOnly(input) {
      return input.operation === "list";
    },
    isConcurrencySafe(input) {
      return input.operation === "list";
    },
    approval(input) {
      if (input.operation === "list") return false;
      return {
        permission: "write",
        patterns: [input.scope === "user" ? join(options.homeDir ?? homedir(), CHILI_MEMORY_DIR, CHILI_MEMORY_FILENAME) : join(CHILI_MEMORY_DIR, CHILI_MEMORY_FILENAME)],
        metadata: {
          operation: input.operation,
          scope: input.scope,
        },
      };
    },
    async execute(input, context) {
      if (input.operation === "add") {
        const result = await addChiliMemoryEntry({
          cwd: context.cwd,
          text: input.text,
          scope: input.scope,
          ...(options.homeDir ? { homeDir: options.homeDir } : {}),
          ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
        });
        return {
          title: `memory ${result.scope}`,
          output: `Saved ${result.scope} memory to ${result.path}\n- ${result.text}`,
          metadata: {
            operation: input.operation,
            scope: result.scope,
            path: result.path,
            created: result.created,
          },
        };
      }

      if (input.operation === "remove") {
        const result = await removeChiliMemoryEntry({
          cwd: context.cwd,
          scope: input.scope,
          index: input.index,
          ...(options.homeDir ? { homeDir: options.homeDir } : {}),
          ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
        });
        return {
          title: `memory ${result.scope}`,
          output: `Removed ${result.scope} memory #${result.index} from ${result.path}\n- ${result.text}`,
          metadata: {
            operation: input.operation,
            scope: result.scope,
            path: result.path,
            index: result.index,
          },
        };
      }

      const entries = await listChiliMemoryEntries({
        cwd: context.cwd,
        scope: input.scope,
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      });
      return {
        title: "memory",
        output: formatMemoryEntries(entries),
        metadata: {
          operation: input.operation,
          scope: input.scope,
          count: entries.length,
        },
      };
    },
  };
}

function normalizeOperation(raw: unknown, input: Record<string, unknown>): ChiliMemoryToolInput["operation"] | undefined {
  if (raw === undefined) {
    return pickString(input, "text", "fact", "memory") ? "add" : "list";
  }
  if (raw === "add" || raw === "list" || raw === "remove") return raw;
  return undefined;
}

function normalizeWriteScope(raw: unknown): ChiliMemoryScope | undefined {
  if (raw === undefined) return "project";
  return raw === "user" || raw === "project" ? raw : undefined;
}

function normalizeListScope(raw: unknown): ChiliMemoryListScope | undefined {
  if (raw === undefined) return "all";
  return raw === "user" || raw === "project" || raw === "all" ? raw : undefined;
}

function pickString(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
