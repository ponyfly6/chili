# File observation and mutation contract

Implemented 2026-10-03 in the shared `@chili/tools` executor and the built-in
`read`, `write`, `edit`, and `apply_patch` tools, plus filesystem snapshot creation
and restoration. CLI, Host, and child executors
use the same contract.

## Identity and observation

A remembered observation is keyed by session ID, canonical workspace, and
canonical file path. Relative paths, absolute paths, `./`, workspace symlinks,
and file symlinks resolve to the same identity inside that workspace. A different
session or workspace never inherits the observation. Each executor owns an
in-memory store; even an explicitly shared store exposes separate session views.
The LRU record and range-content budgets apply across those views.

Versions include device/inode, size, modification/change timestamps, and a
SHA-256 content digest. Mutation checks always read the digest: matching size
and modification time alone are insufficient. A full observation permits a
whole-file replacement; a range observation permits editing text in that range.
A range read at a new version invalidates the old full observation and ranges.
Before/after versions prevent a read interrupted by a modification from stamping
old output with new file metadata. Successful writes refresh only their own
session's observation. Other sessions must reread after the version changes.

These observations are deliberately not durable grants. Restart/recovery starts
with no remembered read state and requires fresh reads. Existing histories and
stores need no data migration. A write is still subject to current permission
policy; an observation is never a permission grant.

## Cooperative mutation ordering

The built-ins and snapshot operations hold canonical resource locks across reading/checking the version,
writing, and updating the observation. A patch acquires all of its source and
move-destination resources together, without lock-order deadlocks. Alias paths
share a lock; a changed alias while waiting fails before the handler starts.
Missing-file writes use exclusive creation so an intervening creator cannot be
silently overwritten. Existing text is compared again immediately before writes.

The machine/user coordination table is a small SQLite file in a private
`chili-file-operation-locks-<uid>` directory below the operating system temporary
directory. Short SQLite transactions atomically acquire and release resource
rows; no database transaction remains open while tool code awaits I/O. Rows carry
an opaque owner token and the local process ID. Waiting is cancellable and bounded
to 30 seconds. A live owner is never displaced merely because time passed.
A crashed owner's row can be reclaimed only when the operating system reports
that its process no longer exists. PID reuse is conservatively treated as a live
owner, so it can cause a timeout rather than an unsafe overlapping mutation.

## Snapshot ownership and compatibility

Version 3 snapshot manifests save the creating session, a mutation journal epoch
and revision, and each existing file's before-version. Snapshot creation holds
all listed paths while collecting and copying them; it does not hold locks over
a model turn. These snapshots contain concrete file paths, not a complete
workspace rollback. Existing wildcard-skip behavior remains unchanged.

Known built-in mutations record their session and verified resulting version in
the same private SQLite coordinator. The journal records a postimage only when
its digest matches the tool's known output; it never claims an arbitrary file
found after the tool returns. Deletions have an explicit absent postimage. The
journal keeps the most recent revision per path/session and the current known
version, preserving evidence of an intervening other-session write even when the
snapshot's owner subsequently writes again. A hard crash before recording the
postimage leaves unknown changes, which fail safe during restoration.

Restore acquires the same complete resource set as the built-ins. It validates
all backups and all target versions before changing any target. It rejects
changes made by another session after snapshot creation, unknown current changes,
and an unavailable or different journal epoch. The exception is an already
matching file (including normalized mode), which needs no mutation. A successful
restore records its own new version; previous file observations fail their next
freshness check. Lock waits and the final rename/deletion honor cancellation.
The runtime separately holds its session operation claim for the whole restore.

Version 2 manifests remain readable and permit a no-op when files already match.
They lack historical postimages/ownership, so changed files cannot be safely
migrated to version 3 by guessing; automatic restore rejects those changes with
an explanation and preserves their backup artifacts. Clearing the OS temporary
journal similarly prevents automatic rollback of changed files from older
snapshots, while already matching files still permit a no-op. Snapshot backups
remain available for explicit, separately reviewed recovery.

## Discovery and Git resource checks

`grep`, `glob`, and `read_image` authorize actual canonical files against all file
read-deny permissions (`read`, `read_image`, `grep`, and `glob`). Broad discovery
does not grant access to every candidate. Denied candidates are removed before
content reads or returned filenames; grep buffers process output until its final
authorization check. Candidate authorization is batched (128 files), with one
rule snapshot and a fresh authoritative resource check per batch. Content reads
also recheck authorization at process dispatch and after execution. This keeps
Host policy/configuration loads proportional to batches, rather than files.

