import { createChiliHost } from "@chili/host";
const [cwd, chiliHome] = process.argv.slice(2);
const host = await createChiliHost({ cwd, chiliHome, model: "fake", mcpConnectMode: "eager", staleTurnRecoveryIntervalMs: false });
console.log("HOST_READY");
setInterval(() => {}, 1_000);
process.on("SIGTERM", () => { void host.close().then(() => process.exit(0)); });
