#!/usr/bin/env bun
/** Real-device preparation only by default. No CA installation or automatic pairing approval. */
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { networkInterfaces, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createBrowserTestCertificate, runCommand } from "../apps/desktop/e2e/remote-control-fixtures.js";
import { responsesFixtureReviewAction, responsesFixtureUserText, writeResponsesFixtureText, writeResponsesFixtureTool } from "../apps/desktop/e2e/responses-fixture.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const desktopRoot = join(repositoryRoot, "apps/desktop");
const fixtureKey = "chili-device-local-fixture-only";
const deviceQuestion = { id: "device_continue", header: "真机验证", question: "要继续真机验证吗？", options: [
  { label: "继续", description: "让真实桌面任务继续运行。" }, { label: "稍后", description: "记录这次回答。" },
] };
const args = process.argv.slice(2);
const help = "bun scripts/mobile-device-fixture.ts [--help | --launch /absolute/prepared-directory]\nDefault: prepare files only. Optional CHILI_DEVICE_FIXTURE_ADDRESS and CHILI_DEVICE_FIXTURE_PORT (default 57443).\n";
if (args[0] === "--help" && args.length === 1) { process.stdout.write(help); process.exit(0); }
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--launch" && isAbsolute(args[1]!)), help);

interface Configuration {
  version: 1;
  directory: string;
  bindAddress: string;
  port: number;
  origin: string;
}
const addresses = Object.entries(networkInterfaces()).sort(([a], [b]) => Number(!a.startsWith("en")) - Number(!b.startsWith("en")))
  .flatMap(([, rows]) => rows ?? []).filter((row) => row.family === "IPv4" && !row.internal
    && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(row.address)).map((row) => row.address);
