import { expect, test } from "bun:test";
import { containsRendererCredentialMaterial } from "./renderer-leak-audit.js";

test("distinguishes runtime token accounting from renderer credential material", () => {
  const snapshot = JSON.stringify({
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 384_000,
    inputTokens: 8,
    outputTokens: 8,
    tokenBudget: 500_000,
  });
  expect(containsRendererCredentialMaterial(snapshot)).toBe(false);

  for (const leaked of [
    { endpoint: "http://127.0.0.1:43123" },
    { endpoint: "http://localhost:43123" },
    { authorization: "Bearer renderer-secret" },
    { token: "renderer-secret" },
    { authToken: "renderer-secret" },
    { apiKey: "renderer-secret" },
    "chili.sidecar.credential.v1:renderer-secret",
  ]) {
    expect(containsRendererCredentialMaterial(JSON.stringify(leaked))).toBe(true);
  }
});
