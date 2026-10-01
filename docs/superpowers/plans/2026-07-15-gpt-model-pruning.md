# GPT Model Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict the ChatGPT Codex provider to GPT-5.5 and the three GPT-5.6 variants, with no compatibility path for older or custom Codex model IDs.

**Architecture:** Keep `OPENAI_CODEX_MODELS` as the canonical whitelist and expose a typed assertion from the provider catalog. Apply that assertion after model precedence is resolved at both the provider and CLI boundaries, then remove obsolete metadata and special cases.

**Tech Stack:** Bun, TypeScript ESM, `bun:test`, Chili provider/CLI workspaces.

## Global Constraints

- Supported Codex IDs are exactly `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
- `gpt-5.6-sol` remains the default.
- Unsupported Codex IDs must fail before credential loading or network access.
- Other providers and the user's existing approval/task changes remain untouched.

---

### Task 1: Prune the canonical Codex catalog

**Files:**
- Modify: `packages/providers/src/model-selection.test.ts`
- Modify: `packages/providers/src/models.test.ts`
- Modify: `packages/providers/src/models.ts`

**Interfaces:**
- Produces: `isOpenAICodexModel(model: string): model is OpenAICodexModel`
- Produces: `assertOpenAICodexModel(model: string): asserts model is OpenAICodexModel`
- Produces: `OPENAI_CODEX_MODELS` containing exactly the four supported IDs.

- [ ] **Step 1: Write failing catalog and whitelist tests**

Change the Codex catalog expectation to:

```ts
expect(listKnownModels(OPENAI_CODEX_PROVIDER_ID).map((model) => model.model)).toEqual([
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
expect(findKnownModel(OPENAI_CODEX_PROVIDER_ID, "gpt-5.4")).toBeUndefined();
```

Add typed helper behavior assertions:

```ts
expect(isOpenAICodexModel("gpt-5.5")).toBe(true);
expect(isOpenAICodexModel("gpt-5.6-luna")).toBe(true);
expect(isOpenAICodexModel("gpt-5.4")).toBe(false);
expect(() => assertOpenAICodexModel("gpt-5.4")).toThrow(
  'Unsupported OpenAI Codex model "gpt-5.4"',
);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bun test packages/providers/src/models.test.ts packages/providers/src/model-selection.test.ts`

Expected: FAIL because the catalog still includes GPT-5.1 through GPT-5.4 and the whitelist helpers do not exist.

- [ ] **Step 3: Implement the canonical whitelist**

In `models.ts`, reduce the tuple and cost table to the four supported IDs, define `OpenAICodexModel`, and implement:

```ts
export type OpenAICodexModel = (typeof OPENAI_CODEX_MODELS)[number];

export function isOpenAICodexModel(model: string): model is OpenAICodexModel {
  return (OPENAI_CODEX_MODELS as readonly string[]).includes(model);
}

export function assertOpenAICodexModel(model: string): asserts model is OpenAICodexModel {
  if (isOpenAICodexModel(model)) return;
  throw new Error(
    `Unsupported OpenAI Codex model "${model}". Supported models: ${OPENAI_CODEX_MODELS.join(", ")}`,
  );
}
```

Simplify Codex descriptors so all four accept text/images, GPT-5.6 uses a 1,050,000-token context, and GPT-5.5 uses 272,000 tokens.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `bun test packages/providers/src/models.test.ts packages/providers/src/model-selection.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 5: Commit the catalog change**

```bash
git add packages/providers/src/models.ts packages/providers/src/models.test.ts packages/providers/src/model-selection.test.ts
git commit -m "feat(providers): prune legacy GPT models"
```

### Task 2: Reject unsupported Codex IDs at runtime boundaries

**Files:**
- Modify: `packages/providers/src/openai-codex.test.ts`
- Modify: `packages/providers/src/openai-codex.ts`
- Modify: `apps/cli/src/model.test.ts`
- Modify: `apps/cli/src/model.ts`

**Interfaces:**
- Consumes: `assertOpenAICodexModel(model: string): asserts model is OpenAICodexModel` from Task 1.
- Produces: strict validation for constructor/options, environment defaults, CLI selections, persisted selections, and per-request overrides.

- [ ] **Step 1: Write failing provider-boundary tests**

Add assertions equivalent to:

```ts
expect(() => createOpenAICodexModel({ model: "gpt-5.4" })).toThrow(
  'Unsupported OpenAI Codex model "gpt-5.4"',
);
expect(() => createOpenAICodexModel({ env: { OPENAI_CODEX_MODEL: "gpt-5.3-codex" } })).toThrow(
  'Unsupported OpenAI Codex model "gpt-5.3-codex"',
);
expect(() => resolveOpenAICodexStreamRequestOptions(
  { messages: [], model: "gpt-5.2" },
  { model: "gpt-5.5" },
)).toThrow('Unsupported OpenAI Codex model "gpt-5.2"');
```

Also assert that constructing each member of `OPENAI_CODEX_MODELS` succeeds.

- [ ] **Step 2: Write failing CLI rejection tests**

```ts
expect(() => resolveCliRuntimeModelSelection({ model: "gpt-5.4" })).toThrow(
  'Unsupported OpenAI Codex model "gpt-5.4"',
);
process.env.OPENAI_CODEX_MODEL = "gpt-5.3-codex";
expect(() => resolveCliRuntimeModelSelection({ model: "codex" })).toThrow(
  'Unsupported OpenAI Codex model "gpt-5.3-codex"',
);
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `bun test packages/providers/src/openai-codex.test.ts apps/cli/src/model.test.ts`

Expected: FAIL because unsupported explicit, environment, and request models still resolve.

- [ ] **Step 4: Implement provider and CLI validation**

In `openai-codex.ts`, assert the constructor's resolved model, the provider's resolved default, and `resolveOpenAICodexStreamRequestOptions`' final model. In `apps/cli/src/model.ts`, validate explicit Codex selections and the model returned by `readOpenAICodexOptionsFromEnv`.

Use one CLI helper:

```ts
function assertCliProviderModel(provider: CliProviderName, model: string | undefined): void {
  if (provider === OPENAI_CODEX_PROVIDER_ID && model) assertOpenAICodexModel(model);
}
```

Call it before returning explicit provider/model selections and after reading Codex environment options.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run: `bun test packages/providers/src/openai-codex.test.ts apps/cli/src/model.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 6: Commit runtime validation**

```bash
git add packages/providers/src/openai-codex.ts packages/providers/src/openai-codex.test.ts apps/cli/src/model.ts apps/cli/src/model.test.ts
git commit -m "feat(providers): reject unsupported Codex models"
```

### Task 3: Remove obsolete GPT behavior and references

**Files:**
- Modify: `packages/providers/src/model-selection.ts`
- Modify: `packages/providers/src/model-selection.test.ts`
- Modify: `packages/providers/src/openai-codex.ts`
- Modify: `packages/providers/src/openai-codex.test.ts`
- Modify: `packages/providers/src/models.test.ts`
- Modify: `apps/cli/src/args.ts`
- Modify: `apps/cli/src/args.test.ts`
- Modify: `apps/cli/src/config.test.ts`
- Modify: `apps/cli/src/model.test.ts`
- Modify: `apps/tui/src/slash/registry.test.ts`
- Modify: `packages/core/src/context/compaction.test.ts`
- Modify: `packages/server/src/runtime-http.test.ts`

**Interfaces:**
- Consumes: the strict four-model catalog and runtime assertion from Tasks 1 and 2.
- Produces: examples, fixtures, reasoning detection, and clamping rules that mention only GPT-5.5/5.6, except explicit rejection assertions.

- [ ] **Step 1: Add failing obsolete-behavior assertions**

```ts
expect(supportsXHighReasoning("gpt-5.4")).toBe(false);
expect(clampOpenAICodexReasoningEffort("gpt-5.4", "minimal")).toBe("minimal");
```

- [ ] **Step 2: Run the focused behavior tests and verify RED**

Run: `bun test packages/providers/src/model-selection.test.ts packages/providers/src/openai-codex.test.ts`

Expected: FAIL because GPT-5.2 through GPT-5.4 still receive legacy special handling.

- [ ] **Step 3: Remove obsolete special cases**

Limit `supportsXHighReasoning` GPT checks to `gpt-5.5` and `gpt-5.6`. Limit minimal-to-low Codex clamping to those same versions, and delete GPT-5.1-specific clamping branches.

- [ ] **Step 4: Replace removed-model examples and fixtures**

Use `gpt-5.6-terra` or `gpt-5.6-luna` where a second supported model is required. Use a neutral ID such as `text-only-codex-fixture` only in low-level request-body tests that explicitly inject capabilities and do not resolve a provider model. Preserve removed IDs only in rejection tests.

- [ ] **Step 5: Verify no obsolete positive references remain**

Run: `rg -n 'gpt-5\.[1-4]' apps packages scripts --glob '!**/node_modules/**'`

Expected: matches exist only in tests that assert unsupported-model rejection or lack of legacy special handling.

- [ ] **Step 6: Run affected tests and verify GREEN**

Run: `bun test packages/providers/src apps/cli/src/args.test.ts apps/cli/src/config.test.ts apps/cli/src/model.test.ts apps/tui/src/slash/registry.test.ts packages/core/src/context/compaction.test.ts packages/server/src/runtime-http.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 7: Commit cleanup**

```bash
git add packages/providers/src/model-selection.ts packages/providers/src/model-selection.test.ts packages/providers/src/openai-codex.ts packages/providers/src/openai-codex.test.ts packages/providers/src/models.test.ts apps/cli/src/args.ts apps/cli/src/args.test.ts apps/cli/src/config.test.ts apps/cli/src/model.test.ts apps/tui/src/slash/registry.test.ts packages/core/src/context/compaction.test.ts packages/server/src/runtime-http.test.ts
git commit -m "chore: remove obsolete GPT model references"
```

### Task 4: Full verification

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: fresh repository-wide evidence.

- [ ] **Step 1: Run formatting and diff checks**

Run: `git diff --check HEAD~3..HEAD`

Expected: exit 0 with no output.

- [ ] **Step 2: Run type checking**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 3: Run unit tests**

Run: `bun test`

Expected: exit 0 with zero failures.

- [ ] **Step 4: Run the smoke gate**

Run: `bun run smoke:all`

Expected: exit 0 with all smoke checks passing.
