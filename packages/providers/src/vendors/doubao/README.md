# Doubao / Volcengine Ark

Maintained as a vendor module. Verified against official documentation on **2026-10-07**.

`models.ts` lists Seed 2.1 Pro/Lite (260915), Turbo (260628), and Seed Evolving. Pro is the default; Evolving is the rapidly updated Coding/Agent choice. The older Seed 2.0 Code Preview is being retired and is intentionally absent. Chili supports text/image, tool calls and reasoning; audio/video and Ark-hosted tools are outside this adapter.

Provider `doubao` has aliases `volcengine`, `ark`, `bytedance`. Credentials are `ARK_API_KEY`, then `DOUBAO_API_KEY`; endpoint/model overrides use corresponding `*_BASE_URL` / `*_MODEL` variables. The default endpoint is `https://ark.cn-beijing.volces.com/api/v3`, using Bearer API-key authentication and `/chat/completions`.

An account-specific `ep-*` endpoint ID can be passed unchanged as the model. It does **not** reveal its underlying model: unregistered IDs receive no inherited context, image, price or reasoning claims, no thinking parameters, and a conservative 4,096-token request allowance. They also do not save or replay Seed's encrypted continuation by default. Register a descriptor for that exact endpoint with `registerKnownModels`, using the capabilities and compatibility of its actual deployment, to enable image/reasoning handling. Factory options also accept explicit input capabilities and compatibility, such as `DOUBAO_SEED_COMPATIBILITY` for a confirmed Seed deployment. Switching an endpoint to a different model requires updating this metadata.

Seed thinking uses `thinking.type: enabled/disabled` and exposed effort levels `low`, `medium`, `high`; higher product levels map to `high`. Requests use `max_tokens`, limiting the **answer only**; thinking has a separate provider limit. A request's 65,536-token default is below the model's 262,144-token answer ceiling. Chili's total deadline and cancellation still apply.

Current Seed models return a reasoning summary plus opaque `encrypted_content`. The adapter saves the encrypted value through the existing `reasoning_item`/`modelOutput` path and replays it only to the same provider/model, separately from visible text. The SSE field is a complete value, not text fragments. This preserves multi-turn tool reasoning without interpreting encrypted content. Missing history cannot be reconstructed by the adapter; provider/model switches deliberately omit opaque values.

Prices are standard online non-audio CNY per million tokens. Cache storage is separately charged per hour; `cacheWrite: 0` does not mean storage is free. Flex, batch and subscription pricing differs. Model access must be enabled on the account.

Official references:

- [Model capabilities and limits](https://docs.volcengine.com/docs/82379/1553576?lang=zh)
- [Latest models](https://docs.volcengine.com/docs/ark/latest-model?lang=zh) and [retirements](https://docs.volcengine.com/docs/ark/model-deprecation-notice?lang=zh)
- [Chat API and encrypted continuation](https://docs.volcengine.com/docs/ark/chat-api?lang=zh&redirect=1)
- [Thinking](https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh) and [parameter support](https://docs.volcengine.com/docs/ark/model-parameter-support?lang=zh)
- [Standard pricing](https://docs.volcengine.com/docs/ark/model-pricing?lang=en&redirect=1)

When updating, verify the exact dated IDs and API behavior, edit this directory, run `bun test packages/providers/src/vendors/doubao` and the repository gates. Fake transport tests do not establish live account/model availability.
