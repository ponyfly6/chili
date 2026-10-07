# Markdown Memory

Memory is ordinary, editable Markdown. The files are the authoritative content;
there is no Memory database, database index, dedicated model tool, or automatic
extraction. Scheduled consolidation ("dreaming") is future work.

## Organization

```text
<profile>/memory/
  personal/
    preferences.md
    ...
  projects/
    <projectId>/
      decisions.md
      ...
```

The model chooses filenames and how to organize topics. No frontmatter, entry ID,
revision counter or fixed taxonomy is required. An index can itself be an ordinary
Markdown file maintained when useful.

The Host provides the root, personal and current-project directory paths in the
existing base prompt. It does not read, rank or inject the bodies. The Agent uses
ordinary file tools or Bash to discover, search, read, update and delete files as
the task requires. Current user corrections take precedence over older Memory
and summaries. This iteration writes Memory only when the user asks.

The profile owns the personal directory and its project directories. Host project
identity is derived from Git common-dir, so related worktrees use the same project
Memory directory. Other supplied project IDs are mapped to a safe deterministic
directory name. Main and child Agents receive directories resolved for their own
execution cwd; their tool histories remain separate.

Directory organization is not an additional filesystem permission system. Normal
workspace file tools retain their existing path limits and protected metadata
rules. Bash can address profile files with absolute paths when the existing
execution review and worker scope permit it. Restricted children do not acquire
extra rights through the Memory directory hint.

## Content and freshness

A normal edit changes Memory immediately; deleting a file removes it. There is no
Memory cache, synchronization command, shadow database body, or automatic rewrite
from an old source. Concurrent edits use the same file-operation behavior as any
other user file; this module does not claim database-style revision transactions
for arbitrary shell writes.

CLI `memory show` explicitly reads Markdown in the selected scopes. `memory add`
creates a new Markdown file with the complete text and reports its path. The add
helper validates text, writes a complete temporary file, then publishes without
overwriting an existing file. It does not impose a format on files edited through
normal tools. Display limits apply to previews, never to the saved source.

CLI inspection reads the current files with their paths. Model tool reads enter
normal session history and Context budgeting; prepared request inspection records
that actual history. Updating a file does not rewrite an older tool observation
or prepared request.

Session goals, unfinished tool calls and recovery remain in the session store.
They do not depend on Memory. Existing compaction coverage, failure and recovery
contracts continue to apply to Memory read through tools.

## Removed paths

The SQLite Memory repository, dedicated `memory` model tool, special pagination,
ID/revision CRUD and `memory reload` command are retired. Old `memory.sqlite` and
old single-file Memory locations are not read, imported, migrated or deleted.
There is no compatibility path. Existing session/event storage is unchanged.

## Validation

Tests cover exact Markdown writes, source versus display, ordinary edit/delete
freshness, safe directory identities, profile/project selection, worktree sharing,
main/child prompts and explicit Bash reads, normal permission boundaries, and the
actual request source chain. Temporary fixtures are used; tests do not migrate or
modify the user's existing memories.
