# Provider execution contract

## Registration and configuration

`provider-definition.ts` owns built-in provider IDs, aliases, display names,
model-prefix inference, connection labels and default request output allowances.
Model capabilities, model defaults and wire compatibility remain in `models.ts`
and `compat.ts`. An output allowance is a request default, not a claim about a
custom model's context window.

`provider-registry.ts` connects every definition to one statically imported,
typed factory. Missing factories fail compilation; Host no longer guesses export
names or accepts structurally unknown provider modules. This is an internal
registration table, without dynamic plugin loading.

Host owns user selection (including CLI aliases/suffixes and the fake model),
profile binding and per-request overrides. It delegates provider construction
and reasoning/service-tier translation to `resolveProviderModelOptions` and
`createRegisteredProviderModel`. Resolution reads a snapshot of only the selected
provider's environment variables. Explicit connection/model options take
precedence over that snapshot, followed by the existing adapter/catalog defaults.
The adapters retain their public standalone factories and consume the same
snapshot when translating their protocol options. No second live environment
read can change the connection partway through constructing an attempt.

Environment credentials remain environment credentials: they are not converted
into explicit `apiKey` options that bypass provenance checks. In particular,
legacy ChatGPT OAuth tokens are still rejected by the `codex-api` adapter.
ChatGPT's OAuth-only endpoint rules, profile storage and just-before-dispatch
credential validation remain unchanged. Configuration resolution does not cache
OAuth tokens. Switching providers discards the previous provider's explicit
key, endpoint and custom headers; shared request controls remain available.

The Host bridge consumes the exported provider request/event types directly.
There is no event-name allowlist to silently discard a newly added provider
event; compatibility with Core's stream contract is checked by TypeScript.
Provider events still carry text/reasoning block completion and opaque protocol
continuation data, independently of user-visible reasoning persistence.

To add a built-in provider, register its definition and typed factory, its
environment names in `env.ts`, and its model descriptors/compatibility in
`models.ts`. Reuse an existing protocol adapter where appropriate. Host needs no
new factory, provider-name switch or environment parser. Public legacy factory
aliases remain available to existing callers.

`provider-registry.test.ts` exercises all registered factories with fake
transports, environment snapshots and credential-source validation. Host and CLI
tests cover model selection, protocol differences, request identity, deadlines
and connection isolation across per-turn model switches.

## Requests

The Responses, Chat Completions and Anthropic adapters share a total request
deadline and cancellation boundary. The default deadline is five minutes and
`ModelStreamInput.requestTimeoutMs` can override it. It includes authentication,
account backpressure, connection establishment and the complete response. SSE
also retains its existing idle deadline and completion checks. Consumer Stop or
early iterator return aborts the signal passed to the transport; an injected
transport that ignores abort cannot hold the consumer open indefinitely.

All three families use `ProviderBackpressureCoordinator`. Scope includes the
actual endpoint and credential fingerprint; ChatGPT uses its stable account ID,
so rotating an access token does not clear an account rate limit. Backpressure is
shared **within a process**, including sibling agents, and is not currently a
distributed rate limiter. Provider adapters do not retry model operations. Core
retains its conservative retry rule: no retry after assistant output or tool
activity has begun. Cancellation is not proof that a remote server stopped work.
OAuth credential-resolution errors explicitly veto this automatic model retry:
remote token rotation may already have occurred before a local timeout or failure.

Immediately before network dispatch, each adapter awaits `onRequestIdentity`
with the provider, model and credential version. OAuth adds the account ID;
API-key versions are SHA-256 fingerprints. Host adds its resolved profile ID and
runtime records this alongside the prepared request attempt, without credentials.
OAuth revalidates its selected credential after waiting for backpressure and
after identity recording. Logout before that check prevents dispatch; logout
after dispatch does not promise to recall work already accepted by the server.

## Profile and OAuth storage

