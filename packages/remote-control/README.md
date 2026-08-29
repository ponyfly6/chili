# Chili Remote Control Foundation Phase 0

This package is an executable, host-neutral security foundation for a single
vertical slice:

```text
fake mobile client -> in-memory relay -> host bridge
                   -> mocked host-neutral control service
```

It is intentionally isolated from Electron, the renderer, runtime HTTP, and the
current desktop control service. It does not contain a public relay, PWA, native
mobile client, or production persistence.

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

## Minimal desktop integration after the desktop fixes merge

1. Add `@chili/remote-control` as an `apps/desktop` workspace dependency and a
   TypeScript project reference only when the desktop integration branch is
   ready. Phase 0 deliberately does not modify those existing manifests now.
2. Add one main-process adapter implementing `RemoteControlService`. Map the
   four validated host-neutral requests to the same-shaped subset of
   `DesktopControlService.invoke`; keep authentication, authorization, replay,
   limits, and redaction in `HostBridge` rather than duplicating them in the
   adapter.
3. Before exposing real session data, define a bounded remote-safe projection.
   In particular, do not pass raw snapshots, provider credentials, workspace
   paths, approval bodies, tool output, or unbounded errors through the adapter.
4. Construct the pairing authority and bridge in the desktop main-process
   lifecycle after `DesktopControlService` is ready. Disconnect the bridge
   before desktop shutdown. Do not route remote control through `App.tsx` or the
   renderer.
5. Keep the in-memory relay and fake client for deterministic integration tests.
   A later real relay must preserve the same opaque-envelope API, dual queue
   quotas, connection bounds, declared immutable route limits, and secret-free
   diagnostics before it can replace the Phase 0 relay.

Those steps are intentionally narrow: one adapter, one lifecycle owner, and one
workspace dependency. Electron IPC, renderer UI, public networking, device UX,
and Electron E2E remain separate follow-up phases.
