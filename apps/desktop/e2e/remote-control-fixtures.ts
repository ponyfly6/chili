import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

export interface TestCertificate {
  certificate: string;
  key: string;
  authority: string;
  fingerprint: string;
}

/** Trust exists only inside this disposable Firefox profile, never the OS. */
export async function createBrowserTestCertificate(directory: string, privateAddress = "127.0.0.1"): Promise<TestCertificate> {
  await mkdir(directory, { recursive: true });
  const authority = join(directory, "authority.pem");
  const certificate = join(directory, "localhost.pem");
  const key = join(directory, "localhost-key.pem");
  const configuration = join(directory, "certificate.cnf");
  await writeFile(configuration, [
    "[req]", "distinguished_name=dn", "prompt=no", "[dn]", "CN=Chili isolated E2E localhost",
    "[server]", `subjectAltName=IP:127.0.0.1,DNS:localhost${privateAddress === "127.0.0.1" ? "" : `,IP:${privateAddress}`}`, "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth", "",
  ].join("\n"));
  await runCommand("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
    "-subj", "/CN=Chili temporary E2E CA", "-keyout", join(directory, "authority-key.pem"), "-out", authority]);
  await runCommand("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256",
    "-config", configuration, "-keyout", key, "-out", join(directory, "localhost.csr")]);
  await runCommand("openssl", ["x509", "-req", "-in", join(directory, "localhost.csr"),
    "-CA", authority, "-CAkey", join(directory, "authority-key.pem"), "-CAcreateserial", "-days", "1",
    "-sha256", "-extfile", configuration, "-extensions", "server", "-out", certificate]);
  const parsed = new X509Certificate(await readFile(certificate));
  return { certificate, key, authority, fingerprint: createHash("sha256").update(parsed.raw).digest("hex") };
}

export async function trustTestAuthorityInProfile(profile: string, authority: string): Promise<void> {
  await mkdir(profile, { recursive: true });
  await runCommand("certutil", ["-N", "-d", `sql:${profile}`, "--empty-password"]);
  await runCommand("certutil", ["-A", "-d", `sql:${profile}`, "-n", "Chili temporary E2E authority",
    "-t", "C,,", "-i", authority]);
}

export async function runCommand(executable: string, args: readonly string[], cwd?: string): Promise<string> {
  const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, `${executable} failed (${code}): ${stderr.slice(-8_000)}`);
    return stdout;
  } finally { clearTimeout(timer); }
}

export async function waitUntil(label: string, predicate: () => boolean | Promise<boolean>, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out: ${label}`);
}

export interface ModelRequest { text: string; aborted: boolean; slow: boolean }
export const FIXTURE_KEY = "chili-remote-e2e-local-model-only";

/** Only the model is a fixture. All control, queue, persistence and sidecar code is production. */
export async function startModelFixture(desktopRoot: string): Promise<{
  origin: string;
  requests: ModelRequest[];
  failures: string[];
  stop(): Promise<void>;
}> {
  const requests: ModelRequest[] = [];
  const failures: string[] = [];
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : String(error));
      response.statusCode = 500;
      response.end("Fixture failed");
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET") {
      const asset = url.pathname.replace(/^\/renderer\//u, "");
      if (!/^(index\.html|assets\/[a-zA-Z\d._-]+)$/u.test(asset)) {
        response.statusCode = 404; response.end(); return;
      }
      const bytes = await readFile(join(desktopRoot, "out", "renderer", asset));
      response.setHeader("Content-Type", asset.endsWith(".html") ? "text/html" : asset.endsWith(".css") ? "text/css" : "text/javascript");
      response.end(bytes); return;
    }
    assert.ok(url.pathname.endsWith("/chat/completions"));
    assert.equal(request.headers.authorization, `Bearer ${FIXTURE_KEY}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
      assert.ok(size <= 2_000_000, "Model fixture body bound"); chunks.push(bytes);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: { role: string; content: unknown }[] };
    const latest = body.messages.findLast((message) => message.role === "user");
    assert.equal(typeof latest?.content, "string");
    const text = latest!.content as string;
    const observed: ModelRequest = { text, aborted: false, slow: text.includes("[slow]") };
    requests.push(observed);
    const id = `remote_fixture_${requests.length}`;
    if (!observed.slow) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id, model: "deepseek-v4-pro", choices: [{ index: 0, finish_reason: "stop",
        message: { role: "assistant", content: `Remote fixture response: ${text}` } }],
        usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    response.write(`data: ${JSON.stringify({ id, model: "deepseek-v4-pro", choices: [{ index: 0, finish_reason: null,
      delta: { content: `Remote fixture stream: ${text}` } }] })}\n\n`);
    response.once("close", () => { observed.aborted = true; });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { origin: `http://127.0.0.1:${address.port}`, requests, failures,
    async stop() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
