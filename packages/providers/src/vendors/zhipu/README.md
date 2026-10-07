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
