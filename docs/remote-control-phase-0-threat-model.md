# Remote Control Foundation Phase 0 threat model

## Status and scope

Phase 0 is an executable security model for one vertical slice:

```text
fake mobile client -> in-memory relay -> host bridge
                   -> mocked host-neutral control service
```

It establishes the security boundaries that later transports and user interfaces
must preserve. It is not a production remote-access feature. The in-memory relay
is treated as if it were an untrusted network service even though every Phase 0
component runs in one test process.

Pairing in Phase 0 is an explicit trusted direct/out-of-band bootstrap API. The
credential and channel key returned by that API never travel through the relay
during pairing. Phase 0 does **not** claim to implement a relay-safe remote
pairing ceremony; a production invitation transport and confirmation UX are
separate work.

The only remotely reachable host-neutral operations are:

| Operation | Required capability | Meaning |
| --- | --- | --- |
| `sessions.list` | `sessions.read` | List the bounded, remote-safe session projection. |
| `session.snapshot` | `sessions.read` | Read one bounded, remote-safe session snapshot. |
| `session.send` | `sessions.send` | Submit one bounded prompt to a session. |
| `session.stop` | `sessions.stop` | Stop one session. |

The host bridge, not the client, derives the required capability from the
operation. The capability declared in a request must exactly match that derived
value. Capability grants are a closed allowlist; there are no wildcards,
implicit inheritance, or client-selected scope expansion.

## Security objectives

Phase 0 must provide the following properties:

1. A host can distinguish devices by cryptographic identity, not by a
   caller-chosen display name.
2. Pairing authority is short-lived, single-use, and cannot be converted into a
   broader grant than the host offered.
3. A device credential is high-entropy, stored by the host only as a hash, has a
   mandatory expiry, can be revoked immediately, and is checked again when a
   queued message eventually reaches the host.
4. Every control request is authenticated, bound to its device, host route,
   protocol version, operation, capability, and sequence, and confidential from
   the relay.
5. A request executes at most once. Duplicate, replayed, stale, out-of-order,
   forged, expired, revoked, and out-of-scope requests fail closed.
6. ACK and resync make loss or ordering gaps explicit. Reconnecting a transport
   does not reset replay state or grant a new security identity.
7. All untrusted inputs, messages, and queues have count and byte limits. No
   control path is allowed an unbounded allocation or backlog.
8. Provider secrets, sidecar credentials, remote-control credentials, private
   keys, prompts, runtime output, workspace data, and control payloads never
   enter the relay in plaintext or in relay diagnostics.

The design does not promise availability against a malicious relay. It promises
that relay behavior cannot silently turn into host authority or duplicate an
already accepted control action.

## Assets

- Host control authority: the ability to read session state, submit work, or
  stop work.
- Device private keys, raw AEAD channel keys, raw device credentials, pairing
  nonces, credential salts, and credential-verifier records.
- Session prompts, messages, tool output, approval or input content, workspace
  names and paths, and any future remote-safe projection of runtime state.
- Existing Chili provider OAuth tokens, API keys, local sidecar bearer tokens,
  `.env.local`, `~/.chili/auth.json`, and other local credentials. Remote control
  never needs these values and must not copy them.
- Authorization metadata: device identity, granted capabilities, expiry,
  revocation state, and the last accepted sequence for each authenticated
  stream.
- Integrity and availability of host control, relay queues, ACK state, and
  resynchronization state.

## Trust boundaries and data flow

### Fake mobile client

The client owns an Ed25519 device key pair plus the independent channel key and
raw device credential returned by pairing. `deviceId` is the SHA-256 digest of
the canonical SPKI public-key encoding and is bound by the pairing transcript;
a display label is only presentation metadata. Possession of a copied
credential alone must not let an attacker substitute a different device
identity, although theft of the complete client secrets can impersonate the
already-bound device until revocation or expiry.

The client protects the complete protocol envelope before relay submission.
Capabilities, sequence, ACK, resync state, credential material, operation names,
session identifiers, and payloads are all inside the authenticated encrypted
body. Cleartext convenience fields are never authoritative.