Host supplies `new FileAuthStorage(defaultAuthPath(chiliHome))` to model routing
and catalog queries. An explicit profile path takes precedence over the global
`CHILI_AUTH_FILE`; the no-argument API retains the previous environment behavior.
Direct `OpenAICodexResponsesModel` construction also accepts `chiliHome` or an
explicit `authPath`/`authStorage`.

`auth.json` remains the credential source. Existing entries without `revision`
are readable and acquire an opaque revision on the next managed write. New
writes use mode 0600 and atomic replacement. The adjacent
`auth.json.coord.sqlite` contains only refresh ownership metadata, never tokens.
Short SQLite transactions serialize cooperating processes' read/modify/write
operations; lock contention waits asynchronously and is abortable for refresh,
and network I/O never holds that lock. Unrelated provider updates do not
overwrite one another.

Refresh is shared by consumers of the same profile/provider/credential version,
and a SQLite claim coordinates different processes. Its default deadline is
30 seconds (`authRefreshTimeoutMs` on the Codex model). One consumer cancelling
does not cancel other consumers; the last consumer cancelling aborts the refresh.
Dead process claims can be reclaimed. Expiry fences persistence and does not
assert that a remote OAuth operation stopped.

Refresh commits compare the credential revision, account and token snapshot as
well as the claim owner and deadline. Logout, account switching and re-login
advance or remove the version and invalidate outstanding claims immediately.
A late response cannot restore a logged-out account or overwrite a replacement.
Refresh responses cannot silently switch account identity. A crash after remote
token rotation but before local persistence can still require signing in again;
there is no claim of exactly-once remote token rotation. Writers bypassing
`FileAuthStorage` do not participate in its transaction/version guarantees.
Separate profile stores do not share refreshed secrets or refresh claims; copying
the same rotating refresh token into different profiles can still cause remote
rotation conflicts and is outside the shared-store coordination guarantee.

## Tool replay

The store's `callId` is Chili's internal invocation identity. Modern message
parts also carry `providerCallId`; adapters pair results using the internal ID
and serialize the provider ID. Histories without the new field retain the
legacy `callId` fallback. Provider-specific normalization remains a wire-format
operation and does not rewrite modern internal invocation identities. If an
external provider reused the same ID in multiple turns, replay deterministically
disambiguates later IDs and their matching results in its request copy; persisted
provider IDs remain unchanged.

## Regression evidence

`oauth-refresh.test.ts` uses temporary profiles, fake credentials and a loopback
token transport. It exercises two actual Bun processes, concurrent updates,
dead claim owners, per-consumer cancellation, deadlines, version changes and
legacy migration. `request-lifecycle.test.ts` verifies each protocol's transport
cancellation/deadline, sibling rate limiting and replay mapping. These tests do
not contact real providers or establish model task-solving quality.

The deprecated core `AnthropicCompatibleModelRouter` and MiniMax router factories
are compatibility wrappers around this implementation. They retain their
constructor options, MiniMax environment precedence and non-streaming request
default, and use the same provider-ID replay, request identity callback, deadline,
cancellation and backpressure. Tool results now use the common typed streaming
events even for a JSON response, preserving the provider call ID. Legacy rejected
iterator error shape is retained; public error fields follow the common provider
sanitization boundary rather than the old duplicated parser.

## Model catalog verification (2026-10-07)

The built-in catalog records supported API IDs, not every model a vendor has ever
released. This update preserves the existing GPT-6/GPT-5.6 catalog. Official
sources were checked directly because search snippets can lag the live API docs.