Grep enumerates names first, then supplies only authorized file paths to ripgrep.
It disables ripgrep configuration and ignore-file loading, because those can
read denied files or inject an external preprocessing command. Consequently
project `.gitignore`/`.ignore` rules are not applied to grep; default hidden-file
filtering and explicit `.git`/`node_modules` exclusions remain. Enumeration is
bounded to 20,000 candidates and 2 MB of names. Complex resource-deny patterns
that cannot be safely represented by the shared denial compiler cause discovery
to fail closed. No result is streamed before the final check.

Ordinary Git operations use Bash. They inherit the shell's execution policy,
resource isolation, approval and scheduling behavior. Git can read historical
paths and invoke repository hooks, filters or filesystem-monitor helpers, so
pathspecs and read-like command names are not proof of resource isolation. A
runner that cannot enforce file resource denials or scoped policies refuses the
command. The macOS sandbox continues to protect `.git` and linked-worktree
metadata; authorized Git writes requiring that access use explicit one-time
elevated execution, never an automatic fallback. Commits preserve configured
hooks and signing, with no tool-added attribution trailer.

For classified read-only Bash commands, the macOS runner narrows workspace writes
to an empty scope, including when a caller otherwise permits editing `AGENTS.md`.
Configured Git helpers inherit that restriction. The tool reports read-only
effects to the desktop only after its backend confirms this enforcement;
unsandboxed execution does not make that promise. When file read denials exist,
the sandbox also denies the workspace repository's Git metadata and historical
objects, including enclosing-repository and linked-worktree metadata. Ordinary
nested `.git` directories are blocked as well. Unsupported alternate object
stores fail closed; undiscovered nested gitdir pointers or independently copied
object stores are outside this path-based protection.

The retained `git_apply_patch` tool conservatively rejects any
file read/write deny or scoped write/process policy, including an explicit empty
scope. Its fixed Git subprocesses disable hooks and `core.fsmonitor`, inspect
effective filter configuration at dispatch, and reject configured
`filter.*.clean`, `.process`, or `.smudge` commands. Each subprocess rechecks
current authorization immediately before its guardian receives execution
permission; final checks prevent buffered results escaping after revocation.
This narrow tool retains patch integration checks;
filter-dependent operations require an authorized Bash command.

These paths are covered by
[`discovery-resource-policy.test.ts`](../packages/tools/src/discovery-resource-policy.test.ts),
including cross-tool denials, recursive aliases, revoked grants, real Git
history/hooks/clean filters, last-dispatch revocation, and a 200-file policy-load
budget.

## Explicit limits

This is cooperative serialization between these built-in file tools, including
separate executors and Host processes. Shell commands, external editors, and
arbitrary extension handlers do not acquire these locks. Their untracked changes
prevent automatic restoration of changed files. The default Host does not create
file snapshots for Bash: its execution permission patterns describe commands,
not a known file write set.
Content checks catch changes observed before the final filesystem mutation, but
portable path-based filesystem APIs cannot provide an atomic compare-and-swap
against an uncooperative writer. Permission/symlink checks and the cooperative
lock are not substitutes for operating-system isolation. Multi-operation patches
also retain their existing non-transactional filesystem semantics: an error after
an earlier successful operation may leave partial effects, recorded by the normal
tool/snapshot recovery path. Restore also remains a sequence of per-file atomic
replacements, not a filesystem transaction: a later I/O failure, cancellation, or
uncooperative external mutation may leave earlier files restored. Known ownership
and version conflicts are checked across all files before any restore begins.

The focused regression suite uses real temporary files, separate sessions and
executors, two Bun processes, restored modification times, aliases, cancellation,
and SIGKILL of a lock holder:
[`file-observation.test.ts`](../packages/tools/src/file-observation.test.ts) and
[`snapshot.test.ts`](../packages/tools/src/snapshot.test.ts). Snapshot regressions
include same-lock waiting/cancellation, a competing built-in writer, complete-set
conflict preflight, writer-process exit, version 2 compatibility, unknown
postimages, missing journal epochs, and same-size backup corruption.
It verifies program behavior with fake approvals; it is not a paid-model capability
evaluation.
