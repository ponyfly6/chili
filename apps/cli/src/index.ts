#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import type { SessionId } from "@chili/protocol";
import { startRuntimeHttpServer } from "@chili/server";
import { DeferredApprovalQueue } from "@chili/tools";
import { parseArgs, usage } from "./args.js";
import { createCliHarness } from "./harness.js";
import { runPrompt } from "./runner.js";
import { resolveSession } from "./session.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    console.log(usage());
    return;
  }

  const approvalQueue = args.command === "serve" ? new DeferredApprovalQueue() : undefined;
  const harness = await createCliHarness({
    cwd: args.cwd,
    model: args.model,
    yes: args.yes,
    quiet: args.command === "sessions",
    ...(approvalQueue ? { approvalQueue } : {}),
  });

  try {
    if (args.command === "serve") {
      if (!approvalQueue) throw new Error("approval queue was not initialized");
      await serve({ harness, approvalQueue, host: args.host, port: args.port });
      return;
    }

    if (args.command === "sessions") {
      await printSessions(harness.store);
      return;
    }

    if (args.command === "revert") {
      if (!args.resume) throw new Error("revert requires --resume <session-id>");
      if (!args.snapshotId) throw new Error("revert requires a snapshot id");
      const sessionId = args.resume as SessionId;
      await harness.recovery.revert({ sessionId, snapshotId: args.snapshotId as never });
      console.log(`Reverted snapshot ${args.snapshotId}`);
      return;
    }

    const sessionInput = {
      service: harness.service,
      store: harness.store,
      cwd: harness.cwd,
    };
    const session = await resolveSession(args.resume ? { ...sessionInput, resume: args.resume } : sessionInput);

    console.log(`[session] ${session.sessionId}${session.isNew ? " (new)" : " (resumed)"}`);
    if (args.prompt) {
      const controller = installInterruptHandler();
      await runPrompt({
        harness,
        sessionId: session.sessionId,
        threadId: session.threadId,
        prompt: args.prompt,
        maxTurns: args.maxTurns,
        signal: controller.signal,
      });
      return;
    }

    await repl({
      harness,
      sessionId: session.sessionId,
      threadId: session.threadId,
      maxTurns: args.maxTurns,
    });
  } finally {
    harness.close();
  }
}

async function serve(input: {
  harness: Awaited<ReturnType<typeof createCliHarness>>;
  approvalQueue: DeferredApprovalQueue;
  host: string;
  port: number;
}): Promise<void> {
  const server = startRuntimeHttpServer({
    service: input.harness.service,
    store: input.harness.events,
    approvals: input.approvalQueue,
    hostname: input.host,
    port: input.port,
  });
  console.log(`[server] ${server.url}`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      input.approvalQueue.denyAll("Runtime server stopped.");
      server.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function printSessions(store: Awaited<ReturnType<typeof createCliHarness>>["store"]): Promise<void> {
  const sessions = await store.sessions();
  if (sessions.length === 0) {
    console.log("No sessions yet.");
    return;
  }
  for (const session of sessions) {
    console.log(`${session.id}\t${session.status}\t${new Date(session.updatedAt).toISOString()}\t${session.cwd}`);
  }
}

async function repl(input: {
  harness: Awaited<ReturnType<typeof createCliHarness>>;
  sessionId: SessionId;
  threadId: import("@chili/protocol").ThreadId;
  maxTurns: number;
}): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Type /help for commands, /exit to quit.");
  try {
    while (true) {
      const line = (await rl.question("chili> ")).trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") return;
      if (line === "/help") {
        console.log(["/help                 Show commands", "/sessions             List sessions", "/revert <snapshotId>  Revert a snapshot in this session", "/exit                 Quit"].join("\n"));
        continue;
      }
      if (line === "/sessions") {
        await printSessions(input.harness.store);
        continue;
      }
      if (line.startsWith("/revert ")) {
        const snapshotId = line.slice("/revert ".length).trim();
        await input.harness.recovery.revert({ sessionId: input.sessionId, threadId: input.threadId, snapshotId: snapshotId as never });
        console.log(`Reverted snapshot ${snapshotId}`);
        continue;
      }

      const controller = installInterruptHandler();
      await runPrompt({
        harness: input.harness,
        sessionId: input.sessionId,
        threadId: input.threadId,
        prompt: line,
        maxTurns: input.maxTurns,
        signal: controller.signal,
      });
    }
  } finally {
    rl.close();
  }
}

function installInterruptHandler(): AbortController {
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    console.log("\n[interrupt] cancelling current turn...");
    controller.abort();
  };
  process.once("SIGINT", onSigint);
  controller.signal.addEventListener(
    "abort",
    () => {
      process.removeListener("SIGINT", onSigint);
    },
    { once: true },
  );
  return controller;
}

main().catch((error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`chili: ${err.message}`);
  process.exitCode = 1;
});
