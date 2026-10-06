import { McpStdioGuardianOwner, runMcpStdioGuardianEntrypoint } from "../stdio-guardian.ts";
import { createSdkMcpClient } from "../sdk-client.ts";

if (process.argv[2] === "--chili-mcp-stdio-guardian") {
  runMcpStdioGuardianEntrypoint();
} else {
  const [runtime, fixture, log, cwd] = process.argv.slice(2);
  const owner = await McpStdioGuardianOwner.create();
  const client = createSdkMcpClient({ name: "compiled-fixture", type: "stdio", command: runtime,
    args: [fixture, "modern", log], cwd, source: "user", enabled: true, required: true, trust: true, raw: {},
  }, { stdioGuardian: owner });
  try {
    const initialized = await client.initialize();
    if (initialized.protocolVersion !== "2026-07-28") throw new Error("Wrong protocol version");
    await client.listTools();
    console.log("COMPILED_GUARDIAN_OK");
  } finally {
    await client.close();
    await owner.close();
  }
}
