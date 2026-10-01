import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ModelRouter, ModelStreamEvent } from "@chili/core";
import type { ChiliEvent, SessionId } from "@chili/protocol";
import { createUnsandboxedBashRunner } from "@chili/tools";
import { createCliHarness, type CliHarness } from "./harness.js";

type ScriptedCall = { name: string; input: unknown };

// Only the model is scripted: tools, shell, HTTP server, files, and lifecycle are real.
test("a root task runs, observes, repairs, and rechecks a service across ordinary replies", async () => {
  const fixture = await createFixture();
  const sessionId = "session_working_service" as SessionId;
  const otherSessionId = "session_other_service" as SessionId;
  try {
    await fixture.harness.service.createSession({ sessionId });
    await fixture.harness.service.createSession({ sessionId: otherSessionId });
    const started = await fixture.call(sessionId, [{
      name: "bash", input: { command: `${shellQuote(process.execPath)} server.mjs`, background: true },
    }]);
    expect(started[0]?.status).toBe("completed");
    const processId = started[0]?.output?.match(/Process (process_[\w-]+): running/)?.[1];
    expect(processId).toBeDefined();
    const { port, pid } = await fixture.ready();
    expect(await responseBody(port)).toBe("broken");

    const probe = `${shellQuote(process.execPath)} -e ${shellQuote(
      `console.log(await (await fetch("http://127.0.0.1:${port}")).text())`,
    )}`;
    const observed = await fixture.call(sessionId, [
      { name: "bash", input: { command: probe } },
      { name: "process", input: { action: "read", processId } },
    ]);
    expect(observed.every((result) => result.status === "completed")).toBe(true);
    expect(observed[0]?.output).toContain("broken");
    expect(observed[1]?.output).toContain("request broken");

    const isolated = await fixture.call(otherSessionId, [
      { name: "process", input: { action: "list" } },
      { name: "process", input: { action: "stop", processId } },
    ]);
    expect(isolated[0]?.output).toBe("[]");
    expect(isolated[1]?.status).toBe("failed");
    expect(await responseBody(port)).toBe("broken");

    const repaired = await fixture.call(sessionId, [
      { name: "read", input: { filePath: "answer.txt" } },
      { name: "edit", input: { filePath: "answer.txt", oldString: "broken", newString: "fixed" } },
      { name: "bash", input: { command: probe } },
      { name: "process", input: { action: "read", processId } },
    ]);
    expect(repaired.every((result) => result.status === "completed")).toBe(true);
    expect(repaired[2]?.output).toContain("fixed");
    expect(repaired[3]?.output).toContain("request fixed");
    expect(await responseBody(port)).toBe("fixed");
    expect((await fixture.ready()).pid).toBe(pid);

    // Steering changes the model turn; an explicit idle Stop also owns services.
    expect(await fixture.harness.service.interrupt(sessionId, "desktop_steer")).toBe(false);
    expect(await responseBody(port)).toBe("fixed");
    expect(await fixture.harness.service.interrupt(sessionId)).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    const stopped = await fixture.call(sessionId, [{ name: "process", input: { action: "read", processId } }]);
    expect(stopped[0]?.output).toContain(`Process ${processId}: stopped`);
  } finally {
    await fixture.cleanup();
  }
}, 20_000);

test("archiving and closing the harness drain services whose model turns already completed", async () => {
  const fixture = await createFixture();
  try {
    for (const reason of ["archive", "close"] as const) {
      const sessionId = `session_service_${reason}` as SessionId;
      await fixture.harness.service.createSession({ sessionId });
      await rm(join(fixture.cwd, "server-ready.json"), { force: true });
      const result = await fixture.call(sessionId, [{
        name: "bash", input: { command: `${shellQuote(process.execPath)} server.mjs`, background: true },
      }]);
      expect(result[0]?.status).toBe("completed");
      const { port, pid } = await fixture.ready();
      expect(await responseBody(port)).toBe("broken");
      if (reason === "archive") await fixture.harness.service.archiveSession(sessionId);
      else await fixture.harness.close();
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally {
    await fixture.cleanup();
  }
}, 15_000);

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "chili-managed-integration-"));
  const cwd = join(root, "repo");
  let harness: CliHarness | undefined;
  const calls: ScriptedCall[] = [];
  const model: ModelRouter = {
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      const call = calls.shift();
      if (call) {
        expect(input.tools.some((tool) => tool.name === call.name)).toBe(true);
        yield { type: "tool_call", ...call };
        yield { type: "finish", reason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "The tool step has finished." };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  try {
    await mkdir(cwd);
    await writeFile(join(cwd, "answer.txt"), "broken\n");
    await writeFile(join(cwd, "server.mjs"), `
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
const server = createServer((_request, response) => {
  const answer = readFileSync("answer.txt", "utf8").trim();
  console.log("request " + answer);
  response.end(answer);
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  writeFileSync("server-ready.json", JSON.stringify({ port, pid: process.pid }));
  console.log("ready " + port);
});
`);
    harness = await createCliHarness({
      cwd, chiliHome: join(root, "home"), model: "fake", modelRouter: model,
      quiet: true, yes: true, mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false,
      // Exercise the production process runner without depending on a host sandbox's network policy.
      bashRunner: createUnsandboxedBashRunner(),
    });
    const activeHarness = harness;
    return {
      cwd,
      harness: activeHarness,
      async call(sessionId: SessionId, next: ScriptedCall[]) {
        const previous = await activeHarness.store.events({ sessionId, type: "tool.call_finished" });
        calls.push(...next);
        expect((await activeHarness.service.submitPrompt({ sessionId, text: "Perform the next service operation." })).status)
          .toBe("completed");
        expect(calls).toHaveLength(0);
        const events = await activeHarness.store.events({ sessionId, type: "tool.call_finished" });
        const outcomes = events.slice(previous.length).map((event) => {
          if (event.type !== "tool.call_finished") throw new Error("Unexpected event type");
          return event.payload as Extract<ChiliEvent, { type: "tool.call_finished" }>["payload"];
        });
        expect(outcomes).toHaveLength(next.length);
        return outcomes;
      },
      async ready(): Promise<{ port: number; pid: number }> {
        const deadline = Date.now() + 5_000;
        while (true) {
          try {
            return JSON.parse(await readFile(join(cwd, "server-ready.json"), "utf8"));
          } catch (error) {
            if (Date.now() >= deadline) throw error;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          }
        }
      },
      async cleanup() {
        try {
          await activeHarness.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await harness?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function responseBody(port: number): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2_000) })).text();
}