### In-memory relay

The relay is outside the trust boundary. It is an opaque, bounded mailbox, not
an authenticator, authorization server, protocol parser, credential store, or
audit log. It may observe only the minimum routing metadata required by the
Phase 0 model:

- one random, replaceable `routeId` channel alias for the host route, a random
  transport `messageId`, and direction;
- `createdAt`, ciphertext byte length, connection presence, and bounded queue
  counts.

It must not receive pairing nonces, credentials or credential hashes, public-key
proofs, stable `deviceId`/host identity, capabilities, sequence/ACK/resync values,
operations, session IDs, or control payloads in plaintext. Its
snapshot/diagnostic surface exposes only aggregate counts and configured limits,
never route IDs, ciphertext, payloads, or secrets. A relay-visible `routeId` is
replaceable mailbox metadata, not proof of identity.

The relay is allowed to drop, delay, duplicate, reorder, replay, or modify
ciphertext. End-to-end authentication, sequence checks, and resync at the host
must turn those behaviors into explicit failure or recovery, never execution of
an unauthenticated action.

Relay `createdAt`, direction, IDs, and byte counts are untrusted transport data.
In particular, host expiry and freshness decisions use the host clock and the
authenticated inner sequence, never the relay timestamp.

### Host bridge

The host bridge is the remote trust terminator. A random `routeId` selects a
host-held, independent random AEAD channel root; the route is only a lookup and
confers no authority. In this order, the bridge bounds the outer frame, decrypts
and authenticates it, parses and validates the inner envelope, verifies the raw
inner credential against its salted host verifier and host/device/route binding,
checks expiry and revocation, derives and enforces capability, applies
replay/sequence rules, and only then calls the control service.

The bridge must not forward a raw credential, device private material, relay
handle, unvalidated envelope, or client-supplied authorization decision to the
control service. Errors crossing back to the device are stable, bounded, and
credential-redacted.

### Mocked host-neutral control service

The mocked service is trusted to perform only the four typed operations above.
It contains no Electron, renderer, sidecar HTTP, filesystem, or process coupling.
It is deliberately a narrow substitution boundary for a later adapter to the
desktop control service. Calls recorded by the mock are the Phase 0 evidence
that invalid requests did not reach host authority.

### Trusted computing base and assumptions

Phase 0 assumes that the host process, client process, cryptographic random
number generator, hash and authenticated-encryption primitives, and local clock
used for expiry checks behave correctly. It does not assume the relay, delivery
order, reconnect timing, cleartext routing metadata, or any client-provided
authorization field is honest.

## Adversaries

- An unauthenticated remote attacker able to submit arbitrary relay frames and
  choose all relay-visible routing fields.
- A passive observer or compromised relay able to retain traffic and metadata.
- An active relay able to modify, inject, replay, reorder, delay, duplicate, or
  selectively drop messages and connection events.
- A formerly paired device whose credential is expired or revoked.
- A paired device with a deliberately narrow capability grant attempting a
  different operation or claiming a different capability.
- Two clients racing the same pairing invitation or sequence number.
- A client sending malformed, deeply nested, oversized, or high-volume input to
  exhaust memory, queue capacity, parsing time, or host-service admission.
- A confused-deputy attempt that mixes a valid credential with another device,
  host, route, session, operation, message, or protocol version.

A fully compromised authorized device can exercise its currently granted scope
until the host revokes or the credential expires. Preventing that endpoint from
reading its own screen or using its valid grant is outside this model.

## Pairing and credential lifecycle

### Device identity

Each client creates a fresh Ed25519 device key pair. Its stable `deviceId` is the
SHA-256 digest of the canonical SPKI public-key bytes. Pairing proof must
demonstrate possession of the matching private key over a domain-separated
transcript containing at least:

- pairing domain and protocol version;
- stable inner `hostId`, canonical device public key / `deviceId`, and random
  `routeId`;
- one-time nonce and exact granted capability set;
- challenge issue and expiry times.

The host rejects an unsupported algorithm, malformed key, identity/key mismatch,
invalid proof, altered transcript, or proof bound to a different host or route.
The `grantedCapabilities` input is an exact host-approved offer, not a surface on
which the remote device may request arbitrary authority.

