# DeepSeek

This directory owns the `deepseek` model catalog, environment names, factories and
wire request construction. Shared Responses transport handles SSE parsing,
cancellation, request deadlines, errors and credential-scoped continuation state.

- `models.ts`: API IDs, capabilities, Responses effort mapping and reference prices.
- `config.ts`: provider aliases, request allowances and environment contract.
- `provider.ts`: connection selection and endpoint validation.
- `request.ts`: stateless DeepSeek Responses input, tools and reasoning parameters.
- `provider.test.ts`: fake-transport behavior and continuation tests.

The default remains `deepseek-v4-pro` (0813). All verified catalog entries now use
**Responses**: Pro, `deepseek-flash` and the accepted legacy `deepseek-v4-flash`
slug. Flash supports image input; Pro is text-only. Credentials and overrides use
`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL` exclusively.

A root base URL becomes `https://api.deepseek.com/responses`; a compatible gateway
base such as `https://gateway.example/v1` becomes `/v1/responses`. A complete
`/responses` URL is accepted. Complete `/chat/completions` or `/messages` endpoints
are rejected for these verified models with a migration error. There is no
failure-driven downgrade to a different protocol. Unknown custom model IDs stay
on conservative Chat Completions defaults (text-only, 4,096-token allowance,
no assumed thinking dialect or flagship capabilities).

DeepSeek Responses is stateless. Every request includes full retained history;
Chili does not use `previous_response_id` or enable server storage. DeepSeek
returns plain `reasoning` items whose `content` contains `reasoning_text` blocks.
The shared parser stores the completed item, and the vendor builder replays its
plain content once alongside tool calls and paired results. Existing Chat
Completions history is converted from its stored reasoning text. Display deltas
are not duplicated when a completed item is available. Ordinary visible reasoning
text remains conversation content when switching connections; it can be converted
to DeepSeek plain reasoning. Credential-scoped opaque state is handled separately:
removed ciphertext or signatures are never reconstructed from visible text.
Original provider call IDs, including punctuation and long IDs, remain unchanged
when pairing function calls and their results. DeepSeek requests do not
send OpenAI `encrypted_content`, `summary`, `include`, cache keys, service tiers or
assistant `phase` fields. Unsupported OpenAI controls are not copied into the
body. Only Chili function tools are exposed; vendor-native built-in tools are
outside this integration.

`reasoning.effort` maps to `none` / `low` / `high` / `max`; default effort remains
high, and per-request controls take precedence. `max_output_tokens` replaces
Chat's `max_tokens`. Output limits and Chili's request allowance remain separate.
Model limits and reference prices are unchanged by the protocol migration.

Verified 2026-10-07 against the official
[Responses API reference](https://api-docs.deepseek.com/api/create-response/),
[Responses guide](https://api-docs.deepseek.com/guides/responses_api/),
[model metadata](https://api-docs.deepseek.com/api/list-models/) and
[pricing / aliases](https://api-docs.deepseek.com/quick_start/pricing/).
The API reference confirms both Pro and Flash, while pricing explicitly keeps the
legacy Flash slug accepted. Prices are peak USD rates; off-peak rates are half.

When updating, verify model API availability, modalities, plain reasoning replay
and token fields in official documentation. Run
`bun test packages/providers/src/vendors/deepseek packages/providers/src/catalog-update.test.ts`
and then repository-wide gates. Fake tests cover known-model default routing,
legacy reasoning history, complete Responses reasoning/tool replay, image input,
pre-cancel and active cancellation, HTTP/SSE failures and premature EOF. They do
not establish real-account entitlement or certify live provider availability.
