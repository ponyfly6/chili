# Alibaba Qwen

Maintained as a vendor module. Verified against official documentation on **2026-10-07**.

- `models.ts`: Qwen 3.8 Max (default), Max 0902 snapshot and Flash; text/image input, tools, 1,000,000-token context and 131,072-token output ceiling. Chili does not expose the models' video input capability.
- `config.ts`: provider `alibaba`; aliases `qwen`, `dashscope`, `aliyun`. Credentials: `DASHSCOPE_API_KEY` then `ALIBABA_API_KEY`. Endpoint/model overrides use the corresponding `*_BASE_URL` / `*_MODEL` variables. Other vendors' credentials are not used.
- `provider.ts`: connection and model construction. Unknown model names retain their identity but receive no inferred image, context, price or reasoning capabilities. The default request allowance for unknown models is 4,096 tokens. Register an explicit descriptor with `registerKnownModels` or supply factory compatibility/input capabilities for custom deployments.

The default endpoint is Beijing's `https://dashscope.aliyuncs.com/compatible-mode/v1`. Alibaba still supports it, while recommending workspace-specific domains. Set `DASHSCOPE_BASE_URL` to the workspace/regional URL from your console. Endpoint, region and key must match. Subscription plans may use a different endpoint/key and model allowlist; Chili does not turn a pay-as-you-go key into a subscription connection.

Qwen 3.8 uses `enable_thinking` and `reasoning_effort` (`low`, `medium`, `xhigh`); `off` disables thinking. Requests use `max_completion_tokens`, which includes reasoning and answer. The adapter returns previous reasoning in `reasoning_content`, separately from the answer, with `preserve_thinking: true`. It never sends an additional `thinking_budget`. A streamed function call can arrive as a complete argument payload; optional modality-dependent `tool_stream` is not enabled.

Catalog prices are Beijing standard CNY per million tokens. `cacheRead` is implicit caching; `cacheWrite` is explicit creation. Explicit reads, regional rates, subscriptions and discounts can differ. These are reference prices, not a billing calculator.

Official references:

- [Qwen 3.8 Max and snapshot](https://help.aliyun.com/zh/model-studio/qwen3-8-max)
- [Qwen 3.8 Flash](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)
- [Chat Completions contract, reasoning and endpoint migration](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)

When updating, verify exact IDs, regional access and wire parameters, edit this directory, then run `bun test packages/providers/src/vendors/alibaba` and the repository gates. All tests use fake transports; passing tests do not establish account access to a live model.