| Provider | Update and retained defaults | Official references |
| --- | --- | --- |
| DeepSeek | Add `deepseek-flash` (V4.1 Flash) with image input; the existing `deepseek-v4-flash` slug now has the same capabilities because it redirects server-side. Retain Pro as default (0813 revision). Both output limits are 393,216, not 384,000. | [Model metadata](https://api-docs.deepseek.com/api/list-models/), [pricing and aliases](https://api-docs.deepseek.com/quick_start/pricing/) |
| xAI | Default to `grok-4.7`; retain explicit `grok-4.6`. Both support images, 500K context and low/medium/high/xhigh reasoning. No vendor output cap is declared; Chili's 128,000 request allowance remains separate. Grok 4.7 Fast is not on the public API and is not added. | [September 21 release](https://docs.x.ai/developers/release-notes), [Grok 4.7](https://docs.x.ai/developers/grok-4-7) |
| Z.ai | Add `glm-5.3-flash` and `glm-5.3-flashx` with images, 1M context, 128K output and the 5.3 reasoning/tool-stream contract. Retain GLM-5.3 as default. FlashX is currently excluded from Coding Plan. | [Flash/FlashX API guide](https://docs.z.ai/guides/vlm/glm-5.3-flash), [pricing](https://docs.z.ai/guides/overview/pricing) |
| Kimi | Add `kimi-k2.7-code` and `kimi-k2.7-code-highspeed`, with images and 262,144 context. Thinking and preserved reasoning are always enabled; configurable effort is unsupported. Retain K3 as default. Use the current API reference's `max_completion_tokens`; the older quickstart still demonstrates deprecated `max_tokens`. | [Model list](https://platform.kimi.com/docs/models), [K2.7 guide](https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart), [Chat API](https://platform.kimi.com/docs/api/chat), [reasoning contract](https://platform.kimi.com/docs/guide/use-thinking-models) |
| MiniMax | Add `MiniMax-M3.1-Flash-Preview` as a clearly labeled M Plan selection, retaining M3 as default. Preview supports images, 1M context and adaptive thinking with `output_config.effort` low/medium/high/xhigh/max. Disabled thinking is invalid. No verified preview price or maximum output limit is invented. | [Anthropic API](https://platform.minimax.io/docs/api-reference/text-anthropic-api) |

`ModelCost` is reference metadata per million tokens, not a billing engine.
`currency` defaults to USD for existing entries; `notes` qualifies the endpoint,
tier and variable rates. Overriding an endpoint does not automatically convert
currencies or discover gateway prices. Subscription entitlements are not probed;
a configured credential in the catalog is not proof of access to every model.

- DeepSeek records peak USD rates; off-peak rates are half. The official schedule
  defines peak windows and public-holiday exceptions.
- Grok records standard rates below 200K prompt tokens; long-context rates double.
- MiniMax M3 now records [CN rates](https://platform.minimax.cn/docs/guides/pricing-paygo)
  matching its default endpoint: CNY 2.10 input / 8.40 output / 0.42 cache read.
  Inputs over 512K double these rates; priority multiplies them by 1.5.
  The [global endpoint](https://platform.minimax.io/docs/guides/pricing-paygo)
  instead lists USD 0.30 / 1.20 / 0.06 for standard short-context requests.
- [Kimi CN pricing](https://platform.kimi.com/docs/pricing/chat) is recorded in CNY.
  K3 includes the newly separate cache-write charge: 20 per million tokens at the
  default 5-minute TTL; the 1-hour TTL costs 40. K2.7's table does not list a
  separate cache-write charge. Chili does not enable a longer TTL in this update.
- Z.ai cache storage is currently free on a promotional basis, not a permanent
  promise. Flash and FlashX have separate input/output/cache-read prices.

Only modalities already represented by Chili's protocol (text and images) are
advertised, even when a vendor also accepts video or files. K2.7 and MiniMax
Preview output caps remain unspecified where no precise cap was verified;
request allowances are still bounded. Existing reasoning continuation data is
preserved. This change does not alter conversation persistence or model retries.

`catalog-update.test.ts` verifies selection through registered factories, image
serialization and text-only rejection, reasoning replay, K2.7's fixed parameters,
MiniMax Preview's per-request effort, and continued M3 behavior using fake
transports. It does not certify account entitlement or live provider performance.
