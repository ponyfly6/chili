# OpenAI vendor maintenance

This directory owns OpenAI model metadata, connection modes, credentials and
vendor-specific request rules. It exposes three distinct provider IDs:

| Provider ID | Connection | Environment |
| --- | --- | --- |
| `openai` | Official OpenAI Responses API; API key; default `https://api.openai.com/v1` | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` |
| `openai-codex` | ChatGPT Codex; managed OAuth profile; fixed ChatGPT endpoint | Existing ChatGPT model settings; credentials stay in profile storage |
| `codex-api` | Explicit API key and custom endpoint for a Codex-compatible Responses gateway | `CODEX_API_KEY`, `CODEX_API_BASE_URL`, `CODEX_API_MODEL` |

Choosing a provider also chooses its connection contract. Official OpenAI does
not read Codex API credentials or ChatGPT access tokens, and does not send
ChatGPT account, originator or beta headers. Explicit official OpenAI options
precede its own environment variables. A custom base URL retains the official
Responses wire format; support for arbitrary gateways is not inferred.

The official API accepts assistant history without `phase`, accepts a missing
or null output phase, and preserves a supplied phase. ChatGPT Codex and Codex-compatible gateways retain their stricter
phase contract. Official API and gateway requests send `max_output_tokens`;
ChatGPT Codex keeps its existing request behavior.

All modes preserve finalized opaque reasoning items, tool call IDs and matching
tool results for stateless continuation. Opaque encrypted continuation data is
protocol state and is separate from displaying or retaining reasoning summaries.
New Responses continuation records also carry a top-level connection fingerprint.
Runtime replay requires the same provider, actual endpoint, and OAuth account or
effective API authorization. OAuth token refresh within one account preserves
continuation; changing an API key, endpoint, account or provider drops incompatible
ciphertext from the request while keeping visible text and tool history. Raw
provider items remain unchanged; source metadata contains no raw endpoint,
account ID or credential. Context snapshots preserve this source metadata.

History written before this scope existed remains replayable by the two existing
Codex modes for compatibility; its original connection cannot be verified.
Official `openai` does not adopt that unscoped ciphertext. Pure request-body
builders only convert message shapes; the credential-aware model runtime enforces
replay scope immediately before dispatch.

The common request lifecycle still controls deadlines, cancellation, backpressure
and sanitized errors. Adapters do not add automatic model retries.

## Model sources and scope

Responses request, streaming and replay contracts checked against official
documentation on 2026-10-07; no live account or entitlement probe was run.

`models.ts` owns the existing GPT-6/GPT-5.6 selections, aliases, capabilities and
reference costs. This vendor split preserves those selections. A model appearing
in Chili's catalog does not establish API availability or subscription entitlement
for an individual account. A configured gateway can expose different pricing and
limits; Chili does not discover or reinterpret them automatically.

Consult the official [model catalog](https://platform.openai.com/docs/models),
[Responses API reference](https://developers.openai.com/api/reference/responses/overview),
[response item schema](https://developers.openai.com/api/reference/resources/responses/methods/retrieve)
and [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) when
maintaining this vendor. Model releases and transport contracts must be checked
separately from ChatGPT subscription access. Record the source and verification
date beside future metadata changes; do not infer API facts from model names or
third-party gateway marketing.

## Updating this vendor

1. Update this directory's model descriptors and connection/request rules. Keep
   protocol-wide parsing and request lifecycle code in the shared layers.
2. Retain the three provider IDs and credential boundaries. Reusing a Responses
   transport does not make ChatGPT OAuth interchangeable with an API key.
3. Extend fake-transport tests for observable request and replay behavior. Keep
   the existing Codex OAuth/gateway tests when changing shared Responses code.
4. Run `bun test packages/providers/src`, then the repository gates `bun test`,
   `bun run typecheck` and `bun run smoke:all` before submitting.

`provider.test.ts` covers official bearer headers, connection/environment
isolation, output limits, request selection, optional phase, final encrypted
reasoning plus tool replay, cancellation and incomplete SSE. Tests use synthetic
keys and transports; they do not contact live accounts or read local credentials.
