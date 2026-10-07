# Prompt material contract

`RuntimeService` asks its `promptFragments` provider for a fresh snapshot before
**each model turn**, including the final response after the tool-turn limit.
`lifecycle` describes the material's expected lifetime; it does not authorize
caching a file, rule, skill, or memory entry across those loads.

A fragment's stable `id` identifies one material within its source and scope.
Within one assembly, a later value for the same identity replaces the earlier
value, and an empty replacement removes it. Reusing an ID across source, role,
trust, scope, project, profile, path, or memory-entry identity is rejected. This
avoids injecting stale versions twice or silently replacing unrelated material.

`layer` selects the actual model role. Only `trust: "system"` material can enter
`base` or `developer`; other material requested at those layers moves to
`contextual_user`, and the debug metadata records the requested layer.
`priority` is ascending selection order within a layer, not instruction
precedence. Loaders determine whether a scoped rule applies before assembly.
The assembler does not interpret rule globs or turn retrieved memory into an
instruction.

`content` is the candidate model text. Optional `sourceContent` holds the exact
loaded source in memory when the candidate is a preview or rendered document.
Rendering records the exact source hash and character count, a hash of the
rendered content, and whether an earlier load or rendering step truncated it.
Extending an already-rendered assembly preserves these original source facts.

The context builder applies the request budget after assembly. The prepared
request records the actual sent text and its inclusion/omission status together
with source identity, scope, revision, and hashes. Raw `sourceContent` is not
copied into the debug manifest or permanent request record. Files and the Memory
repository remain authoritative for source bodies; this is not a historical
file-snapshot store. Inspecting an actual request uses its saved prepared record
rather than reloading today's source and presenting it as yesterday's prompt.
