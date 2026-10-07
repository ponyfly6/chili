# Tool discovery and model exposure

The Host starts root coding sessions with these twelve tools when available:
`read`, `glob`, `grep`, `edit`, `write`, `apply_patch`, `bash`, `process`,
`code_mode`, `tool_search`, `activate_skill`, and
`request_user_input`. Headless Hosts without an input queue omit the last tool.
Agent controls are exposed according to durable Agent state and the caller's
permissions. All Agents receive code mode by default. Registered tools remain
implemented independently.
Embedders using `SingleAgentRuntime` directly opt in with `toolExposure`; without
that configuration their supplied catalog stays exposed, including when they do
not install a discovery tool.

There are three views of one registry:

- The authorized catalog is filtered by the current session/worker policy. Tool
  discovery and code mode use this catalog, not the list of model definitions.
- The model surface contains eager tools, tools explicitly loaded in the session,
  and control tools required by durable Goal and Agent state.
- The script catalog contains authorized tools that opt in with `codeMode: true`.
  Orchestrators and direct-only tools remain excluded.

`tool_search` ranks names, aliases, descriptions and search hints using BM25, with
exact names/aliases taking priority. Unicode tokenization supports Chinese
metadata. `select:name1,name2` resolves exact names or aliases, including already
loaded tools. Search returns complete input/output contracts and the JavaScript
access expression, with a maximum of 20 matches per request.

Direct search loads matching definitions and related control tools for subsequent
model requests. Loading appends `session.tools_loaded` with canonical names to the
event store. These additive selections survive compaction and reopening the
database and never leak to another session. Selecting a tool does not register it
or authorize it. A removed or newly denied tool is absent from all current views.
An unloaded direct call, including an alias, returns guidance to search first;
loading and calling it in the same model response does not change that response's
advertised tool snapshot.

Scripts may call authorized deferred tools without searching first. A script's
search defaults to inspection (`load: false`), so querying a contract does not
inflate subsequent direct model requests. `ALL_TOOLS` remains a lightweight
name/description directory. Use `tool_search` to obtain complete parameter schemas.
All actual calls still go through the existing Executor, current authorization,
catalog validation, effect scheduler and event recording.

Searching an Agent or Goal tool loads its related control group. The Host
also reconstructs required groups from persisted domain projections for sessions
created before discovery existed or work created through the API. Existing
Agents retain controls for later inputs, inspection and resume. These groups are
filtered again by current policy. Delegation-off policy hides and rejects spawn,
send and resume. List, wait and stop remain available for existing Agents.

The Agent group contains six canonical tools: `agent_spawn`, `agent_list`,
`agent_send`, `agent_wait`, `agent_stop`, and `agent_resume`. They can also be called
through code mode without direct loading. Creation and sending return input
receipts; waiting follows a specific receipt. Use `Promise.all` over individual
spawn calls for parallel work. See [Agent tools](AGENT_TOOLS.md) for the contracts,
pause and resume behavior, and permission boundaries. `git_apply_patch` provides
change integration independently of Agent controls.

Git operations, including worktree management, use `bash`; `git_status`,
`git_diff`, `git_stage`, `git_commit`, `git_branch`, and `git_worktree` are no longer
registered or discoverable. Existing conversation renderers continue to display
historical calls. Git commands use the
same shell permissions and scheduling as other Bash commands. The macOS sandbox
continues to protect Git metadata, including a linked worktree's shared gitdir.
Authorized writes that need that access require an explicit one-time
`sandboxPermissions: "require_escalated"` request with a justification; there is
no automatic unsandboxed retry. The base prompt directs the model to commit only
when the user requests it and to respect repository hooks and signing
configuration. Chili does not inject commit trailers or disable signing. The
builtin init prompt permits Bash only for a read-only Git survey and keeps file
writes limited to `AGENTS.md`. Bash's command classification is a scheduling
hint, not proof that Git helpers cannot run. The macOS runner enforces no workspace
writes for classified read-only commands, including their child processes. Only
after the backend confirms this restriction does Bash publish `readOnly: true`
for the desktop turn diff. Full-access and opaque backends remain conservative.
Existing rules for the removed Git tool names no longer authorize or deny these
operations. Configure `bash` and `bash.unsandboxed` command permission rules for
the replacement paths. Default-mode elevation always requires a fresh one-time
approval, even if an old Git-tool session grant existed. Old wildcard Git grants
are not automatically translated into shell grants.

Loaded definitions are retained for the session; there is no usage-based eviction
yet. Evaluate definition size, search round trips and tool/argument errors before
changing the default surface.
