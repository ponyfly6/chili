export type SqliteJournalMode = "delete" | "wal";

export interface SqliteJournalPolicy {
  sqliteVersion: string;
  journalMode: SqliteJournalMode;
  walResetSafe: boolean;
  reason: "wal-reset-fixed" | "wal-reset-affected-or-unknown";
}

interface SqliteVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Selects WAL only for SQLite releases known to contain the WAL-reset fix.
 *
 * The upstream fix first shipped in 3.51.3, with backports on the 3.50 and
 * 3.44 release branches in 3.50.7 and 3.44.6. Unknown version strings are
 * deliberately conservative so a runtime packaging change cannot silently
 * re-enable the affected multi-connection mode.
 */
export function sqliteJournalPolicy(sqliteVersion: string): SqliteJournalPolicy {
  const version = parseSqliteVersion(sqliteVersion);
  const walResetSafe = version !== undefined && hasWalResetFix(version);
  return {
    sqliteVersion,
    journalMode: walResetSafe ? "wal" : "delete",
    walResetSafe,
    reason: walResetSafe ? "wal-reset-fixed" : "wal-reset-affected-or-unknown",
  };
}

function parseSqliteVersion(value: string): SqliteVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { major, minor, patch };
}

function hasWalResetFix(version: SqliteVersion): boolean {
  if (version.major > 3) return true;
  if (version.major < 3) return false;
  if (version.minor > 51) return true;
  if (version.minor === 51) return version.patch >= 3;
  if (version.minor === 50) return version.patch >= 7;
  if (version.minor === 44) return version.patch >= 6;
  return false;
}
