import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createBrowserTestCertificate } from "../../desktop/e2e/remote-control-fixtures.js";

const certificate = process.env.CHILI_NATIVE_TEST_CERT;
const key = process.env.CHILI_NATIVE_TEST_KEY;
if (!certificate || !key) throw new Error("Set CHILI_NATIVE_TEST_CERT and CHILI_NATIVE_TEST_KEY to the simulator-trusted fixture certificate files.");
const directory = await mkdtemp(join(tmpdir(), "chili-native-negative-tls-"));
const untrusted = await createBrowserTestCertificate(directory);
let redirectTargetRequests = 0;
const respond = async (request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname;
  if (path === "/api/redirect") return new Response(null, { status: 307, headers: { location: "/api/redirect-target" } });
  if (path === "/api/redirect-target") { redirectTargetRequests++; return Response.json({ followed: true }); }
  if (path === "/api/stats") return Response.json({ redirectTargetRequests });
  if (path === "/api/large") return new Response("x".repeat(4096));
  if (path === "/api/slow") { await Bun.sleep(3000); return Response.json({ finished: true }); }
  return Response.json({ method: request.method, marker: request.headers.get("X-Chili-Control-Client"),
    origin: request.headers.get("Origin"), cookie: request.headers.get("Cookie"), body: await request.text() },
  { headers: { "set-cookie": "fixture=value; Secure; HttpOnly; Path=/" } });
};
const trustedServer = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: await readFile(certificate), key: await readFile(key) }, fetch: respond });
const untrustedServer = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: await readFile(untrusted.certificate), key: await readFile(untrusted.key) }, fetch: respond });
const config = { trustedOrigin: `https://127.0.0.1:${trustedServer.port}`, untrustedOrigin: `https://127.0.0.1:${untrustedServer.port}` };
await writeFile(resolve(import.meta.dir, "../native/ios/Tests/FixtureConfig.json"), JSON.stringify(config));
process.stdout.write(JSON.stringify(config) + "\n");
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { trustedServer.stop(true); untrustedServer.stop(true); process.exit(0); });
