# xAI

This directory owns the `xai` provider, catalog, environment variables and factory.
Responses framing, lifecycle, cancellation and error handling are shared.

Default: `grok-4.7`; `grok-4.6` remains selectable. Both accept text and images,
500K context and low/medium/high/xhigh reasoning. The catalog has no verified
vendor output cap; Chili's 128,000 request allowance is a separate limit. xAI's
`max_output_tokens` limits visible output only, excluding reasoning and function
calls, so it is not a cap on total generation or cost.
Grok 4.7 Fast is not listed because it was not on the public API when checked.

Configure `XAI_API_KEY`, optional `XAI_BASE_URL` and `XAI_MODEL`. Price metadata
is standard USD pricing below 200K prompt tokens; longer context costs 2x.

Both catalog models use `/v1/responses` by default. Full `/responses` endpoints
are accepted; a previously configured `/chat/completions` suffix is migrated to
`/responses`. Requests use `store: false` and explicitly request encrypted
reasoning. Chili resends local history and matching-connection reasoning items;
it does not depend on xAI's stored response IDs. Ciphertext is not replayed to a
different provider, API key or endpoint.

Reasoning uses `reasoning.effort`; Grok cannot disable it, so `off` maps to `low`,
and `max`/`ultra` map to `xhigh`. Both reasoning text and summary stream events
are consumed. Requests omit OpenAI-specific phase, verbosity, reasoning mode,
context and summary controls. Custom unregistered model IDs have unknown
capabilities, use a conservative 4,096 output allowance and omit reasoning
controls until their descriptor is registered.

Catalog last verified 2026-10-07 against official
[release notes](https://docs.x.ai/developers/release-notes) and
[Grok 4.7 documentation](https://docs.x.ai/developers/grok-4-7).
Responses behavior verified against the official
[Responses reference](https://docs.x.ai/developers/rest-api-reference/inference/responses),
[reasoning guide](https://docs.x.ai/developers/model-capabilities/text/reasoning), and
[stateless history guide](https://docs.x.ai/developers/model-capabilities/text/generate-text).

Keep models, sources and tests together when updating. Run
`bun test packages/providers/src/vendors/xai packages/providers/src/catalog-update.test.ts`
then repository-wide gates. Do not infer public API availability from consumer
product announcements or perform credentialed probes as part of fake tests.
