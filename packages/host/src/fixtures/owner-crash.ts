import { createChiliHost } from "../host.js";
import { runProcess } from "@chili/tools";
const cwd = process.argv[2]!;
const host = await createChiliHost({ cwd, chiliHome: process.argv[3]!, model: "fake", mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false });
const session = await host.service.createSession();
await host.service.withSessionOperation(session.sessionId, async () => {
  await runProcess("/bin/sh", ["-c", "echo $$ > owned-child.pid; sleep 60"], { cwd });
});
await host.close();
