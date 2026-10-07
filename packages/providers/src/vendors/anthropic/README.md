# Anthropic

Owner boundary: this directory defines the official Claude API connection and model catalog. Shared Messages encoding/streaming lives in the protocol adapter. Authentication uses `ANTHROPIC_API_KEY`; optional `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` override the endpoint and model. This is API-key access, not a Claude subscription login. MiniMax credentials are separate.

Verified against official docs on **2026-10-07**:

- [Model overview](https://platform.claude.com/docs/en/models/overview): current public coding lineup; Opus 5.5 is the default, with Sonnet 5.5, Fable 5.1 and the dated Haiku 4.5 ID also registered.
- [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview), [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/overview), [Haiku 4.5](https://platform.claude.com/docs/en/models/haiku-4-5/overview): limits, supported inputs, and model IDs.
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing): catalog prices are USD per million tokens for the standard Claude API. Cache writes use the 5-minute rate, with 1-hour rates in notes. Batch, Fast Mode, regional platforms and account discounts are not calculated.
- [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), [manual extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking): latest adaptive models accept low/medium/high/xhigh/max; their catalog does not offer fully disabled thinking. Haiku uses Chili's low/medium/high budget mapping of 1,024/4,096/16,384 tokens, always below the requested output limit. New adaptive models omit unsupported sampling temperatures. Haiku's enabled thinking normalizes temperature to 1.
- [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking): signed thinking and redacted blocks are opaque continuation state and replay unchanged. Official Anthropic output is never replayed to another vendor. Latest Claude models use the documented binding-control beta with `prefix_mismatch_behavior: "drop_block"`, so context compaction, edited tools or changed system instructions can drop invalid thinking rather than fail the request. Model/account compatibility remains the API's decision; a model switch does not guarantee reasoning continuity. Drop diagnostics are not currently surfaced separately in Chili.

The normal text/reasoning display parts are distinct from the opaque `reasoning_item`: only the signed item is replayed as a thinking block. Unsigned or unfinished blocks cannot become continuation state. Current default Claude responses can contain empty thinking text with a nonempty signature; that signature must still survive tool loops and session restoration. Display beta options and Sonnet's `between_tools` mode are not enabled by default.

When updating, verify each model's thinking mode and supported effort levels independently; never assume that a new Claude accepts MiniMax's fields or Haiku's manual token budget. Do not infer capabilities/pricing for custom model IDs. Confirm auth headers, image/tool formatting, signed/omitted/redacted continuation, incomplete streams and cancellation with fake transports:

```sh
bun test packages/providers/src/vendors/anthropic/provider.test.ts
```

Run the repository's complete test, typecheck and smoke gates before submitting. Live paid requests were not used for these checks.
