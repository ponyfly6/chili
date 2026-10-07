# Kimi / Moonshot

This directory owns `kimi`, its catalog, environment configuration, model routing,
and request policy. Shared protocol code handles streaming, cancellation, errors,
and connection-scoped reasoning replay.

Default: `kimi-k3`, using `/v1/responses`. The official Responses API currently
supports only K3. `kimi-k2.7-code` and `kimi-k2.7-code-highspeed` retain Chat
Completions; no Responses support is inferred for them or custom model names.
The class name `KimiOpenAIProvider` remains for source compatibility.

K3 sends `max_output_tokens` (default 131072, documented maximum 1048576) and
`reasoning.effort` with low/high/max. Effort is omitted unless requested, leaving
the API's max default; an off request selects low because K3 always reasons.
`request.ts` deliberately builds the narrower Kimi schema. It does not send
OpenAI's reasoning include/summary, text verbosity, store, background, parallel
call switch, or service tier. Temperature remains available for Chat models, but
is omitted from K3 Responses because it is absent from Kimi's request schema.
Session identity becomes `prompt_cache_key`. Images use base64 data URLs; public
image URLs are not supported by the documented Responses contract.

K3's finalized reasoning arrives as ordinary summary/content items;
`encrypted_content` is documented as null. The shared parser retains the complete
returned item, and the next request replays the documented reasoning fields with
its tool call and matching result. Provider, endpoint and effective authorization must match to replay the original
structured item, including its ID. Older Chat turns carry only ordinary visible
reasoning text; Kimi accepts this as a plain `reasoning.content` item. This conversion applies only to originally plain text; an incompatible structured
reasoning part is removed from the current request rather than reconstructed
from its display text. Persisted history remains unchanged. Ciphertext, signatures,
redacted and empty text are never synthesized, and a completed structured item is
not duplicated by its display text. This implementation
manages history locally; it does not use `previous_response_id` or remote storage.
Only Chili's function tools are exposed, not Kimi's server-side search or custom
apply-patch tool formats.

K2.7 Code always preserves thinking (`keep: "all"`) and accepts no configurable
effort. It uses `max_completion_tokens`; the precise maximum output limit remains
unspecified. Unknown model names use conservative text-only Chat defaults with
8192 requested output tokens, rather than inheriting K3 limits and reasoning
parameters. Explicit custom capabilities/Chat compatibility remain possible.

Environment precedence: `MOONSHOT_API_KEY` before `KIMI_API_KEY`,
`MOONSHOT_BASE_URL` before `KIMI_BASE_URL`, and `MOONSHOT_MODEL` before `KIMI_MODEL`.
Explicit factory options override the environment. K3 accepts a service base URL
or a full Responses endpoint. An old full `/chat/completions` or `/messages` URL
is rejected with a migration message rather than silently switching protocol.
Default endpoint and prices refer to the CN service. K3 cache-write rates are for
the default 5-minute TTL; endpoint overrides do not discover gateway pricing.

Catalog and protocol last verified 2026-10-07 against the official
[Responses API](https://platform.kimi.com/docs/api/responses),
[model list](https://platform.kimi.com/docs/models),
[K2.7 guide](https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart),
[Chat API](https://platform.kimi.com/docs/api/chat),
[thinking contract](https://platform.kimi.com/docs/guide/use-thinking-models), and
[CN pricing](https://platform.kimi.com/docs/pricing/chat).

Keep model defaults, request builders, source notes and fake-transport tests
here. Run `bun test packages/providers/src/vendors/kimi` and the shared catalog
and registry tests, then repository-wide gates. No live requests are needed.
