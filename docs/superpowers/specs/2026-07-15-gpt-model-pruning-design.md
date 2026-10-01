# GPT Model Pruning Design

## Goal

Chili's ChatGPT Codex integration must support only GPT-5.5 and the GPT-5.6 Sol, Terra, and Luna variants. GPT-5.1 through GPT-5.4 must no longer appear in model catalogs or remain usable through explicit CLI arguments, environment configuration, persisted session overrides, or direct provider calls.

## Supported models

- `gpt-5.5`
- `gpt-5.6-sol` (default)
- `gpt-5.6-terra`
- `gpt-5.6-luna`

All other model IDs are unsupported by the `openai-codex` provider. Other providers and their model catalogs are unchanged.

## Design

The existing `OPENAI_CODEX_MODELS` tuple remains the single source of truth. The tuple and its cost table will be pruned to the four supported IDs, and descriptor logic that exists only for removed GPT versions will be deleted.

The provider boundary will validate every resolved Codex model ID against that tuple. Validation occurs after request, option, and environment precedence is resolved, so the same rule covers direct provider construction, `OPENAI_CODEX_MODEL`, CLI selection, persisted model selection, and per-request model overrides. Invalid selections fail before credentials are loaded or a network request is sent, with an error that names the unsupported model and lists the supported IDs.

Model-selection reasoning capability detection and Codex reasoning-effort clamping will retain only GPT-5.5 and GPT-5.6 special cases. CLI help examples and tests will use supported IDs. Tests that intentionally exercise generic parsing or unrelated runtime transport may keep arbitrary fixtures only when they do not advertise or enable removed Codex models.

## Verification

Focused tests will first assert the exact Codex catalog and rejection of removed models, then confirm all four supported IDs still resolve. After implementation, the provider and CLI test files, repository typecheck, unit suite, and smoke gate will be run. Existing unrelated approval/task worktree changes will not be modified or included in commits.