### One-time pairing nonce

The host creates a cryptographically random 32-byte nonce with a short mandatory
TTL. Only its SHA-256 hash is retained. The raw value is returned once through
the explicit direct/out-of-band pairing invitation and must not be logged or
sent through the relay.

Consumption is atomic. One successful exchange tombstones the nonce in the same
synchronous commit that publishes its credential and channel. A second
exchange, a race loser, a nonce past its expiry,
or a nonce presented for another host/route fails. An invalid signature does not
issue a credential, but it consumes one of at most five proof attempts; an
exhausted invitation fails closed. The authority also caps outstanding
challenges at 128 and gives each a two-minute default TTL, credential records at
256, and active channel records at 128. Capacity failure does not create a
partially issued grant. Deleting or restarting in-memory Phase 0 state
invalidates outstanding invitations; it does not silently recreate them.

The invitation is a bearer bootstrap secret. Theft of the raw invitation before
use can win the pairing race; the intended mitigation is a trusted out-of-band
display and user verification, not the relay.

### Device credential

After successful pairing, the host generates a bearer token containing a
16-byte random lookup ID and independent 32-byte random secret, plus an
independent random 32-byte channel root key. It returns both once in the trusted
direct pairing result. Domain-separated HKDF-SHA256 binds `hostId`, `routeId`,
and direction to derive separate device-to-host and host-to-device AES-256-GCM
keys from that root; one direction's key cannot authenticate traffic in the
other direction. The host stores the root as secret key material and stores only
a random credential salt plus `SHA-256(salt || complete token)`, never the raw
bearer token. The authorization record also contains:

- non-secret credential lookup ID and bound `deviceId`;
- bound stable inner `hostId` and `routeId`;
- the exact capability allowlist;
- creation and mandatory expiry timestamps;
- revocation state and time.

The credential record does not separately store a protocol version. Version
binding is enforced by the signed pairing transcript, AEAD AAD, and strict frame
parser, which accepts only `REMOTE_CONTROL_PROTOCOL_VERSION = 1`.

The default credential lifetime is 24 hours. Associated bridge state, kept
outside the credential record, retains the accepted sequence needed to prevent
reconnect from resetting replay protection.

The verifier hashes the salt and complete token, including its lookup ID and
256-bit secret; lookup by the non-secret ID alone grants nothing. Credential
comparisons are over canonical encodings and use a constant-time comparison.
Raw credentials and channel keys never appear in relay state,
snapshots, thrown errors, logs, test names, or persisted fixtures. The salt
separates equal verifier values across records; hashing remains safe against
offline guessing because the credential is independently generated with enough
entropy. A user-selected password is not an acceptable credential.

Expiry and revocation are host decisions checked on every delivered request,
not just at connection time. Revocation is terminal for that credential. It
invalidates future frames, frames already queued at the relay, reconnects, and
resync attempts. Re-pairing creates a new credential and new replay namespace;
it never un-revokes or resets the old record.

## Message integrity, replay protection, ACK, and resync

AES-256-GCM protects the inner envelope. Its authenticated material binds all
security-relevant values, including protocol version, device identity,
credential reference/material, route and direction, message ID, sequence,
operation, declared capability, and payload. Any altered value makes
authentication fail. `REMOTE_CONTROL_PROTOCOL_VERSION` is `1`; another version
is rejected rather than guessed or silently downgraded.

Each sealing operation uses a fresh nonce under its direction-specific key;
AES-GCM nonce reuse is forbidden. The channel root and credential are
deliberately separate: the relay-visible route can select candidate decryption
context, but neither the route nor successful decryption replaces inner
credential, identity, expiry, revocation, capability, and replay checks.

The sealed byte layout is a 12-byte random nonce, ciphertext, and 16-byte GCM
tag. A domain-separated AAD encoding authenticates inner `hostId` plus outer
version, `routeId`, direction, `messageId`, `byteLength`, and `createdAt`; the
tag authenticates every inner field as ciphertext. The helper caps plaintext at
65,536 bytes and the complete ciphertext at 70,000 bytes, leaving room for the
28 bytes of GCM nonce/tag overhead rather than trusting a caller's declared
length.

