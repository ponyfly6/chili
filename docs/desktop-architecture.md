# Desktop control architecture

## Boundary

```text
React renderer
  └─ ControlTransport
       └─ Electron transport
            └─ frozen preload invoke/subscribe capability
                 └─ validated IPC (main frame + exact origin)
                      └─ DesktopProjectManager (saved projects + active selection)
                           └─ per-project DesktopControlService
                                └─ authenticated SDK client
                                     └─ per-project 127.0.0.1:dynamic-port Bun sidecar
                                          └─ existing Chili runtime/store/tools
```

The desktop renderer imports domain types and SDK projection functions, but no Electron, Node, filesystem, process, or sidecar endpoint. `ControlTransport` in `apps/desktop/src/renderer/transport.ts` uses narrow Electron IPC. The private mobile Alpha adds a separate browser page with fewer capabilities, sharing the active project’s control service:

```text
apps/control-web → private HTTPS → PrivateControlHttpsHost → HostBridge
  → DesktopRemoteControlAdapter → DesktopControlService → real sidecar/runtime
```

Remote control is off by default. Enabling it requires private HTTPS configuration and a browser-trusted certificate; a short-lived, one-use pairing code still requires local desktop confirmation. The phone can list existing root tasks, read bounded public snapshots, and send Queue, Steer or Stop. Task creation, workspace selection, child-task internals, approvals, user-input answers, permissions and credentials stay on the desktop. Authorization and replay state are memory-only: revocation, disabling remote control, workspace switching or restarting invalidate the relevant grants. A lost command result remains unknown and is not automatically resubmitted; reconnecting or later success cannot clear its warning without explicit user confirmation. Public relay, accounts, cloud sync and native mobile clients remain outside this Alpha. See the [setup and phone acceptance guide](private-mobile-alpha-acceptance.md); real browser automation has been exercised, but iPhone / Android hardware acceptance is still pending.

Local setup travels through a separate `chiliRemote` preload capability. The renderer submits only a local private IP, port, and a keep/select choice; Electron owns the two native TLS file pickers, validation, and private file references. `DesktopRemoteSettings` rechecks the NIC, certificate SAN/validity, and key match before each enable. Configuration is saved separately from workspace state using a 0600 atomic file replacement; neither enable state nor pairing authority persists. Complete launch environment configuration takes priority and remains read-only in the UI. Setup, enable, disable, and workspace changes share lifecycle invalidation so a late picker or validation result cannot re-enable a revoked host.

`desktop:preview` produces a persistent local ad-hoc application under a unique version directory, with a Git revision label and artifact hashes. Preview uses `dev.chili.control.preview` and its own Electron user-data directory before requesting the single-instance lock. Runtime data remains owned by the selected workspace. Packaging requires committed source and never uses the shared release directory.

## Processes and lifecycle

Electron main owns a `DesktopProjectManager` registry of up to 64 saved directories, deduplicated by canonical path. Each opened project retains its own sidecar, control service, durable input state, permission state, and process containment owners. Switching changes the active projection without stopping other projects. Every action transport captures its project ID, while resync list/snapshot reads bind to the project returned by the same state query. Project-tagged events from another project cannot enter the active timeline; background runtimes continue dispatching saved inputs while control services receive their events.

`desktop-state.json` atomically persists project IDs, paths and active selection with mode 0600 and migrates the old single-workspace value. Startup restores the list and starts only the active project; other projects start on first selection. Selection/draft memory survives switching within the current renderer; drafts are not persisted across application exits; accepted inputs are saved in the workspace SQLite store and recovered paused. Remote authorization is disabled before changing projects, and enabling again captures the newly active control service. Shutdown seals and contains every opened project concurrently.

Each project supervisor:

