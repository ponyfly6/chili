import { expect, test } from "bun:test";
import { ProviderError } from "../packages/providers/src/index.js";
import { probeFailureCategory } from "./probe-minimax.js";

test("MiniMax probe mock checks Responses independently of legacy environment settings", async () => {
  const child = Bun.spawn([process.execPath, new URL("./probe-minimax.ts", import.meta.url).pathname, "--mock"], {
    env: { ...process.env, MINIMAX_MODEL: "MiniMax-M3[1m]", MINIMAX_ANTHROPIC_BASE_URL: "https://legacy.test/anthropic" },
    stdout: "pipe", stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(status).toBe(0);
  expect(stdout.trim()).toBe("minimax/MiniMax-M3 mock Responses probe ok");
  expect(stderr).toBe("");
});

test("MiniMax probe classifies failures without reflecting provider detail", () => {
  const detail = "private-detail-must-not-appear";
  expect(probeFailureCategory(new ProviderError(detail, { provider: "minimax", status: 400 })))
    .toBe("invalid_request (HTTP 400)");
  expect(probeFailureCategory(new ProviderError(detail, { provider: "minimax", status: 429, category: "quota_exhausted" })))
    .toBe("quota_exhausted (HTTP 429)");
  expect(probeFailureCategory(new Error(`MiniMax requires an API key ${detail}`))).toBe("missing-api-key");
  expect(probeFailureCategory(new Error(detail))).toBe("network-or-provider-response");
});
