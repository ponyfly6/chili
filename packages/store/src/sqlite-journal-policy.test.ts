import { describe, expect, test } from "bun:test";
import { sqliteJournalPolicy } from "./sqlite-journal-policy.js";

describe("sqliteJournalPolicy", () => {
  test.each([
    ["3.44.5", "delete", false],
    ["3.44.6", "wal", true],
    ["3.44.7", "wal", true],
    ["3.45.0", "delete", false],
    ["3.50.6", "delete", false],
    ["3.50.7", "wal", true],
    ["3.50.8", "wal", true],
    ["3.51.0", "delete", false],
    ["3.51.1", "delete", false],
    ["3.51.2", "delete", false],
    ["3.51.3", "wal", true],
    ["3.52.0", "wal", true],
    ["4.0.0", "wal", true],
  ] as const)("selects %s safely", (version, journalMode, walResetSafe) => {
    expect(sqliteJournalPolicy(version)).toEqual({
      sqliteVersion: version,
      journalMode,
      walResetSafe,
      reason: walResetSafe ? "wal-reset-fixed" : "wal-reset-affected-or-unknown",
    });
  });

  test.each(["", "3.51", "3.51.3-custom", "not-a-version"])(
    "falls back to rollback journaling for unrecognized version %p",
    (version) => {
      expect(sqliteJournalPolicy(version)).toEqual({
        sqliteVersion: version,
        journalMode: "delete",
        walResetSafe: false,
        reason: "wal-reset-affected-or-unknown",
      });
    },
  );
});