The validated request frame contains `version`, `type: "request"`, protected
`hostId` and `deviceId`, `sessionId`, raw inner `credential`, positive
`sequence`, `requestId`, `capability`, `operation`, and an operation-specific
strictly validated payload. ACK, result, and error frames echo the authenticated
`hostId`, `sessionId`, `sequence`, and `requestId`. A resync frame also carries
`expectedSequence` and a bounded reason. None of these fields is relay-visible.

Every error frame carries an authenticated `admitted` bit. `admitted: true`
means the bridge already committed the sequence: it is terminal admission
evidence even if the separate ACK was lost, must have `retryable: false`,
advances the client high-water mark, and can never authorize retransmission.
`admitted: false` means the sequence remains unconsumed. A retryable unadmitted
error retains that exact request/sequence for at most one fresh-envelope retry
per explicit reconnect; the stop-and-wait client does not pipeline a higher
sequence past that head. A non-retryable unadmitted error terminates the
credential-bound stream and clears pending requests rather than silently
skipping the unconsumed sequence. Stale/future errors and any error that tries
to retract an earlier ACK are rejected before client state changes.

The first valid request for a credential binds that credential to exactly one
control `sessionId`. The host then retains one accepted-sequence high-water mark
for the bound credential/device/host/route/session tuple. A different
client-chosen `sessionId` is rejected; it does not create another replay window.
This state is independent of the relay connection object:

- exactly `lastAccepted + 1` may execute;
- `sequence <= lastAccepted` is a duplicate/replay and never executes again;
- `sequence > lastAccepted + 1` is a gap and never executes; the bridge returns
  a bounded resync response containing the expected next sequence;
- authorization failures do not advance sequence state;
- once an authorized request is admitted for service invocation, its sequence
  is consumed before or atomically with dispatch, so a service failure cannot
  make a possibly side-effecting request replayable;
- an ACK identifies admission and the consumed sequence; a result or bounded
  error identifies the execution outcome;
- an ACK is evidence of host admission, not merely relay delivery and not by
  itself evidence of a successful service outcome.

Each explicit client reconnect may resend the earliest unsettled request once,
using a fresh envelope and the original request/sequence. A historical relay
`queued` receipt cannot suppress this retry: the relay may have drained the
ciphertext before the bridge disconnected without admitting it. If the original
is still queued or the host already accepted it, sequence replay protection
prevents a second service invocation. An authenticated resync proves admission
and the host's expected sequence, but cannot reconstruct a lost result or prove
the service outcome. The fake client records a bounded `outcome_unknown`, stops retrying that
request, and requires its caller to explicitly fetch fresh remote-safe state; it
does not fetch a snapshot automatically. Stale ACK or resync frames are
themselves authenticated and cannot move a client across credential, device,
host, or stream boundaries.

Relay reconnect replaces the old connection for the same route and drains the
existing bounded queue in FIFO order. It creates neither a new device identity
nor a new replay window. A disconnected destination cannot accept live traffic;
only the relay's bounded opaque queue may hold frames for later delivery.

A supplemental connection-local `RelayReplayGuard` remembers at most 4,096
authenticated `(routeId, direction, messageId)` values and fails closed when
full. Reconnect may replace that transport-local guard, but the authoritative
credential/session sequence high-water mark above remains and still rejects old
or duplicated control requests.

## Capability boundary

Authorization is per credential and defaults to deny. The client must declare
one capability, and the host independently maps the operation to the required
capability. The bridge rejects all of the following before service invocation:

- missing, unknown, duplicated, wildcard, or malformed capability values;
- a valid capability that is not present in the credential grant;
- a declared capability that differs from the host-derived requirement;
- an unknown operation, even if the device holds every currently defined grant;
- attempts to put scope, expiry, revocation, identity, or sequence overrides in
  the operation payload.

