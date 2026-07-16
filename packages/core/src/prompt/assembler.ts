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

interface IndexedPromptFragment {
  fragment: PromptFragment;
  index: number;
}

export class PromptAssembler {
  private readonly fragments: PromptFragment[] = [];

  add(fragment: PromptFragment | undefined): this {
    if (fragment && fragment.content.trim().length > 0) this.fragments.push(fragment);
    return this;
  }

  addMany(fragments: readonly PromptFragment[] | undefined): this {
    for (const fragment of fragments ?? []) this.add(fragment);
    return this;
  }

  assemble(): PromptAssembly {
    const fragments = this.sortedFragments().map(({ fragment }) => renderPromptFragment(fragment));
    return {
      system: contentForLayer(fragments, "base"),
      developer: contentForLayer(fragments, "developer"),
      contextualUser: contentForLayer(fragments, "contextual_user"),
      conversation: contentForLayer(fragments, "conversation"),
      fragments,
      debug: buildPromptDebugManifest(fragments),
    };
  }

  private sortedFragments(): IndexedPromptFragment[] {
    return this.fragments
      .map((fragment, index) => ({ fragment, index }))
      .sort((left, right) => {
        const layerDelta = PROMPT_LAYER_ORDER[left.fragment.layer] - PROMPT_LAYER_ORDER[right.fragment.layer];
        if (layerDelta !== 0) return layerDelta;
        const priorityDelta = left.fragment.priority - right.fragment.priority;
        if (priorityDelta !== 0) return priorityDelta;
        return left.index - right.index;
      });
  }
}

export function assemblePromptFragments(
  fragments: readonly PromptFragment[],
): PromptAssembly {
  return new PromptAssembler().addMany(fragments).assemble();
}

export function renderPromptFragment(fragment: PromptFragment): RenderedPromptFragment {
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
  };
  if (fragment.metadata !== undefined) rendered.metadata = fragment.metadata;
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
