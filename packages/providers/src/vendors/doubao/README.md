# Doubao / Volcengine Ark

Maintained as a vendor module. Verified against official documentation on **2026-10-07**.

`models.ts` lists Seed 2.1 Pro/Lite (260915), Turbo (260628), and Seed Evolving. Pro is the default; Evolving is the rapidly updated Coding/Agent choice. The older Seed 2.0 Code Preview is being retired and is intentionally absent. Chili supports text/image, tool calls and reasoning; audio/video and Ark-hosted tools are outside this adapter.

Provider `doubao` has aliases `volcengine`, `ark`, `bytedance`. Credentials are `ARK_API_KEY`, then `DOUBAO_API_KEY`; endpoint/model overrides use corresponding `*_BASE_URL` / `*_MODEL` variables. The default endpoint is `https://ark.cn-beijing.volces.com/api/v3`, using Bearer API-key authentication and **Responses API** at `/responses`. An explicit old `/chat/completions` override is converted to `/responses` under the same base path. Request errors do not trigger a protocol fallback.

An account-specific `ep-*` endpoint ID can be passed unchanged as the model. Its deployment must support Responses. The ID does **not** reveal its underlying model: unregistered IDs receive no inherited context, image, price or reasoning claims, no thinking parameters, and a conservative 4,096-token request allowance. Register a descriptor for that exact endpoint with `registerKnownModels`, using its actual capabilities and Responses compatibility, to enable image/reasoning handling. Factory options also accept explicit input capabilities and reasoning configuration. Switching a deployment to a different model requires updating its metadata.

Seed thinking uses `thinking.type: enabled/disabled` and `reasoning.effort` levels `low`, `medium`, `high`; higher product levels map to `high`. Responses requests use `max_output_tokens`, limiting the **answer and reasoning together**. The normal request allowance is 65,536 tokens. Chili's total deadline and cancellation still apply. Vendor code owns this body and does not send OpenAI-specific `reasoning.summary`, `text.verbosity`, `prompt_cache_key`, or `include` values.

Requests set `store: false` and replay history explicitly; they do not depend on Ark's hosted response retention or `previous_response_id`. Current Seed models emit public summary deltas and complete reasoning items containing opaque `encrypted_content`. Chili preserves the whole finalized item through `reasoning_item`/`modelOutput`, retaining the source connection fingerprint, and replays it before its tool call/result. The shared Responses runtime excludes incompatible provider/endpoint/credential/model histories and legacy items without source provenance. Binding continuation state to the requested model is a conservative Chili policy: the official documentation does not promise cross-model ciphertext portability. An `ep-*` deployment reassigned to another underlying model is not detectable from its ID and should use a new conversation or deployment ID. Completed items and terminal response output are supported; incomplete added items are not saved as final state. Missing history cannot be reconstructed by the adapter. Public documentation lists encrypted content on Responses output items directly; this integration does not assume OpenAI's `include: ["reasoning.encrypted_content"]` is accepted by Ark.

Prices are standard online non-audio CNY per million tokens. Cache storage is separately charged per hour; `cacheWrite: 0` does not mean storage is free. Flex, batch and subscription pricing differs. Model access must be enabled on the account.

Official references:

- [Model capabilities and limits](https://docs.volcengine.com/docs/82379/1553576?lang=zh)
- [Latest models](https://docs.volcengine.com/docs/ark/latest-model?lang=zh) and [retirements](https://docs.volcengine.com/docs/ark/model-deprecation-notice?lang=zh)
- [Responses request and output items](https://docs.volcengine.com/docs/ark/create-model-responses-api?lang=zh)
- [Responses usage and storage](https://docs.volcengine.com/docs/ark/responses-api-text-generation?lang=zh)
- [Responses lifecycle and encrypted output](https://docs.volcengine.com/docs/ark/response-lifecycle?lang=zh)
- [Reasoning streaming events](https://docs.volcengine.com/docs/ark/output-and-text?lang=zh)
- [Thinking](https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh) and [parameter support](https://docs.volcengine.com/docs/ark/model-parameter-support?lang=zh)
- [Standard pricing](https://docs.volcengine.com/docs/ark/model-pricing?lang=en&redirect=1)

When updating, verify the exact dated IDs and API behavior, edit this directory, run `bun test packages/providers/src/vendors/doubao` and the repository gates. Fake transport tests do not establish live account/model availability.
