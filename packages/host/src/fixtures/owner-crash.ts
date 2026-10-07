import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChiliHost } from "../host.js";
import { runProcess } from "@chili/tools";
const cwd = process.argv[2]!;
const host = await createChiliHost({ cwd, chiliHome: process.argv[3]!, model: "fake", mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
const session = await host.service.createSession();
await writeFile(join(cwd, "owned-session.id"), session.sessionId);
await host.service.withSessionOperation(session.sessionId, async () => {
  await runProcess("/bin/sh", ["-c", "trap '' TERM; echo $$ > owned-child.pid; sleep 60"], { cwd });
});
await host.close();