1. Canonicalizes the selected directory.
2. Generates a new random bearer token.
3. Starts the source sidecar with Bun in development or the compiled `Resources/chili-sidecar` in a package. Main sends the credential once on a dedicated inherited fd 3 as an exact, versioned ASCII frame under a 128-byte/five-second handshake limit, then closes the pipe and zeroes its frame buffer. The sidecar validates the complete frame before starting the harness/server, auto-closes fd 3, and zeroes its receive buffers. The credential is never placed in the child environment or argv.
4. Waits for a structured ready line, rejects non-loopback endpoints, and performs an authenticated health request.
5. Creates the existing `HttpRuntimeClient` with a main-only authorization wrapper.
6. Streams global runtime events over SSE and reconnects with an event cursor. Each connection rotates after 4,096 durable events or five minutes; durable events are pumped from the store after the last cursor, so a delayed observable notification cannot duplicate or reorder replay. A stale cursor produces an explicit renderer resync event.
7. On an unexpected exit, drains the launch-local control stream, terminates every reported tool process group and the sidecar group, then retries three times with bounded backoff. A stable-health window resets the consecutive-failure budget; containment failure is non-retryable.

The sidecar has two ownership guards: an open parent-owned stdin (fd 0) pipe detects Electron death immediately, and a parent-PID check remains as fallback. The one-shot fd 3 credential channel is separate and cannot change ownership EOF semantics. Graceful main shutdown writes an explicit ASCII ownership frame without closing stdin; any stdin EOF is therefore parent loss. Shutdown denies unresolved approvals and input requests, closes HTTP, atomically closes Agent creation and input admission, interrupts active work, waits for durable terminal settlement, then closes SQLite. Rejecting or never-settling cleanup remains observed until the final decision and escalates through a bounded coordinator that contains both the sidecar-owned process groups and every detached Git process group owned by Electron main. Main enforces a nine-second containment deadline inside the outer twelve-second quit watchdog. Electron 42's cancellable `before-quit` is synchronously deferred once; after the sidecar and main-owned Git groups are confirmed absent, shutdown completes with `process.reallyExit`, falling back to `SIGKILL` of the exact Electron main PID if that primitive is unavailable. The outer watchdog and forced stage are reserved for exceptional cleanup that cannot reach bounded containment.

## Data flow and controls

The first vertical slice is fully real:

```text
Electron launch → compiled sidecar → authenticated health → list/create session
→ prompt_async → SSE message events → SDK projection → React timeline
```

Snapshots combine root events with recursively discovered child sessions using six-request concurrency plus global row/byte budgets. Oversized snapshots are visibly marked truncated. That allows SDK projection to restore active descendant approvals without showing orphaned crash-era requests. Live global SSE events update the same projection; Agent session and input lifecycle events trigger a bounded snapshot refresh.

