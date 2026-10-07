# Memory and project instructions

`loadChiliMemoryContext` / `buildChiliMemoryPromptFragments` remain the shared
Host entry points. Their input binds `chiliHome` (the selected profile directory),
`projectRoot`, `projectId`, execution `cwd`, current `query`, and known
project-relative or absolute `targetPaths`. Legacy `homeDir` callers still resolve
`<homeDir>/.chili`; an explicit `chiliHome` wins. Host supplies its canonical
project identity so related workspaces use the same project Memory scope. A Host
may own sessions in different projects: prompt, skills and Memory identities are
resolved for each session cwd, rather than inheriting the Host startup project.
The Memory tool uses a trusted `optionsForCwd` resolver during validation and
freezes that binding in its PreparedCall. Execution review and execution use that same
profile/project resource; model-supplied binding fields are discarded.

These inputs have separate responsibilities:

- Project instructions come from `AGENTS.md`, `CHILI.md`, and `.chili/rules/*.md`.
  They are re-read and content-hashed, and stay project-authority material.
- Session goals, unfinished work, accepted inputs, tool call/result pairs, and
  execution recovery remain in the event store and session context. They do not
  depend on a Memory writer.
- Long-term Memory is an explicit user-authorized durable preference/fact store.
  Entries are potentially stale context, never platform instructions. Automatic
  extraction is not enabled.

## Transaction authority and migration

`@chili/store` owns `SqliteMemoryRepository`, a separate profile-local
`<chiliHome>/memory.sqlite` database. User scope is local to that profile; project
scope is keyed by the Host project ID rather than the execution directory. SQLite
uses the same version-dependent journal policy as the session store and a busy
wait for concurrent local writers.

Each entry has a UUID, scope, immutable compatibility ordinal, revision, source,
creation time, and update time. `put` of an existing ID and `delete` compare the
supplied revision in an immediate transaction. Conflicting writes fail and require
a fresh read. Deletion retains a tombstone so neither the ID nor the ordinal can
be reused. List positions never identify a mutation. The old library removal API
accepts its stable ordinal for compatibility; the model tool requires ID plus
`expectedRevision` and rejects positional deletion with migration guidance.

On first access, the old profile `memory.md` and project `.chili/memory.md` are
imported once for that scope, with the original source recorded. Other worktree
paths sharing the same project identity cannot import a second copy. Managed section bullets become individual
entries; custom surrounding Markdown becomes an additional entry, preserving
previous background information. A receipt, SHA-256 content hash, exact original
content, and all imported entries commit in the same transaction. An absent old
file also gets a receipt. Concurrent importers cannot duplicate entries.

The old Markdown is left unchanged as an archive. Later edits to it are **not**
read as current Memory, and SQLite mutations never write it. This avoids two
competing authorities. The `memory export` operation and `exportChiliMemory`
return portable Markdown containing stable IDs/revisions; export is a copy, not
an alternative editable database. Legacy rules and project instructions remain
live files and are not migrated.

The model tool supports `add`, `list`, `get`, `search`, `put`, `remove`/`delete`,
and `export`. Memory resource descriptors label read and write operations as
`memory.read` / `memory.write` and identify `profile:<canonical-profile-path>/user`
or `profile:<canonical-profile-path>/project:<project-id>`. Every explicit Memory
tool call passes through the Host execution gate, including its prepared input
and profile/project identity. Host supplies both scopes for automatic prompt
selection; profile and project identity continue to isolate their data.
Tool program results use `structuredData`, separate from their truncatable model
text. The tool declares its trusted resource policy as `internal`, independently
of workspace file-write scopes. It forwards only the executor-owned
`assertCurrentAuthorization` hook, and rechecks after asynchronous path discovery,
legacy-source reads, and immediately before SQLite transactions/queries. A revoke
while migration is waiting prevents both import and the requested mutation.

## Retrieval and rule applicability

Search examines the entire scope, ranks bounded lexical query matches, and breaks
ties by update time / stable ordinal. Empty queries return recent entries. Prompt
selection defaults to at most 24 entries per scope and a per-entry character
limit. This is deterministic lexical retrieval, without a vector service or an
automatic relevance guarantee. The tool can explicitly list or search further.
Selected fragments carry stable IDs, revisions, source, and content hashes so a
saved request can retain the exact older content after a Memory update.

Rules without frontmatter apply unconditionally for compatibility. Valid
`paths` makes a rule conditional unless `alwaysApply: true` is explicit.
`alwaysApply: false` requires at least one matching known target path; an empty
path list matches nothing. Paths are normalized relative to the project root;
outside-root paths cannot match. Unknown/unmatched targets produce an omission
record (`rule_paths_not_applicable`) in the context snapshot/manifest. Explicit
`alwaysApply: true` wins over `paths` and keeps the rule unconditional. Priority
continues to order applicable rules.

Host derives at most 64 canonical targets from recent file-tool calls in the
same session (including structured/text patches), and passes them on subsequent
turns. Known target subtrees also contribute their own AGENTS/CHILI instructions.
Different sessions do not share this target history. The loader does not
infer file paths from arbitrary prose or claim that a rule for an as-yet-unknown
first file operation has already been applied. Matching and instruction discovery
are not an OS permission boundary.

## Validation

Behavior tests cover fresh profile isolation, project identity across cwd changes,
transaction conflicts and deletion identity, three real concurrent Bun writers,
one-time migration, export, retrieval of newly appended entries from a long
library, preserved older prompt content, scoped rules, and content version changes.
A real Host test exercises a fake model calling the Memory tool and captures
subsequent model requests in two profiles, including profile-specific skills.
No paid model or real account data is used in these checks.

## Current context and source provenance

Each load reads the current Memory records and applicable instruction files.
Successful updates, deletions, and rule scope changes take effect on the next
load; previously assembled requests retain their earlier content and revisions.
Current user corrections take precedence over stale Memory and older summaries.
A summary does not restore a Memory entry or rule that is now deleted, changed,
or outside the current target scope. This is a context policy, not a guarantee
that a model preserves every semantic detail in a summary.

Loaded documents and unrendered fragments keep `sourceContent` in memory before
their display preview is clipped. For project files this is the exact text,
including frontmatter and whitespace; for Memory it is the persisted entry text.
The source hash and character count describe that source, while the rendered
content hash describes the actual preview. This does not create another durable
Memory log or change the database schema. Display clipping remains explicit and
does not claim that the entire source reached the model.

Project instruction fragments are ordered before background Memory when sharing
the prompt budget. Memory limits are finite nonnegative character counts and
previews do not split Unicode surrogate pairs. Retrieval is still bounded lexical
selection, and oversized entries may require an explicit `memory get` to inspect
their complete persisted content.
