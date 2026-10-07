# MiniMax

This directory owns `minimax`, model metadata, environment settings and request
construction. Both catalog models use the shared **Responses** transport.

Default model: `MiniMax-M3`. Chili explicitly sends `reasoning.effort: high` to
keep thinking enabled; `off` maps to `none`. For M3, non-`none` effort enables
thinking without tuning depth. `MiniMax-M3.1-Flash-Preview` is an M Plan selection
with always-on reasoning and low/medium/high/xhigh/max effort. Omitting effort
keeps its server default of max. Unverified preview prices/output caps remain
unspecified.

Use `MINIMAX_API_KEY`, `MINIMAX_MODEL`, and `MINIMAX_BASE_URL`. The domestic default
is `https://api.minimax.cn/v1`, calling `/v1/responses` with Bearer authentication.
The international endpoint is `https://api.minimax.io/v1` and requires the
corresponding account's key. Set the endpoint explicitly for that account.
`MINIMAX_ANTHROPIC_BASE_URL` and `ANTHROPIC_*` are not read. Migrate an old Messages
endpoint to the relevant region's Responses base URL; changing only the variable
name while retaining `/anthropic` is insufficient and produces a migration error.
Unknown custom model IDs advertise text input only and use a conservative 4,096
output-token request allowance until their metadata is registered; they do not
inherit M3 image support, context limits, reasoning capabilities or prices.

Verified on 2026-10-07 using the official [domestic Responses schema](https://platform.minimaxi.com/docs/api-reference/responses-create.md)
and [international Responses schema](https://platform.minimax.io/docs/api-reference/responses-create.md).
The domestic documentation still uses the `platform.minimaxi.com` documentation
site, but its current OpenAPI `servers` entry is `https://api.minimax.cn`.
Supported requests include full history, image content, function calls/results,
`max_output_tokens`, and standard/priority service admission. The adapter sends
only supported fields; no Anthropic `thinking`, OpenAI encrypted-state `include`,
Codex assistant `phase`, or undocumented `strict` tool field is added. Returned
`reasoning_text` content is preserved and mapped to documented `summary_text`
input for the same provider/endpoint/credential. Continuation items from other
connections are filtered by the shared transport.

Reference prices remain [CN pricing](https://platform.minimax.cn/docs/guides/pricing-paygo)
CNY standard-tier rates for inputs up to 512K; longer inputs cost 2x, priority
costs 1.5x. An endpoint override does not automatically switch price metadata to
[international pricing](https://platform.minimax.io/docs/guides/pricing-paygo).

Run `bun test packages/providers/src/vendors/minimax` after changing request
options, then repository-wide test/typecheck/smoke gates. Fake transports cover
Bearer auth, environment isolation, reasoning controls, streaming tool calls,
image input, continuation replay and cancellation. No paid probe is required.