The `sessions.read`, `sessions.send`, and `sessions.stop` grants are intentionally
separate. A read-only device cannot submit or stop work; a send-only device does
not gain session state; and reserving `sessions.stop` as its own scope prevents
prompt authority from silently becoming cancellation authority.

## Resource limits and denial of service

All configured limits are finite, positive integers and are enforced on UTF-8
or ciphertext bytes, not JavaScript string length. The implementation exports
one shared limit contract used by the client, relay, bridge, validators, and
tests rather than relying on inconsistent magic numbers.

The Phase 0 defaults in `REMOTE_CONTROL_LIMITS` are:

| Limit | Value | Boundary protected |
| --- | ---: | --- |
| `maxFrameBytes` | 65,536 | Decoded UTF-8 protocol frame. |
| `maxCiphertextBytes` | 70,000 | Complete opaque ciphertext presented to the relay. |
| `maxQueueMessages` | 64 | Messages across a complete retaining queue / the relay's global offline backlog. |
| `maxQueueBytes` | 1,048,576 | Bytes across a complete retaining queue / the relay's global offline backlog. |
| `maxIdentifierChars` | 128 | Session, request, message, and device identifiers. |
| `maxRouteIdBytes` | 128 | Relay-visible random route alias. |
| `maxCredentialChars` | 512 | Canonically encoded inner credential. |
| `maxPromptBytes` | 32,768 | UTF-8 prompt text. |
| `maxQueryBytes` | 512 | UTF-8 session-list query. |
| `maxErrorMessageChars` | 256 | One bounded, single-line protocol error. |
| `maxJsonDepth` | 16 | Nested result/frame JSON depth. |
| `maxJsonEntries` | 1,024 | Aggregate result/frame JSON entries. |
| `maxSequence` | 2,147,483,647 | Highest request sequence before exhaustion fails closed. |

Tests may inject smaller positive queue limits to exercise boundaries without
large fixtures; production code paths default to the shared values above.
The relay additionally derives per-route defaults of 16 queued messages and
262,144 ciphertext bytes, so one offline route cannot consume the global
backlog, and permits at most 128 distinct connected routes in each of its host
and device endpoint maps. The host bridge independently admits at most 64
pending ciphertexts / 1,048,576 pending bytes, retains at most 128 credential
stream high-water marks, and bounds its connection-local envelope-ID cache at
4,096 entries.

At minimum, Phase 0 enforces:

- `maxMessageBytes` on every opaque relay message before enqueue or delivery;
- independent `maxQueuedMessages` / `maxQueuedBytes` global budgets and
  `maxQueuedMessagesPerRoute` / `maxQueuedBytesPerRoute` budgets for every
  disconnected destination route;
- `maxConnectionsPerEndpoint` before adding another distinct host or device
  route (reconnecting an existing route replaces its old connection);
- a bound on decoded inner-envelope bytes, nesting, collection sizes, string
  sizes, and operation payloads before control-service invocation;
- a bounded number of outstanding client requests and retained ACK/resync
  records;
- bounded identifiers, error codes, and error messages.

At `maxSequence` the stream fails closed. A client-selected `sessionId`,
reconnect, numeric overflow, or wrap to sequence one never creates a fresh
replay namespace; Phase 0 requires re-pairing for a host-authorized new
credential/security namespace before admission can resume.

Queue admission is atomic: if either the next per-route or global count/byte
total would exceed its limit, the new message is rejected and every prior FIFO
is unchanged. An oversized message is never partially queued. Reconnect drains
only the already admitted route FIFO and decrements the route and global budgets
consistently. Disconnecting, replacing, or failing a connection cannot clone a
queued frame.

Before `connectHost` can synchronously hand off an offline route backlog, the
bridge requires the relay to declare positive message, per-route count, and
per-route byte limits. It refuses connection unless all three fit the bridge's
remaining message/pending budgets. An incompatible bridge therefore fails
before taking ownership and leaves the relay FIFO intact for a compatible
bridge, rather than partially draining or silently dropping it.

The relay verifies that declared ciphertext `byteLength` exactly matches its
owned byte array before accounting it; an attacker cannot under-report size to
evade either budget.

