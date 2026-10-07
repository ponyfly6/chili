import { createHash } from "node:crypto";
import type { ExecutionIdentity, Message, PreparedModelRequest, SessionId } from "@chili/protocol";
import type { EventStore } from "@chili/store";
import type { ModelStreamInput } from "../runtime.js";
import type { PromptDebugManifest, PromptDebugManifestItem } from "../prompt/debug.js";
import type { RenderedPromptFragment } from "../prompt/fragment.js";
import type { CompactionRequestSource } from "./compaction.js";
import type { ContextRequestSurface, ContextUsage } from "./window.js";

type Source = PreparedModelRequest["sources"][number];

export interface PrepareModelRequestInput {
  modelInput: ModelStreamInput;
  sourceMessages: readonly Message[];
  sourceSurface: ContextRequestSurface;
  usage?: ContextUsage;
  purpose?: "turn" | "compaction";
  compactionSource?: CompactionRequestSource;
  sourceEventId?: string;
  toolCatalogRevision?: number;
  executionIdentity?: ExecutionIdentity;
}

/** Immutable JSON content captured after budgeting, immediately before transport. */
export function prepareModelRequest(input: PrepareModelRequestInput): PreparedModelRequest {
  const model = input.modelInput;
  const sources: Source[] = [];
  for (const [kind, original, selected, layer] of [
    ["system", input.sourceSurface.system ?? [], model.system, "base"],
    ["developer", input.sourceSurface.developer ?? [], model.developer ?? [], "developer"],
    ["contextual_user", input.sourceSurface.contextualUser ?? [], model.contextualUser ?? [], "contextual_user"],
  ] as const) {
    const fragments = model.promptDebug?.fragments.filter((fragment) => fragment.layer === layer) ?? [];
    const unmatchedFragments = new Set(fragments);
    const selectedIndices = new Set<number>();
    original.forEach((content, index) => {
      const renderedVersion = contentHash(content);
      // Empty/omitted fragments and deduplication can change array positions.
      // Match the actual rendered material, consuming each occurrence once.
      const fragment = fragments.find((candidate) => (
        unmatchedFragments.has(candidate) && candidate.contentVersion === renderedVersion
      ));
      if (fragment) unmatchedFragments.delete(fragment);
      let selectedIndex = selected.findIndex((value, candidateIndex) => (
        !selectedIndices.has(candidateIndex) && value === content
      ));
      if (selectedIndex < 0 && original.length === 1 && selected.length === 1) selectedIndex = 0;
      const actual = selectedIndex < 0 ? undefined : selected[selectedIndex];
      if (selectedIndex >= 0) selectedIndices.add(selectedIndex);
      const optionalMemory = fragment?.source === "memory"
        && (fragment.metadata?.kind === "user_memory" || fragment.metadata?.kind === "project_memory");
      sources.push({
        id: fragment?.id ?? `${kind}:${index}`,
        kind,
        version: typeof fragment?.metadata?.sourceContentVersion === "string"
          ? fragment.metadata.sourceContentVersion : renderedVersion,
        status: actual === undefined ? "omitted" : actual === content && fragment?.metadata?.truncated !== true ? "included" : "truncated",
        ...(actual !== content ? { reason: optionalMemory ? "memory_context_budget" : "prompt_material_budget" }
          : fragment?.metadata?.truncated === true ? { reason: "source_fragment_budget" } : {}),
        metadata: {
          ...fragment?.metadata,
          ...(fragment ? { source: fragment.source, trust: fragment.trust, lifecycle: fragment.lifecycle, priority: fragment.priority } : {}),
          originalChars: typeof fragment?.metadata?.sourceChars === "number" ? fragment.metadata.sourceChars : content.length,
          renderedChars: content.length,
          renderedVersion,
          actualChars: actual?.length ?? 0,
          ...(actual !== undefined ? { actualVersion: contentHash(actual) } : {}),
        },
      });
    });
    for (const fragment of unmatchedFragments) {
      sources.push({
        id: fragment.id, kind,
        version: typeof fragment.metadata?.sourceContentVersion === "string"
          ? fragment.metadata.sourceContentVersion : fragment.contentVersion ?? contentHash(""),
        status: "omitted",
        reason: fragment.chars === 0 ? "source_fragment_budget" : "prompt_material_not_selected",
        metadata: { ...fragment.metadata, source: fragment.source, trust: fragment.trust,
          lifecycle: fragment.lifecycle, priority: fragment.priority, actualChars: 0 },
      });
    }
  }
  const compactionSource = input.purpose === "compaction" ? input.compactionSource : undefined;
  const compactionIds = new Set(compactionSource?.messageIds);
  for (const message of input.sourceMessages) {
    const actual = model.messages.find((candidate) => candidate.id === message.id);
    const version = contentHash(message);
    if (compactionSource) {
      sources.push({ id: message.id, kind: "message", version,
        status: compactionIds.has(message.id) ? "included" : "omitted",
        reason: compactionIds.has(message.id) ? "compaction_serialized_source" : "outside_compaction_batch",
        metadata: { role: message.role, partIds: message.parts.map((part) => part.id),
          batch: compactionSource.batch, stage: compactionSource.stage,
          representation: "text_and_attachment_metadata" },
      });
      continue;
    }
    sources.push({
      id: message.id,
      kind: "message",
      version,
      status: actual === undefined ? "omitted" : contentHash(actual) === version ? "included" : "truncated",
      ...(actual === undefined ? { reason: message.parts.length === 0 ? "empty_message" : "history_compaction_or_budget" } : contentHash(actual) !== version ? { reason: "message_or_tool_result_budget" } : {}),
      metadata: { role: message.role, partIds: message.parts.map((part) => part.id) },
    });
  }
  if (compactionSource) {
    for (const message of model.messages) {
      sources.push({ id: message.id, kind: "message", version: contentHash(message), status: "included",
        reason: "compaction_request",
        metadata: { sourceMessageIds: [...compactionSource.messageIds], batch: compactionSource.batch, stage: compactionSource.stage,
          ...(compactionSource.previousSummary ? { previousSummaryVersion: contentHash(compactionSource.previousSummary) } : {}),
          ...(compactionSource.draftSummary ? { draftSummaryVersion: contentHash(compactionSource.draftSummary) } : {}),
        },
      });
    }
  }
  for (const tool of input.sourceSurface.tools ?? []) {
    const original = toolSchema(tool);
    const actual = model.tools.find((candidate) => candidate.name === tool.name);
    const version = contentHash(original);
    sources.push({
      id: tool.name,
      kind: "tool",
      version,
      status: !actual ? "omitted" : contentHash(toolSchema(actual)) === version ? "included" : "truncated",
      ...(!actual || contentHash(toolSchema(actual)) !== version ? { reason: "tool_schema_budget" } : {}),
    });
  }
  const budget = Object.fromEntries(Object.entries(input.usage ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  if (input.sourceSurface.contextWindowTokens !== undefined) budget.contextWindowTokens = input.sourceSurface.contextWindowTokens;
  if (input.sourceSurface.requestMaxOutputTokens !== undefined) budget.requestMaxOutputTokens = input.sourceSurface.requestMaxOutputTokens;
  const content = {
    version: 1 as const,
    purpose: input.purpose ?? "turn" as const,
    ...(input.executionIdentity ? { executionIdentity: input.executionIdentity } : {}),
    sessionRevision: input.sourceMessages.reduce((total, message) => total + 1 + message.parts.length, 0),
    ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
    ...(input.toolCatalogRevision !== undefined ? { toolCatalogRevision: input.toolCatalogRevision } : {}),
    ...(model.modelSelection ? { modelSelection: model.modelSelection } : {}),
    ...(model.reasoningLevel !== undefined ? { reasoningLevel: model.reasoningLevel } : {}),
    ...(model.serviceTier !== undefined ? { serviceTier: model.serviceTier } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    system: model.system,
    developer: model.developer ?? [],
    contextualUser: model.contextualUser ?? [],
    messages: model.messages,
    tools: model.tools.map(toolSchema),
    sources,
    budget,
  };
  // The snapshot must never share mutable history/schema objects with a provider.
  return JSON.parse(JSON.stringify({ ...content, contentVersion: contentHash(content) })) as PreparedModelRequest;
}

export async function latestPreparedRequest(store: EventStore, sessionId: SessionId): Promise<PreparedModelRequest | undefined> {
  const events = await store.events({ sessionId, type: "model.request_prepared", tail: true, limit: 1 });
  const payload = events[0]?.payload as { request?: PreparedModelRequest; requestId?: string; attempt?: number } | undefined;
  if (!payload?.request) return undefined;
  const identities = await store.events({ sessionId, type: "model.request_identity", tail: true, limit: 32 });
  const actual = identities.map((event) => event.payload as { requestId: string; attempt: number; identity: NonNullable<PreparedModelRequest["modelIdentity"]> })
    .findLast((event) => event.requestId === payload.requestId && event.attempt === payload.attempt);
  return actual ? { ...payload.request, modelIdentity: actual.identity } : payload.request;
}

export function preparedRequestFragments(request: PreparedModelRequest): RenderedPromptFragment[] {
  return ([
    ["system", "base", request.system],
    ["developer", "developer", request.developer],
    ["contextual_user", "contextual_user", request.contextualUser],
  ] as const).flatMap(([kind, layer, items]) => {
    const sources = request.sources.filter((source) => source.kind === kind && source.status !== "omitted");
    return items.map((content, index) => {
      const source = sources[index];
      const metadata = source?.metadata;
      return {
        id: source?.id ?? `${kind}:${index}`,
        layer,
        source: (metadata?.source ?? "runtime") as RenderedPromptFragment["source"],
        trust: (metadata?.trust ?? (kind === "contextual_user" ? "user" : "system")) as RenderedPromptFragment["trust"],
        lifecycle: (metadata?.lifecycle ?? "turn") as RenderedPromptFragment["lifecycle"],
        priority: typeof metadata?.priority === "number" ? metadata.priority : index,
        content,
        chars: content.length,
        metadata: { ...metadata, contentVersion: contentHash(content), requestContentVersion: request.contentVersion, actualRequest: true },
      };
    });
  });
}

export function preparedRequestDebug(request: PreparedModelRequest): PromptDebugManifest {
  const fragments: PromptDebugManifestItem[] = preparedRequestFragments(request).map(({ content: _content, ...fragment }) => fragment);
  return { fragments, totalChars: fragments.reduce((total, fragment) => total + fragment.chars, 0) };
}

export function contentHash(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
  return createHash("sha256").update(serialized).digest("hex");
}

function toolSchema(tool: ModelStreamInput["tools"][number]) {
  return { name: tool.name, description: tool.description, risk: tool.risk, inputSchema: tool.inputSchema };
}