Queue and Steer are admitted durably by `RuntimeService`, with stable submission IDs and atomic input/queue-event commits. Desktop main caches queue projections; it does not dispatch pending inputs. Queue is FIFO; Steer takes priority and interrupts the active turn without cleaning up managed processes. Stop persists a dispatch pause before aborting the current run and stopping resources. Explicit Resume restores dispatch, with pending input taking priority over Goal continuation. Recovery pauses saved input and records unknown execution outcomes instead of replaying tool calls. Per-session/global backend budgets bound pending inputs, and desktop IPC send admission remains bounded; Stop retains separate reserved capacity. See [Host durable input guarantees](../packages/host/README.md#durable-session-inputs). Approval decisions and user-input answers use existing deferred queues through authenticated SDK endpoints.

Goal mutations and usage capture use a SQLite `BEGIN IMMEDIATE` transaction across independent connections/processes, with a short per-session queue for services sharing one store object. Each model turn captures its owning Goal ledger, and a persisted usage receipt prevents double accounting after replay or a lost append acknowledgement. In-flight usage can settle after pause/completion without reviving the Goal; tool continuations and forced final replies remain charged to their original ledger, including after budget exhaustion. Clear-and-recreate starts a new ledger, so old work cannot charge a replacement Goal. Missing derived Goal projections recover from the latest durable Goal event inside the transaction; a clear never resurrects a previous ledger. Usage lost before its first durable receipt cannot be reconstructed.

Ordinary renderer invokes share a global count and UTF-8 byte admission budget before sidecar HTTP work begins; Stop uses its own reserved lane. Main-to-renderer events use a private preload READY/ACK protocol with monotonically increasing sequence numbers. Pending, sent-but-unacknowledged, and recovery-held frames share count plus full serialized-envelope byte budgets. State and per-project/per-session queue counts may coalesce, transient tool-output deltas may drop, and every durable loss creates one reserved resync barrier. Normal increments remain suppressed until the renderer has reloaded app state, active sessions, and the selected snapshot and has completed the same barrier; frames released synchronously by completion remain buffered and are replayed before actions are enabled. The page sees only `invoke` and `subscribe`, never the ACK capability.

Turn changes are reconstructed from the current turn's validated versioned snapshot manifests and current files. Workspace changes use only sanitized Git plumbing (`ls-tree`, `ls-files`, `cat-file`) plus an in-process bounded patch renderer; repository fsmonitor, textconv, clean/process filters and external diff commands are never executed. Every detached Git command is registered immediately in a main-owned process-group registry. Shutdown seals new admission, aborts in-flight diff work, and escalates each registered group from `SIGTERM` to `SIGKILL` until absence is confirmed. Renderer output is capped, request-sequenced, and runtime validated before crossing IPC.

On POSIX, Electron launches each workspace Git command through a small supervisor in its own process group. The packaged sidecar executable dispatches this mode before importing the runtime; it receives no sidecar credentials and opens no HTTP endpoint. A dedicated duplex fd 3 carries the parent/leader ownership handshake and Git's terminal result, while stdin/stdout remain available for binary `cat-file --batch` traffic. After confirming its own PGID, the helper starts Git inside the same group and contains that group on parent EOF or when Git exits. Thus an Electron SIGKILL cannot strand main-owned Git work. Development launches disable Bun config/env autoload and use a trusted cwd. Real helper tests use a Node parent, matching Electron; Bun 1.3.14's `node:child_process` extra-stdio bridge has a separately reproduced intermittent connection failure.

The Activity panel scopes its selection to project and session, flattens the agent hierarchy into bounded pages, and mounts long instructions/results only when expanded. Execution metadata and run history remain separate disclosure controls. The Changes panel parses the existing bounded diff response into selectable file patches and old/new line numbers, with paginated raw text as a lossless fallback. It preserves upstream truncation warnings. A response scope plus request sequence prevents a late diff from the previous project, session, or turn entering the selected panel.

SDK replay treats a complete running tool-input preview as an anchor even before execution starts, matching the runtime's preview-before-part-before-start order. Once execution starts, the actual start remains the preferred anchor. Dependencies are scoped to a session; incomplete status/output orphans still drop, with a causal-gap warning distinct from an actual row/byte limit. Synthesized agent-tree grouping nodes may have an empty display name, while actual run/task names remain required.

## Electron security model

- Secure `chili://app` custom scheme, fixed host, normalized path containment and packaged asset-only responses.
- Production CSP: `default-src 'none'`, scripts/styles/images/fonts from self only, and `connect-src 'none'` because renderer never connects to the sidecar.
- Browser sandbox, context isolation, no Node integration, no insecure content, production DevTools disabled.
- Packaged builds ignore the development renderer URL escape hatch; the package smoke injects a hostile value to verify the app still loads only `chili://app`.
- Window creation denied; only explicit HTTP(S)/mailto navigation is delegated to the system.
- Notification permission requires both the exact renderer origin and a registered trusted `webContents.id`.
- One typed IPC invoke channel and one event channel. Request, response, and event payloads have length/count/depth plus cumulative UTF-8 byte limits and are parsed in preload/main. MCP/tool content is separately bounded before persistence and SSE publication, including image/base64 and structured metadata.
- Streamable HTTP JSON bodies, legacy SSE frames (GET and POST fetch paths), and stdio JSON-RPC lines are each bounded at 4 MiB before SDK JSON parsing, without trusting `Content-Length`. Fatal ingress overflow closes the transport and surfaces one stable bounded error. Tool and MCP failures are normalized before return or persistence to a 16 KiB UTF-8 message plus bounded safe name/code metadata; stack, cause, secrets, hostile getters, and arbitrary object graphs are not copied.
- Sidecar endpoint, bearer, and PID are deliberately absent from the renderer contract. Error messages redact bearer material and loopback URLs.
- Native approval and input notifications use generic lock-screen-safe text. First-party direct file mutation refuses root `.git/**`, `.chili/**`, their symlink/canonical targets, and linked-worktree gitdir targets; trusted internal tool-result storage retains a separate capability. Sandboxed Bash independently denies those metadata targets and preflights hard-link aliases.
- Electron fuses disable `RunAsNode`, `NODE_OPTIONS`, CLI inspect arguments and file-protocol extra privileges, and enforce embedded ASAR integrity/ASAR-only application loading.

Cookie encryption is not enabled because Chromium cookies never contain Chili auth material; enabling it creates an unnecessary Keychain dependency. Provider credentials remain governed by Chili's existing auth storage and are not copied into desktop state.

## Packaging

`bun run desktop:build` builds the mobile control page, compiles a self-contained host-architecture Bun sidecar and bundles Electron main, preload, and renderer. `electron-builder` keeps only bundled output and package metadata in ASAR and puts the executable sidecar and `control-web` assets in `Contents/Resources`. The after-pack hook verifies architecture, executable mode and the complete Electron 42 fuse wire. The final acceptance smoke clears any inherited signing identity, signs fully ad-hoc after fuse mutation, and verifies that identity explicitly. The current configuration explicitly rejects every non-ad-hoc identity; only a future, separate release pipeline will support Developer ID signing and notarization.

Desktop builds first refresh TypeScript workspace outputs, because Electron/Vite resolves workspace package exports through `dist`. This prevents a fresh desktop bundle from silently containing stale SDK/runtime dependencies after source changes.

This output is a local Alpha validation artifact and **must not be treated as a formally distributable build**. Developer ID signing, notarization, release DMG/ZIP publication, update delivery, public relay, native mobile clients, multi-host control, and a tray-resident daemon are intentional non-goals for this iteration.

`bun run smoke:desktop` is the independent macOS clean-package gate. Each run builds the desktop, sidecar and mobile assets under its own `mkdtemp` root and cleans only that root; it does not overwrite shared `release`, `out` or `resources` output. Process ownership begins with this run's spawned children and their start identities, then follows observed descendants and owned process groups. Executable paths and argv never establish ownership. Isolation regression tests cover success, failure, interruption, unrelated same-executable processes and concurrent runs.

The gate validates host architecture, code signature, the complete fuse wire, the exact minimal ASAR allowlist, and electron-builder-compatible ASAR header integrity. The full artifact is scanned for source/HOME/TMP/path/URI/secret canaries; renderer-visible state, lists, responses, events, and snapshots are separately scanned with renderer-safe secret/path/URI positive controls. The gate launches twice with the same isolated profile, sends a real fake-model prompt, waits for assistant output and idle, and exercises the native `app.quit()` path. It rejects stderr or the forced stage and asserts complete process cleanup; a blocked-Git fixture uses a repository-local include FIFO to prove shutdown aborts and contains the registered Git process group. A separate parent hard-crash fixture kills Electron and verifies sidecar, detached tool group, inherited-child, and Electron helper containment. The cross-platform `smoke:all` gate and trusted-HTTPS browser-to-runtime `test:e2e:remote` suite remain separate; package smoke alone is not phone acceptance evidence.

`bun run smoke:desktop-projects` adds real Electron coverage with three simultaneous project runtimes, repeated project switching, independent cancellation, blocked Git and running tool descendants during native quit and parent hard-crash. It records process identity, switch timing, screenshots and cleanup outcomes. An unrelated sentinel must survive; ownership is never inferred from executable names or paths. This macOS gate is separate from the portable fake-model smoke suites and runs in the desktop CI job.

## Agent recovery

Agent creation persists the child Session and its first input together. Initial and later inputs use the same durable queue, run claims, and pause/resume path. Recovery pauses interrupted inputs and retains their identities; an explicit resume continues pending work or retries the interrupted input. Restoring an existing Agent does not allocate another identity or consume another child/depth slot.