Size checks occur before expensive decode, cryptographic work where the format
allows, logging, or allocation proportional to attacker-declared lengths.
Malformed and over-limit input uses stable failure codes and never echoes the
input. These controls bound individual and queued work but are not a substitute
for production rate limiting, tenant quotas, or network-level abuse controls.

## Sensitive-information policy

| Classification | Examples | Relay handling |
| --- | --- | --- |
| Secret | Device private key, AEAD channel key, raw pairing nonce, raw device credential, provider/API/OAuth/sidecar credentials | Never relay-visible and never present in errors, snapshots, logs, or test diagnostics. The direct pairing flow carries its nonce and issuance result; later protected opaque bodies may carry only the minimum device credential end to end. |
| Sensitive control data | Capabilities, sequence/ACK/resync, operations, session IDs, prompts, snapshots, results, runtime/tool output, workspace names and paths | Authenticated encryption end to end; relay handles only opaque bounded bytes. |
| Pseudonymous routing metadata | Replaceable `routeId`, random transport `messageId`, direction, `createdAt` | Relay may use transiently for routing, but does not expose identifiers through snapshots or logs. Stable device and host identity remain protected. |
| Aggregate operational metadata | Ciphertext byte length, connected/disconnected state, queue count/bytes, configured limits | Relay may retain the minimum required for bounded operation and expose only aggregate diagnostics. |

Secret-canary tests must inspect relay queues, connection snapshots,
diagnostics, serialized errors, and observable envelopes. Merely asserting that
the relay does not parse a plaintext object is insufficient. Errors at every
boundary are redacted and bounded before crossing into the less-trusted side.

Authenticated encryption does not hide ciphertext length, connection timing,
direction, or the relationship between route aliases during their lifetime.
Those metadata leaks are an accepted Phase 0 residual risk.

## Adversarial evidence

The Phase 0 suite contains executable negative evidence, but it does not yet
implement every desirable hardening case. Current coverage is:

- `pairing-security.test.ts` proves canonical Ed25519 device identity and the
  signed host/device/route/scope transcript; rejects proof tampering, oversized
  presentations, expiry, replay, wrong key/host/direction, and scope or binding
  mismatches; and exercises proof-attempt, pending-pairing, credential-record,
  channel-record, ciphertext, and replay-guard caps.
- `protocol.test.ts` proves the exact four-operation/capability mapping, strict
  unknown-field and frame rejection, UTF-8 frame/prompt/query/identifier and
  bounded-JSON validation, ACK/resync and error-`admitted` invariants,
  queue-admission arithmetic, secret-free errors, and the absence of stable
  identity/credential fields from relay envelopes.
- `fake-mobile-client.test.ts` injects wrong-host/session/request correlation,
  tampering, replayed/duplicate/stale/future ACKs, forged/regressive/future
  resync, and stale/future errors without partial state changes. It proves that
  an admitted error is terminal ACK evidence, a retryable unadmitted error keeps
  the same sequence for one reconnect retry, a non-retryable unadmitted error
  terminates the stream without a hidden gap, and client snapshots remain
  secret-free.
- `host-bridge.test.ts` exercises pending message/byte admission, retained
  stream and envelope-ID bounds, authenticated malformed/unknown/oversized
  inner frames before service invocation, revocation linearization for a queued
  authorization, and compatibility checks that preserve then FIFO-drain a
  two-message offline backlog.
- `in-memory-relay.test.ts` proves global byte admission, host and device
  connection caps with safe same-route replacement, defensive byte ownership,
  bounded route identifiers, and exact three-message FIFO drain with counters
  returning to zero.
- `remote-control.integration.test.ts` proves the online vertical slice,
  offline reconnect, one-time pairing race, queued-before-revocation rejection,
  and relay opacity. Its recording services remain untouched by forged
  ciphertext, credentials, devices, hosts, scope escalation, sequence gaps,
  changed or re-encrypted replays, and client-selected session reset attempts.
- The integration suite serializes two concurrent requests for the same next
  sequence, preserves the credential high-water mark across reconnect, consumes
  sequence before a side-effecting service failure, and records bounded
  `outcome_unknown` when ACK arrives but a result is lost. Exact service-call
  counts prove that none of those recovery paths executes an admitted request
  twice.
