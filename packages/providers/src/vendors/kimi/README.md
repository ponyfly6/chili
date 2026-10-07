# Kimi / Moonshot

This directory owns `kimi`, its catalog, configuration and thin Chat Completions
factory. `models.ts` carries compatibility for each model; protocol streaming,
cancellation and error handling remain shared.

Default: `kimi-k3`. The catalog also includes `kimi-k2.7-code` and
`kimi-k2.7-code-highspeed`. K2.7 Code always preserves thinking and accepts no
configurable effort; K3 supports low/high/max. Both use `max_completion_tokens`.
The precise K2.7 maximum output limit is deliberately unspecified.

Environment precedence: `MOONSHOT_API_KEY` before `KIMI_API_KEY`,
`MOONSHOT_BASE_URL` before `KIMI_BASE_URL`, and `MOONSHOT_MODEL` before `KIMI_MODEL`.
Default endpoint and prices refer to the CN service. K3 cache-write rates are for
the default 5-minute TTL; endpoint overrides do not discover gateway pricing.

Catalog last verified 2026-10-07 against the official
[model list](https://platform.kimi.com/docs/models),
[K2.7 guide](https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart),
[Chat API](https://platform.kimi.com/docs/api/chat),
[thinking contract](https://platform.kimi.com/docs/guide/use-thinking-models) and
[CN pricing](https://platform.kimi.com/docs/pricing/chat).

Keep model defaults, source notes and fake-transport tests together when updating.
Run `bun test packages/providers/src/vendors/kimi packages/providers/src/catalog-update.test.ts`
then repository-wide gates. No live requests are needed.
