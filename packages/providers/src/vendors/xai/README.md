# xAI

This directory owns the `xai` provider, catalog, environment variables and factory.
Chat Completions framing, lifecycle and error handling are shared.

Default: `grok-4.7`; `grok-4.6` remains selectable. Both accept text and images,
500K context and low/medium/high/xhigh reasoning. The catalog has no verified
vendor output cap; Chili's 128,000 request allowance is a separate limit.
Grok 4.7 Fast is not listed because it was not on the public API when checked.

Configure `XAI_API_KEY`, optional `XAI_BASE_URL` and `XAI_MODEL`. Price metadata
is standard USD pricing below 200K prompt tokens; longer context costs 2x.

Catalog last verified 2026-10-07 against official
[release notes](https://docs.x.ai/developers/release-notes) and
[Grok 4.7 documentation](https://docs.x.ai/developers/grok-4-7).

Keep models, sources and tests together when updating. Run
`bun test packages/providers/src/vendors/xai packages/providers/src/catalog-update.test.ts`
then repository-wide gates. Do not infer public API availability from consumer
product announcements or perform credentialed probes as part of fake tests.
