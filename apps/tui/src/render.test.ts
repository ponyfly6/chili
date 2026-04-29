import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { SessionId, ThreadId } from "@chili/protocol";
import { parseArgs, teamLiveStreamInput } from "./index.js";

test("parses runtime flags and keeps Team Live stream unscoped for child-session events", () => {
  const controller = new AbortController();

  expect(parseArgs([])).toMatchObject({
    baseUrl: "http://127.0.0.1:4777",
    runLoop: false,
    once: false,
    teamLive: false,
  });
  expect(parseArgs(["--url", "http://runtime.test", "--team", "team_live", "--team-live", "--run-loop", "--once", "--max-cycles", "2"])).toMatchObject({
    baseUrl: "http://runtime.test",
    teamId: "team_live",
    teamLive: true,
    runLoop: true,
    once: true,
    maxCycles: 2,
  });

  const streamInput = teamLiveStreamInput(
    { sessionId: "session_live" as SessionId, threadId: "thread_live" as ThreadId },
    controller.signal,
    "event_live",
  );
  expect(streamInput.signal).toBe(controller.signal);
  expect(streamInput.afterEventId).toBe("event_live");
  expect(streamInput.sessionId).toBeUndefined();
  expect(streamInput.threadId).toBeUndefined();
});

test("apps/tui source does not import core, server, or store packages", async () => {
  const root = join(import.meta.dir);
  const files = await sourceFiles(root);
  const forbidden = /from\s+["'](?:@chili\/(?:core|server|store)|.*packages\/(?:core|server|store)\b)/;

  for (const file of files) {
    const source = await readFile(file, "utf8");
    expect(source, relative(root, file)).not.toMatch(forbidden);
  }
});

async function sourceFiles(dir: string): Promise<string[]> {
  const output: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      output.push(...await sourceFiles(path));
      continue;
    }
    if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) output.push(path);
  }
  return output;
}
