# Agent expansion configuration

Set Agent expansion limits in the user configuration (`~/.chili/config.toml`, or the configured Chili home) or the nearest project `.chili/config.toml`:

```toml
[agents]
max_children = 4
max_depth = 3
max_concurrent = 3
```

| Setting | Meaning | Default | Accepted range |
| --- | --- | --- | --- |
| `max_children` | Maximum number of direct child Agent identities created by each Agent | `64` | `0`–`64` |
| `max_depth` | Maximum depth of the Agent tree, with the root Agent at depth `0` | `1` | `0`–`16` |
| `max_concurrent` | Maximum number of child Agent executions running concurrently across all depths | `3` | `1`–`32` |

`max_children` controls horizontal expansion. It counts every direct child identity,
including idle and paused Agents. Completing an input or pausing its Agent does
not free a child slot. Resuming an existing Agent reuses its identity and does not
consume another slot. A value of `0` disables creating children.

`max_depth` controls vertical expansion. `1` allows the root to create children, preserving the default single-level behavior. `2` additionally allows those children to create their own children. `0` disables creating any child Agent. In the example above, every eligible Agent can create up to four direct children, and the deepest permitted Agent is three levels below the root.

The concurrency limit controls execution separately from the size and depth of the tree.
It is shared by all child Agent executions in the Host; the root Agent does not consume a slot.
Agents waiting for other Agents temporarily release execution capacity, so nested
work can progress with a single execution slot. Asynchronous `agent_spawn` returns
its `{ agentId, inputId }` receipt without waiting for the child's execution to
finish.

The width and depth checks govern every new `agent_spawn` identity through the
same admission path. Limits are loaded at Host startup; restart the Host after
editing them. Descendants inherit the effective restrictions of their ancestors,
and creation never expands tool permissions. Missing write or execute scopes stay
absent; the Host does not synthesize scopes during Agent creation. Explicit scopes
and denials remain in force, including for tools called through Code Mode.

Settings merge field by field: built-in defaults, then user configuration, then the nearest project configuration. Project Agent settings can increase or decrease user values; ancestor project files are not merged after a nearer project file is found. Existing permission rules still apply, including the restriction that project permission configuration cannot grant `allow` rules. Invalid types, out-of-range values, and unknown keys in `[agents]` fail configuration loading.

Saving a persistent permission grant preserves `[agents]` and other unrelated configuration tables.
