import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChiliHost } from "../host.js";

const cwd = process.argv[2]!;
const host = await createChiliHost({
  cwd, chiliHome: process.argv[3]!, mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false,
  modelRouter: {
    async *stream() {
      await writeFile(join(cwd, "peer-running"), "running");
      while (!await access(join(cwd, "peer-release")).then(() => true, () => false)) await Bun.sleep(10);
      yield { type: "text_delta" as const, text: "Independent peer completed." };
      yield { type: "finish" as const, reason: "stop" as const };
    },
  },
});
try {
  const session = await host.service.createSession();
  await writeFile(join(cwd, "peer-session.id"), session.sessionId);
  const result = await host.service.submitPrompt({ sessionId: session.sessionId, text: "wait for the other Host" });
  await writeFile(join(cwd, "peer-completed"), result.status);
} finally { await host.close(); }