- `queued-reconnect.integration.test.ts` uses the real relay, bridge, and client
  to interrupt a queued request after synchronous relay drain but before host
  admission. Both endpoint recovery orders complete the original sequence and
  permit the next request. Repeated explicit client reconnects while the original
  remains queued each add only one fresh envelope, and all copies together
  invoke the side-effecting operation exactly once.
- Relay integration additionally covers message size, per-route and global
  message/byte queues, reconnect replacement, and secret-canary-free aggregate
  diagnostics.

These tests are the Phase 0 evidence shipped by this slice. They should remain
when the in-memory relay or mocked service is replaced.

### Hardening test backlog

The following are explicit follow-up tests, not claims about current coverage:

- revoke one active credential while another device is active, then prove the
  other device's identity, grant, and sequence high-water mark are unchanged;
- drive a credential to `maxSequence`, then try reconnect, a different
  client-selected `sessionId`, and wrap-to-one before proving only re-pairing can
  create a new security namespace;
- send unknown operations and payload-carried authorization overrides through
  the bridge and assert an exact control-service call count of zero;
- exhaust each capability combination at the bridge boundary, including
  independent denial of missing `sessions.send` and `sessions.stop` grants.

## Residual risks and follow-up work

- A compromised host or authorized client endpoint can read plaintext and steal
  keys in its own process. Secure hardware/keychain storage and device posture
  are not modeled.
- The device credential and channel key are bearer secrets. Theft of the full
  client secret set lets an attacker impersonate that already-bound device
  within its grant until expiry or host revocation; pairing proof does not
  repair endpoint compromise.
- At-most-once applies to one authenticated control sequence. A legitimately
  authorized device can intentionally submit the same semantic operation again
  under the next sequence; future adapters may use the provided idempotency key
  for stronger downstream deduplication where needed.
- A malicious relay can deny service indefinitely and can perform traffic
  analysis using routing IDs, message sizes, direction, and timing.
- Relay connection counts are bounded, but the Phase 0 direct API does not
  authenticate route creation or provide tenant fairness. A public replacement
  still needs authenticated route admission, global/per-tenant quotas, and rate
  limits.
- An attacker who steals an unused pairing invitation can race the intended
  device. A production UX needs a trusted display, explicit device confirmation,
  and phishing-resistant human verification.
- The Phase 0 mock does not prove the later Electron/desktop adapter safely
  projects runtime data. That adapter needs its own schema validation,
  redaction, admission control, and approval semantics.
- In-memory credential and replay state is not durable across host restart.
  Production persistence needs atomic nonce consumption, revocation, sequence
  updates, rollback-resistant expiry semantics, secure storage, migration, and
  crash-consistency tests.
- Phase 0 has no per-record unpair/garbage-collection path for its 256
  credential records or 128 active channel records. Once either cap is reached,
  new pairing fails closed until the in-memory authority is restarted, which
  invalidates every existing grant.
- Production cryptographic protocol review, key rotation, algorithm agility,
  forward secrecy, clock rollback handling, rate limiting, auditing, abuse
  response, multi-tenant isolation, and recovery are future work.

## Explicit non-goals

Phase 0 does not build or integrate:

- a public or production relay, relay deployment, DNS, TLS termination, NAT
  traversal, push notifications, or cloud sync;
- PWA or mobile UI, a native iOS/Android client, background mobile execution, or
  app-store packaging;
- Electron IPC/preload integration, renderer changes, or Electron E2E coverage;
- changes to `App.tsx`, `control-service.ts`, `runtime-http.ts`, or
  `task-console-model.ts`;
- automatic discovery, multi-host orchestration, account recovery, sharing,
  capability administration UI, or a tray-resident daemon;
- broad refactoring of the desktop, server, runtime, SDK, or protocol packages.

The next integration step is a narrow adapter from the existing desktop control
service to the four host-neutral operations. It must preserve this document's
authentication, capability, replay, limits, and redaction boundary rather than
moving those decisions into the renderer or relay.
