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

## Explicit limits

MCP OAuth login/logout and token refresh remain unsupported; the control service
reports this rather than claiming an authenticated state. Static credentials stay
inside their configured target. There is no automatic trust or credential migration
between targets. Configuration changes become active on Host reload; catalog
notifications update connected tool definitions.

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
