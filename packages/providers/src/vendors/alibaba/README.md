# Alibaba Qwen

Maintained as a vendor module. Verified against official documentation on **2026-10-07**.

- `models.ts`: Qwen 3.8 Max (default), Max 0902 snapshot and Flash, all using **Responses**. Text/image input and function tools are supported. Chili does not expose video input.
- `config.ts`: provider `alibaba`; aliases `qwen`, `dashscope`, `aliyun`. Credentials: `DASHSCOPE_API_KEY` then `ALIBABA_API_KEY`. Endpoint/model overrides use corresponding `*_BASE_URL` / `*_MODEL` variables.
- `provider.ts`: connection and model construction; `request.ts`: Alibaba's documented request dialect. Transport, cancellation, parser and connection-scoped continuation are shared.

The default endpoint is `https://dashscope.aliyuncs.com/compatible-mode/v1/responses`. Alibaba still supports this Beijing domain while recommending workspace-specific regional domains. Keys and regions must match; subscription plans can use different endpoints and model allowlists. Configure either the API base URL or a complete `/responses` URL. A `/chat/completions` URL is rejected. There is no silent protocol fallback after an HTTP error.

Requests use `reasoning.effort` (`none`, `low`, `medium`, `xhigh`) and `max_output_tokens`, which counts both reasoning and answer for Qwen 3.8. `off` maps to `none`. The adapter sends `store: false` and reconstructs the full local history; it does not depend on `previous_response_id` or cloud conversation storage. Finished reasoning items containing their original IDs and summaries are preserved and returned on the same provider/connection. Tool results are placed directly after their matching calls. OpenAI-only fields, assistant phases, encrypted-content includes and Chat thinking fields are not sent.

The underlying models have 1,000,000-token windows. Alibaba documents that Responses admits approximately 80% as input and automatically truncates excess input. Chili conservatively advertises **800,000 tokens** for this route, leaving its normal output reservation inside that allowance. This is a planning ceiling rather than an exact server guarantee. Maximum model output is 131,072 tokens.

Unknown names also use Responses, with text-only validation, no inferred context/price/reasoning, and a 4,096-token default request. The deployment must support Responses. Register exact metadata with `registerKnownModels` or provide explicit factory input capabilities and Responses compatibility for a custom deployment. Old Chat opaque continuation is not converted into a different protocol; ordinary text and tool history remain replayable.

Prices are Beijing standard CNY per million tokens. `cacheRead` is implicit caching, `cacheWrite` is explicit creation; explicit reads, regions and subscription rates can differ. These are reference prices, not a billing calculator.

Official references:

- [Qwen 3.8 Max and snapshot](https://help.aliyun.com/zh/model-studio/qwen3-8-max)
- [Qwen 3.8 Flash](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)
- [Responses contract, supported models and input limit](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses)

When updating, verify exact IDs, regional access and request parameters, edit this directory, then run `bun test packages/providers/src/vendors/alibaba` and the repository gates. Tests use fake transports; passing tests do not establish live account access.
