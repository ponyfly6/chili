import { createHash } from "node:crypto";
import { buildPromptDebugManifest, type PromptDebugManifest } from "./debug.js";
import {
  PROMPT_LAYER_ORDER,
  DEFAULT_PROMPT_FRAGMENT_MAX_CHARS,
  type PromptFragment,
  type PromptLayer,
  type RenderedPromptFragment,
} from "./fragment.js";

export interface PromptAssembly {
  system: string[];
  developer: string[];
  contextualUser: string[];
  conversation: string[];
  fragments: RenderedPromptFragment[];
  debug: PromptDebugManifest;
}

export class PromptAssembler {
  private readonly fragments: PromptFragment[] = [];

  add(fragment: PromptFragment | undefined): this {
    if (fragment) this.fragments.push({ ...fragment });
    return this;
  }

  addMany(fragments: readonly PromptFragment[] | undefined): this {
    for (const fragment of fragments ?? []) this.add(fragment);
    return this;
  }

  assemble(): PromptAssembly {
    return assembleRenderedPromptFragments(uniqueFragments(this.fragments).map(renderPromptFragment));
  }
}

export function assemblePromptFragments(
  fragments: readonly PromptFragment[],
): PromptAssembly {
  return new PromptAssembler().addMany(fragments).assemble();
}

/** Extend a rendered assembly without turning its preview into a new source. */
export function assembleRenderedPromptFragments(input: readonly RenderedPromptFragment[]): PromptAssembly {
  const fragments = uniqueFragments(input, true).sort((left, right) => (
    PROMPT_LAYER_ORDER[left.layer] - PROMPT_LAYER_ORDER[right.layer] || left.priority - right.priority
  ));
  return {
    system: contentForLayer(fragments, "base"),
    developer: contentForLayer(fragments, "developer"),
    contextualUser: contentForLayer(fragments, "contextual_user"),
    conversation: contentForLayer(fragments, "conversation"),
    fragments,
    debug: buildPromptDebugManifest(fragments),
  };
}

export function renderPromptFragment(fragment: PromptFragment): RenderedPromptFragment {
  fragment = enforceFragmentAuthority(fragment);
  const content = renderPromptFragmentContent(fragment);
  const rendered: RenderedPromptFragment = {
    id: fragment.id,
    layer: fragment.layer,
    source: fragment.source,
    priority: fragment.priority,
    lifecycle: fragment.lifecycle,
    trust: fragment.trust,
    content,
    chars: content.length,
    ...(fragment.sourceContent !== undefined ? { sourceContent: fragment.sourceContent } : {}),
  };
  const maxChars = normalizeMaxChars(fragment.maxChars ?? DEFAULT_PROMPT_FRAGMENT_MAX_CHARS);
  const wrapperChars = fragment.marker ? fragment.marker.open.length + fragment.marker.close.length + 2 : 0;
  rendered.metadata = {
    ...fragment.metadata,
    sourceContentVersion: createHash("sha256").update(fragment.sourceContent ?? fragment.content).digest("hex"),
    sourceChars: (fragment.sourceContent ?? fragment.content).length,
    truncated: fragment.metadata?.truncated === true || fragment.content.trim().length > Math.max(0, maxChars - wrapperChars),
  };
  return rendered;
}

function renderPromptFragmentContent(fragment: PromptFragment): string {
  const maxChars = normalizeMaxChars(fragment.maxChars ?? DEFAULT_PROMPT_FRAGMENT_MAX_CHARS);
  const content = fragment.content.trim();
  if (!fragment.marker) return clipContent(content, maxChars);
  const prefix = `${fragment.marker.open}\n`;
  const suffix = `\n${fragment.marker.close}`;
  const wrapperChars = prefix.length + suffix.length;
  if (wrapperChars >= maxChars) return "";
  return `${prefix}${clipContent(content, maxChars - wrapperChars)}${suffix}`;
}

function clipContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = `\n[fragment truncated after ${maxChars} chars]`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  const sliceLength = Math.max(0, maxChars - marker.length);
  return `${sliceHeadWithoutBrokenSurrogate(content, sliceLength).trimEnd()}${marker}`;
}

function normalizeMaxChars(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PROMPT_FRAGMENT_MAX_CHARS;
  return Math.max(0, Math.trunc(value));
}

function sliceHeadWithoutBrokenSurrogate(text: string, maxChars: number): string {
  let end = Math.max(0, Math.min(text.length, maxChars));
  if (end > 0) {
    const value = text.charCodeAt(end - 1);
    if (value >= 0xd800 && value <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
}

function contentForLayer(fragments: readonly RenderedPromptFragment[], layer: PromptLayer): string[] {
  return fragments
    .filter((fragment) => fragment.layer === layer)
    .map((fragment) => fragment.content)
    .filter(Boolean);
}

function uniqueFragments<T extends PromptFragment>(input: readonly T[], preserveEmpty = false): T[] {
  const fragments = new Map<string, T>();
  const identities = new Map<string, string>();
  for (const candidate of input) {
    const fragment = enforceFragmentAuthority(candidate);
    const identity = JSON.stringify([
      fragment.source, fragment.layer, fragment.trust,
      ...["scope", "projectId", "profile", "path", "memoryId", "serverName"].map((key) => fragment.metadata?.[key]),
    ]);
    const previousIdentity = identities.get(fragment.id);
    if (previousIdentity !== undefined && previousIdentity !== identity) {
      throw new Error(`Prompt fragment identity collision: ${fragment.id}`);
    }
    identities.set(fragment.id, identity);
    if (!preserveEmpty && !fragment.content.trim()) fragments.delete(fragment.id);
    else fragments.set(fragment.id, fragment);
  }
  return [...fragments.values()];
}

/** Material trust is enforced at the role boundary, not only recorded in debug labels. */
function enforceFragmentAuthority<T extends PromptFragment>(fragment: T): T {
  if (fragment.trust === "system" || (fragment.layer !== "base" && fragment.layer !== "developer")) return fragment;
  return {
    ...fragment,
    layer: "contextual_user",
    metadata: { ...fragment.metadata, requestedLayer: fragment.layer, authority: "reference_material" },
  };
}
