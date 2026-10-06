# Prompt commands

`preparePromptCommandSubmission` is the shared CLI and HTTP boundary for prompt
expansion, display text validation, and command tool restrictions. Project and
profile commands use the same filesystem loader. MCP prompt metadata goes through
the same restriction validation before submission.

Supported capability fields are `allowedTools`, `writeScope`, and `executeScope`.
An omitted field remains omitted. An explicit `[]` remains an empty capability
set; it must never disappear during loading, expansion, persistence, or recovery.
Invalid metadata types reject the command before model execution. Existing
frontmatter string-list syntax remains supported, including an empty field as an
empty list. No migration of valid command files is needed.

Restrictions narrow the Host's effective tool policy; they do not override
configured denies or approval requirements. A scoped worker retains its existing
default of no write or non-read-only execution capability without the respective
scope. Resource matching and execution containment belong to the tools and Host
layers. There is no `readScope` command field; filesystem read restrictions use
the Host's permission policy.

Behavioral coverage includes the filesystem and MCP loaders, malformed metadata,
and real CLI/HTTP submissions through the shared Host in
`apps/cli/src/runner.test.ts`. These tests use temporary files and a fake model.
