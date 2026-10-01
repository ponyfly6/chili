import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ModelRouter } from "@chili/core";
import { parseRuntimeMessageArray } from "@chili/protocol";
import { createRuntimeHttpHandler } from "@chili/server";
import { createCliHarness, type CliHarness } from "./harness.js";
import { runSessionCommand } from "./runner.js";

test("CLI and HTTP command submissions enforce the same tool scope and preserve display text", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-command-entrypoints-"));
  const cwd = join(root, "repo");
  const sessionCwd = join(root, "session-repo");
  let harness: CliHarness | undefined;
  let streamCalls = 0;
  const advertisedTools: string[][] = [];
  const model: ModelRouter = {
    async *stream(input) {
      advertisedTools.push(input.tools.map((tool) => tool.name));
      if (streamCalls++ % 2 === 0) {
        yield { type: "tool_call", name: "write", input: { filePath: "forbidden.txt", content: "must not be written" } };
        yield { type: "finish", reason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "The write was blocked." };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  try {
    await mkdir(cwd);
    await mkdir(join(sessionCwd, ".chili", "commands"), { recursive: true });
    await writeFile(join(sessionCwd, ".chili", "commands", "review.md"), [
      "---",
      "allowedTools: [read, write]",
      "writeScope: [REPORT.md]",
      "---",
      "Review $ARGUMENTS",
    ].join("\n"));
    harness = await createCliHarness({
      cwd, chiliHome: join(root, "home"), model: "fake", modelRouter: model,
      quiet: true, yes: true, mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false,
    });
    const cli = await harness.service.createSession({ cwd: sessionCwd });
    const http = await harness.service.createSession({ cwd: sessionCwd });
    await runSessionCommand({
      harness, sessionId: cli.sessionId, commandId: "prompt.project.review", args: "src/app.ts", maxTurns: 3,
    });
    const handler = createRuntimeHttpHandler({
      service: harness.service, store: harness.events, commands: harness.commands,
    });
    const response = await handler(new Request(`http://localhost/sessions/${http.sessionId}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "prompt.project.review", args: "src/app.ts" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed" });
    expect(streamCalls).toBe(4);
    expect(advertisedTools[0]).toEqual(advertisedTools[2]);
    expect(advertisedTools[0]).toContain("write");
    expect(advertisedTools[0]).not.toContain("bash");
    for (const session of [cli, http]) {
      const messages = await harness.store.messages(session.sessionId);
      expect(messages.find((message) => message.role === "user")?.parts).toEqual([
        expect.objectContaining({ type: "text", text: "Review src/app.ts", displayText: "/prompt project review src/app.ts" }),
      ]);
      const finished = await harness.store.events({ sessionId: session.sessionId, type: "tool.call_finished" });
      expect(finished).toHaveLength(1);
      expect(finished[0]?.payload).toMatchObject({ status: "failed", error: expect.stringContaining("write scope") });
    }
    await expect(readFile(join(sessionCwd, "forbidden.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // Invalid session state is checked before expanding commands (which may call MCP).
    await harness.service.archiveSession(cli.sessionId);
    let expanded = false;
    const originalRun = harness.commands.run;
    harness.commands.run = async (input) => {
      expanded = true;
      return originalRun.call(harness!.commands, input);
    };
    await expect(runSessionCommand({
      harness, sessionId: cli.sessionId, commandId: "prompt.project.review", maxTurns: 3,
    })).rejects.toThrow("not active");
    expect(expanded).toBe(false);
    const abort = new AbortController();
    abort.abort(new Error("user stopped"));
    await expect(runSessionCommand({
      harness, sessionId: http.sessionId, commandId: "prompt.project.review", maxTurns: 3, signal: abort.signal,
    })).rejects.toThrow("user stopped");
    expect(expanded).toBe(false);
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("CLI and HTTP reject invalid command text before persisting messages or running the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-command-validation-"));
  const cwd = join(root, "repo");
  let harness: CliHarness | undefined;
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream() {
      modelCalls += 1;
      yield { type: "text_delta", text: "Reviewed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  try {
    const commandsDir = join(cwd, ".chili", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, "review.md"), "Review $ARGUMENTS");
    await writeFile(join(commandsDir, "plain.md"), "Review the repository");
    await writeFile(join(commandsDir, "invalid.md"), "Review \u001b[31mthe repository");
    await writeFile(join(commandsDir, "oversized.md"), "x".repeat(8_000_001));
    harness = await createCliHarness({
      cwd, chiliHome: join(root, "home"), model: "fake", modelRouter: model,
      quiet: true, mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false,
    });
    const handler = createRuntimeHttpHandler({
      service: harness.service, store: harness.events, commands: harness.commands,
    });
    const cases = [
      { commandId: "prompt.project.invalid", args: "", error: "unsafe control characters" },
      { commandId: "prompt.project.review", args: "src/\u0000app.ts", error: "unsafe control characters" },
      // The prompt ignores arguments, so only the visible invocation is invalid.
      { commandId: "prompt.project.plain", args: "src/\u0000app.ts", error: "unsafe control characters" },
      { commandId: "prompt.project.oversized", args: "", error: "must not exceed" },
    ];
    for (const entrypoint of ["cli", "command", "command_async"]) {
      const { sessionId } = await harness.service.createSession();
      const initialEvents = await harness.store.events({ sessionId });
      const callsBefore = modelCalls;
      for (const { commandId, args, error } of cases) {
        if (entrypoint === "cli") {
          await expect(runSessionCommand({
            harness, sessionId, commandId, args, maxTurns: 1,
          })).rejects.toThrow(error);
        } else {
          const response = await handler(new Request(`http://localhost/sessions/${sessionId}/${entrypoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ commandId, args }),
          }));
          expect(response.status).toBe(400);
        }
        expect(modelCalls).toBe(callsBefore);
        expect(await harness.store.messages(sessionId)).toEqual([]);
        expect(await harness.store.events({ sessionId })).toEqual(initialEvents);
      }

      // A rejected command must not poison the session or leave it reserved.
      await runSessionCommand({
        harness, sessionId, commandId: "prompt.project.review", args: "src/app.ts", maxTurns: 1,
      });
      expect(modelCalls).toBe(callsBefore + 1);
      expect(parseRuntimeMessageArray(await harness.store.messages(sessionId))).toHaveLength(2);
    }
  } finally {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