let config: Configuration;
if (args.length === 0) {
  const bindAddress = process.env.CHILI_DEVICE_FIXTURE_ADDRESS ?? addresses[0];
  assert.ok(bindAddress && addresses.includes(bindAddress), "Choose an existing RFC1918 LAN IPv4 address");
  const port = Number(process.env.CHILI_DEVICE_FIXTURE_PORT ?? "57443");
  assert.ok(Number.isInteger(port) && port > 1024 && port <= 65_535, "Invalid fixture port");
  const directory = await mkdtemp(join(tmpdir(), "chili-real-device-"));
  for (const name of ["workspace", "home", "user-data", "tmp", "artifacts"]) await mkdir(join(directory, name));
  await writeFile(join(directory, "workspace/README.md"), "# Isolated real iPhone test workspace\nOnly deterministic local model responses are used.\n");
  await runCommand("/usr/bin/git", ["init", "--quiet", join(directory, "workspace")]);
  const certificate = await createBrowserTestCertificate(join(directory, "certificate"), bindAddress);
  // DER public CA is convenient for manual AirDrop/profile installation. No private key is exported.
  await writeFile(join(directory, "Chili-Test-CA.cer"), new X509Certificate(await readFile(certificate.authority)).raw);
  config = { version: 1, directory, bindAddress, port, origin: `https://${bindAddress}:${port}` };
  await writeFile(join(directory, "fixture.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...config, started: false, caPath: join(directory, "Chili-Test-CA.cer"),
    launch: `bun scripts/mobile-device-fixture.ts --launch ${directory}`,
    desktopTask: "Select DeepSeek V4 Pro, then create a task with prompt: 手机验证",
    phoneQuestion: "要继续真机验证吗？", slowPrompt: "停止测试", trustInstalled: false, pairingAutoApproved: false }, null, 2)}\n`);
  process.exit(0);
}

const directory = resolve(args[1]!);
config = JSON.parse(await readFile(join(directory, "fixture.json"), "utf8")) as Configuration;
assert.equal(config.version, 1);
assert.equal(config.directory, directory);
assert.ok(addresses.includes(config.bindAddress), "Prepared LAN address changed; prepare a new fixture and certificate");
assert.ok(Number.isInteger(config.port) && config.port > 1024 && config.port <= 65_535);
assert.equal(config.origin, `https://${config.bindAddress}:${config.port}`);
for (const path of ["out/main/index.js", "out/renderer/index.html", "out/preload/index.js"]) await access(join(desktopRoot, path));
await access(join(repositoryRoot, "apps/control-web/dist/index.html"));
const counts = { requests: 0, reviewRequests: 0, questionsAsked: 0, answersReceived: 0, completedCommands: 0, stoppedStreams: 0, failures: 0 };
const reviewWorkspace = await realpath(join(directory, "workspace"));
const persistEvidence = () => writeFile(join(directory, "artifacts/model-evidence.json"), `${JSON.stringify({
  fixture: "local model only; Electron, HTTPS, sidecar and runtime are production", ...counts,
}, null, 2)}\n`);
const provider = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // Unpackaged Electron trusts its explicit development renderer origin.
    // Match the working E2E launch: serve only built renderer files on this
    // loopback fixture, without relaxing the production IPC origin policy.
    if (request.method === "GET") {
      const asset = url.pathname.replace(/^\/renderer\//u, "");
      if (!/^(index\.html|assets\/[\w.-]+)$/u.test(asset)) { response.writeHead(404); response.end(); return; }
      const bytes = await readFile(join(desktopRoot, "out/renderer", asset));
      response.writeHead(200, { "content-type": asset.endsWith(".html") ? "text/html"
        : asset.endsWith(".css") ? "text/css" : "text/javascript" });
      response.end(bytes); return;
    }
    assert.equal(request.method, "POST");
    assert.ok(url.pathname.endsWith("/responses"));
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
    let raw = "";
    for await (const chunk of request) { raw += String(chunk); assert.ok(Buffer.byteLength(raw) < 4_000_000); }
    const body = JSON.parse(raw) as { input: { type?: string; role?: string; call_id?: string; output?: unknown }[] };
    const review = responsesFixtureReviewAction(body);
    if (review) {
      assert.equal(review.toolName, "request_user_input", "Only the isolated device fixture question may be reviewed");
      assert.equal(await realpath(review.cwd), reviewWorkspace);
      assert.deepEqual(review.input, { questions: [deviceQuestion] });
      const taskCounts = [counts.requests, counts.questionsAsked, counts.answersReceived, counts.completedCommands, counts.stoppedStreams];
      counts.reviewRequests += 1;
      await persistEvidence();
      writeResponsesFixtureText(response, `device_review_${counts.reviewRequests}`, JSON.stringify({
        decision: "allow", reason: "Allow this exact question in the isolated device fixture workspace.",
      }), true);
      assert.deepEqual([counts.requests, counts.questionsAsked, counts.answersReceived, counts.completedCommands, counts.stoppedStreams],
        taskCounts, "Review requests must not count as task turns, answers or stopped streams");
      return;
    }
    const text = responsesFixtureUserText(body);
    const userMessages = body.input.filter((item) => item.role === "user");
    const callId = `device_question_${userMessages.length}`;
    const toolResult = body.input.findLast((item) => item.type === "function_call_output" && item.call_id === callId);
    const question = String(text).includes("手机验证");
    const slow = String(text).includes("停止测试");
    const ask = question && !toolResult;
    counts.requests += 1;
    if (ask) counts.questionsAsked += 1;
    else if (question && toolResult) counts.answersReceived += 1;
    else if (!slow) counts.completedCommands += 1;
    await persistEvidence();
    const id = `device_fixture_${counts.requests}`;
    if (slow) {
      response.once("close", () => { counts.stoppedStreams += 1; void persistEvidence(); });
      writeResponsesFixtureText(response, id, "测试任务正在运行，请在手机点停止。", false);
      return;
    }
    if (ask) writeResponsesFixtureTool(response, id, "request_user_input", { questions: [deviceQuestion] }, callId);
    else writeResponsesFixtureText(response, id, question ? "已收到真机回答，真实桌面任务已继续。" : "已收到手机指令，真实桌面运行时已执行。", true);
  })().catch(() => { counts.failures += 1; void persistEvidence(); response.statusCode = 500; response.end("Local fixture request failed"); });
});
await new Promise<void>((done, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", done); });
const address = provider.address();
assert.ok(address && typeof address !== "string");
const electronPath = createRequire(join(desktopRoot, "package.json"))("electron") as string;
// Expose Chromium's accessibility tree for the human/CUA-operated fixture UI.
const child = Bun.spawn({ cmd: [electronPath, "--force-renderer-accessibility", desktopRoot], cwd: repositoryRoot, stdin: "ignore", stdout: "inherit", stderr: "inherit", env: {
  PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh", LANG: "C.UTF-8",
  HOME: join(directory, "home"), CHILI_HOME: join(directory, "home"), TMPDIR: join(directory, "tmp"),
  CHILI_BUN_PATH: process.execPath, CHILI_DESKTOP_WORKSPACE: join(directory, "workspace"),
  CHILI_DESKTOP_USER_DATA: join(directory, "user-data"), CHILI_DESKTOP_DISABLE_DEVTOOLS: "1", CHILI_DESKTOP_MODEL: "deepseek",
  ELECTRON_RENDERER_URL: `http://127.0.0.1:${address.port}/renderer/index.html`,
  DEEPSEEK_API_KEY: fixtureKey, DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, DEEPSEEK_MODEL: "deepseek-v4-pro",
  NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1",
  CHILI_REMOTE_BIND_ADDRESS: config.bindAddress, CHILI_REMOTE_PORT: String(config.port), CHILI_REMOTE_ORIGIN: config.origin,
  CHILI_REMOTE_TLS_CERT: join(directory, "certificate/localhost.pem"), CHILI_REMOTE_TLS_KEY: join(directory, "certificate/localhost-key.pem"),
  CHILI_REMOTE_WEB_ROOT: join(repositoryRoot, "apps/control-web/dist"),
} });
process.stdout.write(`Isolated desktop started. Enable phone access and approve pairing in its UI. Phone address: ${config.origin}\n`);
process.once("SIGINT", () => child.kill("SIGTERM"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
try { process.exitCode = await child.exited; }
finally { provider.closeAllConnections(); await new Promise<void>((done) => provider.close(() => done())); await persistEvidence(); }
