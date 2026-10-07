# DeepSeek

This directory owns the `deepseek` provider, model catalog, environment names and
provider defaults. Shared Chat Completions transport is outside the vendor layer.

- `models.ts`: API IDs, capabilities, request compatibility, reference prices.
- `config.ts`: provider aliases, request allowance and environment contract.
- `provider.ts`: connection and model construction.
- `provider.test.ts`: fake-transport behavior tests.

Default: `deepseek-v4-pro` (0813); `deepseek-flash` and the legacy
`deepseek-v4-flash` name select V4.1 Flash. The catalog preserves this checked
mapping, including image input for Flash and text-only input for Pro.
Credentials and endpoint overrides use `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`
and `DEEPSEEK_MODEL`. No other vendor's variables are consumed.

Catalog last verified 2026-10-07 against [model metadata](https://api-docs.deepseek.com/api/list-models/)
and [pricing / aliases](https://api-docs.deepseek.com/quick_start/pricing/).
Prices are peak USD rates; off-peak rates are half. Output limits and Chili's
per-request token allowance are separate values.

When updating, verify API IDs, modalities, reasoning replay and token fields from
these official sources; adjust this directory and run
`bun test packages/providers/src/vendors/deepseek packages/providers/src/catalog-update.test.ts`.
Run the repository-wide gates before submitting. Do not use live credentials for
these tests or infer new capabilities from a similar model name.
