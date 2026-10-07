# Zhipu / Z.ai

This directory groups the vendor's separate regional services. Existing
`models.ts`, `config.ts` and `provider.ts` own the **international `zai` provider**.
Its identity, `ZAI_*` environment variables, prices and endpoints are preserved.
The domestic connection has independent `domestic-*` files, provider identity,
credentials, endpoints and price metadata; do not mix credentials across them.

The international default is `glm-5.3` at `https://api.z.ai/api/paas/v4`.
`glm-5.3-flash` and `glm-5.3-flashx` add image input. The explicit
`glm-5.3[1m]` entry uses the international Messages-compatible endpoint.
FlashX was excluded from Coding Plan at the last verification.

International catalog last verified 2026-10-07 against the
[Flash / FlashX guide](https://docs.z.ai/guides/vlm/glm-5.3-flash) and
[pricing](https://docs.z.ai/guides/overview/pricing). Prices are USD; cached-input
storage is temporarily free, not permanently guaranteed. Preserve reasoning
continuation and the 5.3 tool-stream contract when changing models.

Run `bun test packages/providers/src/vendors/zhipu packages/providers/src/catalog-update.test.ts`
after updating either region, then run repository-wide gates. Do not change the
existing `zai` endpoint as a migration shortcut. Tests use fake transports.

## Responses support and account boundaries

Verified 2026-10-07: both regions document a dedicated Responses endpoint.
Explicitly configuring `ZAI_BASE_URL=https://api.z.ai/api/v1` or
`ZHIPU_BASE_URL=https://open.bigmodel.cn/api/v1` selects Responses automatically;
the complete `/responses` URL also works. A custom gateway must explicitly end
in `/responses`; a generic gateway `/v1` URL is not enough to infer its protocol.
The configured provider catalog reports the selected protocol as well.

The unconfigured connection continues to use the ordinary Chat Completions API.
This is an account/product boundary, not a claim that GLM lacks Responses:

- International Z.ai documents `/api/v1` under its [Coding Plan integration](https://docs.z.ai/devpack/tool/others)
  and [Codex setup](https://docs.z.ai/devpack/tool/codex). The model page also lists
  Responses, but ordinary pay-as-you-go eligibility is not sufficiently clear to
  silently migrate every existing key. Plan credentials, including distinct team
  keys, must be configured for the intended account product.
- Domestic BigModel documents a [general Responses API](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction)
  and [Coding Plan endpoint](https://docs.bigmodel.cn/cn/coding-plan/tool/codex).
  Its [GLM-5.3 model page](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)
  says accounts that have ever subscribed to Coding Plan, including expired
  subscriptions, currently must use Chat Completions for ordinary model API
  calls. Chili cannot determine that history from an opaque API key.

For an eligible account/product, the recommended configuration is the region's
Responses URL above. Existing ordinary API and explicit Chat/Messages endpoints
retain their routes. Requests never fall back to a different billing endpoint
after an error. Endpoint selection does not certify model entitlement; FlashX
remains unavailable in Coding Plan as of this verification.
The `glm-5.3[1m]` Messages-only alias is excluded from a Responses connection's
catalog and rejected there; use `glm-5.3`, whose 1M context is already declared.

`responses.ts` owns the GLM wire fields. It sends local conversation history
with `store=false`, uses `max_output_tokens` and `reasoning.effort`, and omits
Codex-only fields. GLM-5.3 reasoning levels follow the current model and Codex
guides (`low` / `high` / `max`); an older generic Responses effort description
conflicts with those model-specific guides. Tool results retain call IDs;
plain reasoning items replay only on the original provider, endpoint and
credential scope. The shared parser accepts a terminal response event without
`[DONE]`, including GLM's object-shaped reasoning content. Cancellation stops
the local request; BigModel does not document a remote Responses cancel API.

See the [official Responses schema](https://docs.bigmodel.cn/openapi/openapi-responses.json)
for wire shapes. The fixture tests verify protocol behavior, not live key
eligibility or paid service availability.
