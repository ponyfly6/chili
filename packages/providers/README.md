# Provider execution contract

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
