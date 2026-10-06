# MCP execution contract

Host is the MCP configuration and connection owner. CLI, TUI and Desktop use
its scoped control service; manual mode exposes `connect` and `disconnect`
without launching a configured process merely by listing it. A disabled project
server stays disabled when explicitly connected.

## Target identity and compatibility

A server name is a display/lookup key. `mcpServerIdentity` hashes the effective
transport and target: HTTP/SSE URL and OAuth authority/client/scope settings;
stdio executable, arguments, working directory and configured environment.
Relative working directories and executable paths are resolved for the identity.
Hashes do not expose credential values, and do not attest to executable contents.

A project may overlay tool filters and timeouts for the same user target. A
changed target does not inherit user headers, OAuth secrets, environment,
credential-bearing arguments, or trust. The project must supply its own target
configuration. Project stdio only starts if user configuration explicitly trusts
that exact target; a same-name legacy trust entry cannot authorize a replacement.
There is no automatic migration granting trust to a new target.

Tool and resource-read approvals carry this target identity. The shared approval broker binds new
session/persistent MCP grants to it and requires renewal for old unbound allows;
name-based denies continue to apply. Remote read-only/idempotent annotations do
not establish resource permission. Idempotent writes are not concurrency-safe.
When a call has file/execute scopes or the active policy contains file resource
denials, opaque MCP tools are refused: their transport cannot enforce those local
constraints. Only trusted local implementations can declare that capability;
server annotations and schemas cannot grant it.

## Connection and catalog lifetime

Concurrent connects share initialization. Disconnect invalidates the connection
before awaiting transport close, aborts pending operations, and removes executable
tools. SDK disconnect events do the same. A late initialization or catalog reply
cannot restore an old connection or overwrite a newer catalog.

Each executable tool definition carries a revision incorporating the connection,
target, catalog generation and complete tool schema. Preparation/execution and
the MCP manager both reject old revisions after refresh, reconnect or removal.
Resource reads bind their target before approval; command-based prompt rendering
captures the originating manager and prompt revision. Neither resolves an old
approval or prepared command to a replacement target by name. Executable input
schemas that would be changed by catalog redaction/truncation are refused rather
than executing against a different validation contract.
Calls are never retried automatically after an uncertain tool effect.

MCP `structuredContent` is preserved as `ToolResult.structuredData`, bounded and
validated by the shared JSON contract (4 MiB; invalid/oversized values fail).
Model output and the legacy `metadata.structuredContent` preview may be truncated;
program data must use `structuredData`.

## Protocol and interactive input

HTTP and stdio negotiate MCP `2026-07-28`, with automatic fallback to legacy
handshake versions. Legacy SSE remains available. Modern requests use per-request
metadata and routing headers; catalog changes use `subscriptions/listen`.

Hosts with a user-input queue support modern `input_required` elicitation during
tool calls and resource reads. Desktop uses its existing input cards. Form mode
asks for consent, collects typed fields, and validates the external schema in a
bounded worker. URL mode shows the server's address and waits for the user to
confirm completion, decline, or cancel; it never opens a URL automatically.
Form input is subject to the existing input-card limits, plus 20 fields and 20
choices per multiple-selection field. Answers are stored in normal user-input
events, so form mode must not be used for credentials or other sensitive input.

Each interaction is bound to the originating session and call. Concurrent calls
cannot consume one another's responses. The SDK echoes the opaque request state
and supplies only the current round's answers. Each continuation rechecks approval
and the tool/resource revision; interruption and disconnect cancel pending input.
The flow is limited to eight rounds. Headless Hosts and prompt commands without a
session-bound input handler fail explicitly. Legacy server-initiated input is not
advertised because it cannot be reliably correlated with a session/call.
Sampling, Roots, Tasks and MCP Apps are not implemented by this bridge.

## OAuth

`chili mcp auth <server>` and TUI `/mcp auth <server>` return a browser sign-in URL.
The CLI stays running until the callback completes or the five-minute window
expires. Successful sign-in reconnects configured, enabled instances of the same
target. TUI authentication follows the selected session's workspace and refreshes
its status after sign-in. `mcp logout` removes local OAuth credentials, cancels a
pending login, and disconnects matching targets; it does not revoke access at the
authorization server or remove static headers from configuration.

Authorization uses SDK discovery, PKCE, a random state, and callback issuer
validation. The callback binds only to `127.0.0.1`; an optional `callbackUrl` or
`oauth.redirectUri` must be an HTTP loopback URL without a query or fragment.
Remote clients need access to the Host's loopback callback (for example through
an appropriate local tunnel). An `oauth.clientId`/`clientSecret` can identify a
pre-registered client, or `oauth.clientMetadataUrl` can point to a hosted HTTPS
client metadata document. Otherwise the SDK uses discovery/registration supported
by the authorization server. Explicit authorization/token endpoint settings must
match the discovered metadata. Scope step-up requires a new explicit authentication
request, optionally with `scopes`.

OAuth credentials are stored as private `0600` files under `CHILI_HOME/mcp-auth`
(normally `~/.chili/mcp-auth`), partitioned by effective target and issuer. The
directory is created with mode `0700`. Tokens refresh before expiry and after a
401; concurrent refreshes share one operation within a Host. PKCE verifiers and
pending callback state stay in memory. Logout, timeout and shutdown fence late
authorization results. Static credentials stay inside their configured target.
There is no automatic trust or credential migration between targets.
Configuration changes become active on Host reload, which also cancels pending
OAuth flows; catalog notifications update connected tool definitions.

## Process lifetime

On POSIX Hosts, stdio runs through a transparent guardian command, including
SDK-created discovery probes. A private Unix socket and random capability connect
each wrapper to its Host. Before launching the server, a separate process-group
leader must pass the Host's durable guardian-registration barrier. Command data
and environment travel only after this handshake; the trusted wrapper runs with
a fixed environment and root working directory to avoid project preloads.

SDK close, wrapper death, or Host socket EOF terminates the entire owned group,
with bounded escalation for servers that ignore stdin EOF and SIGTERM. A guardian
is unregistered only after its group disappears. Normal close awaits cleanup;
hard-kill recovery checks recorded guardians separately from session leases.
The compiled CLI and sidecar include the same guardian entrypoint. Tests verify
both discovery/session groups, registration rejection, and SIGKILL of a real Host
with a stubborn server and grandchild. A deliberately daemonized descendant that
escapes its process group needs stronger OS containment; this is not a sandbox.
Windows Host stdio is explicitly unavailable until equivalent containment exists.
Injected custom clients remain responsible for their own external processes.

Tests use fake credentials/transports and controlled local fixture processes;
they do not exercise a real account or external MCP service.
