# Chili Remote Control

The private mobile Alpha adds a production browser entrypoint and a private
HTTPS host while preserving the Phase 0 protocol:

```text
apps/control-web (browser WebCrypto + HTTPS)
  -> PrivateControlHttpsHost -> HostBridge
  -> DesktopRemoteControlAdapter -> the window's DesktopControlService
  -> real sidecar/runtime
```

`@chili/remote-control/browser` has no Node runtime imports. The root entrypoint
contains the Node HTTPS host. Desktop remote control is off by default; its local
panel issues a two-minute one-use code and requires confirmation before granting
read/send/stop capabilities. Credentials and replay state are memory-only and
expire together on disable, workspace switch or restart. Reads run concurrently
with at most eight in flight, preserving capacity for Stop. Authenticated ACKs
commit sequence; lost results and ambiguous mutation failures stay unknown,
never permission to submit a new duplicate command.

The desktop adapter projects root-task text into a separate 48 KiB JSON budget.
It does not expose arbitrary paths, child task contents, raw desktop snapshots,
permissions, approvals or credentials. Only the model may be a fixture in the
Alpha acceptance chain. See the [setup and phone acceptance guide](../../docs/private-mobile-alpha-acceptance.md).

The original Phase 0 executable demo remains available for protocol exploration:


```text
fake mobile client -> in-memory relay -> host bridge
                   -> mocked host-neutral control service
```

The demo below is not Alpha acceptance evidence. This package contains no public
relay, native mobile client, account system or persistent credentials.

## Run it

From the repository root:

```sh
bun run --cwd packages/remote-control typecheck
bun test packages/remote-control/src
bun run --cwd packages/remote-control demo
```

The demo pairs an Ed25519 device through the trusted direct Phase 0 bootstrap,
sends one online request, disconnects the host, queues another opaque request,
and drains it after reconnect. Its printed summary is checked against every
pairing and channel secret before output.

## Security boundary

- The pairing nonce is short-lived, single-use, host-bound, and signed by the
  device identity. `beginPairing` takes `grantedCapabilities`: it is a trusted
  host approval API, not a remotely callable client request.
- Bearer credentials are random, host/device/route/scope bound, expiring, and
  revocable. The host retains only a record-specific salt and SHA-256 verifier.
- A separate random channel root is never derived from the credential verifier.
  HKDF derives independent AES-256-GCM keys for each direction.
- The relay sees only a replaceable route alias, direction, message metadata,
  ciphertext length, and ciphertext. Stable device identity, host identity,
  capabilities, sequence, requests, results, and credentials stay in the
  authenticated encrypted body.
- The bridge independently derives the required capability for each operation,
  authenticates every delivered request, binds one control stream to each
  credential, commits sequence before invoking the service, and uses separate
  ACK/result or ACK/error frames. Error frames explicitly state whether the
  sequence was admitted, so a lost ACK cannot split the client and host
  high-water marks.
- The fake client permits only one not-yet-admitted request. Retryable
  rejections retain that exact sequence, resync only updates local state, and
  each explicit reconnect sends at most one fresh-envelope retry or probe.
  A prior relay `queued` receipt is not host admission evidence and cannot
  suppress that retry, even if the original ciphertext may still be queued.
- Protocol frames, relay messages, connection maps, pending pairing records,
  credential/channel records, bridge work, tracked client requests, and relay
  queues all have finite count or byte ceilings. Relay queues have both
  per-route and global limits. The bridge checks the relay's declared message
  and per-route backlog ceilings before connecting, so an incompatible
  synchronous reconnect cannot consume and silently drop queued ciphertext.

The complete threat model and accepted Phase 0 residual risks are documented in
`docs/remote-control-phase-0-threat-model.md`.

## Host-neutral operations

| Operation | Required capability |
| --- | --- |
| `sessions.list` | `sessions.read` |
| `session.snapshot` | `sessions.read` |
| `session.send` | `sessions.send` |
| `session.stop` | `sessions.stop` |

There are no wildcard scopes or implicit capability inheritance.

## Production integration and lifetime

`DesktopRemoteControlManager` constructs the HTTPS host and a fresh workspace-bound
adapter on each local enable. The adapter calls the window's existing service;
it owns no separate runtime client or prompt queue. Per-device cancellation
prevents revoked requests that are still awaiting membership/actor admission
from executing, while disabling remote control revokes the entire adapter scope.

Remote Send and Stop reserve the shared task actor before awaiting membership.
Membership reads start concurrently, but cannot reorder remote or local writes.
Membership and later Send preflight share a five-second read budget starting at
admission; queued preflights cannot each add another full timeout ahead of Stop.
That deadline does not abort a real write or discard a Stop whose membership
check already succeeded. List and snapshot reads remain outside the task actor.

Accepted remote queue items carry their origin into the desktop queue. If the
runtime may have accepted an item before its response fails, that item is not
automatically requeued. A sticky `deliveryUnknown` snapshot flag tells the phone
to inspect the task before issuing another command. This complements the
HostBridge sequence high-water mark and browser `outcome_unknown` state.

The phone keeps each unknown command outcome separately from connection and
ordinary success notices. Reconnect or a later successful read/write cannot
resolve that warning; an explicit user confirmation clears only its own command.
Revocation or disposal also preserves uncertainty for transmitted mutations whose
results have not arrived. An authenticated, correlated `admitted:false` rejection
still proves non-execution for that exact attempt; unsent requests and reads keep
their ordinary errors.

The in-memory relay, fake client and mock service remain protocol test/demo
fixtures only. They are not used by the private HTTPS/desktop/browser acceptance
chain. Public relay, account, multi-host and persistent authorization support
remain outside this Alpha.
