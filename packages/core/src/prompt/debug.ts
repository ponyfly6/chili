import type { RenderedPromptFragment } from "./fragment.js";

export interface PromptDebugManifestItem {
  id: string;
  source: RenderedPromptFragment["source"];
  layer: RenderedPromptFragment["layer"];
  priority: number;
  chars: number;
  lifecycle: RenderedPromptFragment["lifecycle"];
  trust: RenderedPromptFragment["trust"];
  metadata?: Record<string, unknown>;
}

export interface PromptDebugManifest {
  fragments: PromptDebugManifestItem[];
  totalChars: number;
}

export function buildPromptDebugManifest(
  fragments: readonly RenderedPromptFragment[],
): PromptDebugManifest {
  const items = fragments.map((fragment) => {
    const item: PromptDebugManifestItem = {
      id: fragment.id,
      source: fragment.source,
      layer: fragment.layer,
      priority: fragment.priority,
      chars: fragment.chars,
      lifecycle: fragment.lifecycle,
      trust: fragment.trust,
    };
    if (fragment.metadata !== undefined) item.metadata = fragment.metadata;
    return item;
  });

  return {
    fragments: items,
    totalChars: items.reduce((total, item) => total + item.chars, 0),
  };
}
