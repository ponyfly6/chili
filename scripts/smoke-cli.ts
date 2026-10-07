import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SessionId } from "../packages/protocol/src/index.js";
import { SqliteEventStore } from "../packages/store/src/index.js";

const workspace = await mkdtemp(join(tmpdir(), "chili-cli-smoke-"));

try {
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "cli-smoke" }, null, 2), "utf8");
  for (const mode of ["auto-review", "full-access"] as const) {
    const proc = Bun.spawn([
      "bun", "run", "cli", "--", "--model", "fake",
      ...(mode === "full-access" ? ["--yes"] : []),
      "--chili-home", join(workspace, `profile-${mode}`), "--cwd", workspace, "read package",
    ], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(20_000),
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    assert.equal(code, 0, `${mode}: ${stderr}`);
    assert.match(stdout, /\[tool\] read/);
    assert.match(stdout, /I read the file and the tool loop works/);
    const sessionId = /\[session\]\s+(session_[^\s]+)/.exec(stdout)?.[1] as SessionId | undefined;
    assert.ok(sessionId, `${mode}: missing session ID`);
    const store = new SqliteEventStore(join(workspace, ".chili", "chili.sqlite"));
    try {
      const events = await store.events({ sessionId, limit: 100 }) as RuntimeEvent[];
      const read = events.find((event) => event.type === "tool.call_started" && event.payload.toolName === "read");
      assert.ok(read?.type === "tool.call_started", `${mode}: missing read call`);
      assert.ok(events.some((event) => event.type === "tool.call_finished"
        && event.payload.callId === read.payload.callId && event.payload.status === "completed"),
      `${mode}: read did not complete`);
      assert.ok(events.every((event) => !event.type.startsWith("approval.")), `${mode}: manual approval was emitted`);
    } finally {
      store.close();
    }
    console.log(`CLI ${mode} smoke ok`);
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}
