import { buildPromptDebugManifest, type PromptDebugManifest } from "./debug.js";
import {
  PROMPT_LAYER_ORDER,
  type PromptFragment,
  type PromptLayer,
  type RenderedPromptFragment,
} from "./fragment.js";

export interface PromptAssembly {
  system: string[];
  developer: string[];
  contextualUser: string[];
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
  const clipped = clipContent(fragment.content.trim(), fragment.maxChars);
  if (!fragment.marker) return clipped;
  return [fragment.marker.open, clipped, fragment.marker.close].join("\n");
}

function clipContent(content: string, maxChars: number | undefined): string {
  if (maxChars === undefined || content.length <= maxChars) return content;
  const marker = `\n[fragment truncated after ${maxChars} chars]`;
  const sliceLength = Math.max(0, maxChars - marker.length);
  return `${content.slice(0, sliceLength).trimEnd()}${marker}`;
}

function contentForLayer(fragments: readonly RenderedPromptFragment[], layer: PromptLayer): string[] {
  return fragments
    .filter((fragment) => fragment.layer === layer)
    .map((fragment) => fragment.content)
    .filter(Boolean);
}
