# MiniMax

This directory owns `minimax`, its model metadata, environment contract and
factory. The shared Messages transport handles streaming and lifecycle behavior.

Default: `MiniMax-M3`. `MiniMax-M3.1-Flash-Preview` is an M Plan selection with
adaptive thinking and `output_config.effort` low/medium/high/xhigh/max. It cannot
disable thinking. Unverified preview prices and output caps stay unspecified.

Use `MINIMAX_API_KEY`, `MINIMAX_MODEL`, and `MINIMAX_ANTHROPIC_BASE_URL` (preferred)
or `MINIMAX_BASE_URL`. **`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and
`ANTHROPIC_MODEL` no longer configure MiniMax.** Rename these legacy settings to
the corresponding MiniMax names. This prevents an independent Anthropic
connection from being sent to the MiniMax endpoint.

Catalog last verified 2026-10-07 against the
[Messages API](https://platform.minimax.io/docs/api-reference/text-anthropic-api),
[CN pricing](https://platform.minimax.cn/docs/guides/pricing-paygo) and
[global pricing](https://platform.minimax.io/docs/guides/pricing-paygo).
The default endpoint is CN, so M3 reference prices are CNY standard-tier rates
for input up to 512K. Longer input costs 2x and priority costs 1.5x. An endpoint
override does not automatically change price metadata.

Run `bun test packages/providers/src/vendors/minimax packages/providers/src/env.test.ts packages/providers/src/catalog-update.test.ts`
after changing model or request options, then run repository-wide gates. Tests
use fake transports and do not establish account entitlement or task quality.
