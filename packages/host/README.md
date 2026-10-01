# Chili Host

`@chili/host` is the shared application composition for the local coding agent.
CLI and Desktop construct it; TUI connects to its HTTP/SSE adapter through
`@chili/sdk`. Host owns the runtime, tool and MCP registration, configuration,
permission policy, session store, recovery timers, and resource shutdown.

## Create and close

```ts
import { createChiliHost } from "@chili/host";

const host = await createChiliHost({
  cwd: workspacePath,
  mcpConnectMode: "manual",
});

try {
  const session = await host.service.createSession();
  await host.service.submitPrompt({
    sessionId: session.sessionId,
    text: "Explain this repository",
  });
} finally {
  await host.close();
}
```

The model defaults, persisted selection, tools, prompt assembly, and restricted
child-agent policies are shared across application entry points. `modelRouter`
and `bashRunner` can be injected for tests. `model: "fake"` runs the existing
offline fixtures; `@chili/host/testing` exposes their router for test code.

Host has no terminal UI and writes no execution output to stdout. An optional
`onEvent` observer receives committed events from initialization through shutdown;
observer exceptions do not change the committed result. CLI supplies its printer
and readline approval UI. Desktop supplies deferred approval and user-input queues.

Approval policy remains inside Host. An `askApproval` callback only returns a
decision; Host validates its scope and persists allowed grants. `approvalQueue`
takes precedence when supplied. Without either interface, operations requiring
approval are denied. `permissionProfile: "full-access"` still honors configured
denies; `"auto-review"` is unavailable and rejected.

`close()` returns one shared promise. It closes admission, interrupts/drains root
and child execution, stops managed processes and maintenance, settles interaction
queues, closes MCP, then closes SQLite. Initialization failures also drain the
resources already created.

## Dependency boundary

```text
CLI adapter / Desktop sidecar ──> Host ──> core, tools, store, providers,
                                       mcp, policy, skills, commands
HTTP/SSE server <── injected service objects from the entry point
TUI / Desktop client ──> SDK ──> protocol
```

Host imports no application, server, or SDK package. The server receives structural
service interfaces; it does not construct Host. Public transport data and MCP
control types live in `@chili/protocol`. Filesystem command loading and
`preparePromptCommandSubmission` live in `@chili/commands`; HTTP and CLI use that
same conversion to validate expanded text and preserve display text and tool
restrictions before submission.

The runtime remains `RuntimeService` plus `SingleAgentRuntime`; Host adds no
parallel session state machine. Root and restricted child registries remain
separate. Store location (`<workspace>/.chili/chili.sqlite`), session identities,
event persistence, and JSONL mirroring remain compatible.

## Current migration boundary

This package completes shared composition. It does **not** yet implement a
discoverable owner, cross-process attach, durable input receipts/queues, or an
independent background supervisor. Creating two Hosts does not connect them;
SQLite session leases do not forward cancellation or approval callbacks.
Desktop retains its existing parent watchdog and process containment.

`chiliHome` is currently honored by configuration, model-selection persistence,
commands, MCP, and transcript mirroring. The existing auth/Memory/skills paths
are not yet fully unified around this option. Do not treat it as complete profile
isolation until the context/configuration migration is finished.

Further migration should put durable admission and queue/Goal arbitration inside
the existing RuntimeService before enabling owner discovery and multi-client
control. Keep transport adapters and application UIs out of those state machines.
