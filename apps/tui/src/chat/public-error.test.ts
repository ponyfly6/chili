import { expect, test } from "bun:test";
import { publicStatusReason, publicSyntheticAssistantText } from "./public-error.js";

const cloudflareHtml = `<!DOCTYPE html><html><head><title>codexapi.space | 502: Bad gateway</title></head>
<body><script>reveal()</script>Cloudflare Ray ID: abc Your IP: 103.151.173.205</body></html>`;

test("hides legacy provider markup and private response details", () => {
  const reason = publicStatusReason(cloudflareHtml);

  expect(reason).toBe("Provider request failed with HTTP 502 (unsafe markup response hidden)");
  expect(reason).not.toContain("codexapi.space");
  expect(reason).not.toContain("103.151.173.205");
  expect(reason).not.toContain("Ray ID");
});

test("bounds and redacts legacy plain error reasons", () => {
  const reason = publicStatusReason(`token=secret 103.151.173.205 ${"x".repeat(1_000)}`);

  expect(reason?.length).toBeLessThanOrEqual(600);
  expect(reason).toContain("token=[redacted-credential]");
  expect(reason).toContain("[redacted-ip]");
  expect(reason).not.toContain("secret");
});

test("sanitizes every synthetic assistant message, including plain credentials", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LXBheWxvYWQ.c2lnbmF0dXJl";
  const text = publicSyntheticAssistantText(
    `Model request failed: token=my-private-token jwt=${jwt} bearer sk-secret12345 from 103.151.173.205`,
    true,
  );

  expect(text).toContain("token=[redacted-credential]");
  expect(text).toContain("[redacted-jwt]");
  expect(text).toContain("bearer [redacted-token]");
  expect(text).toContain("[redacted-ip]");
  expect(text).not.toContain("my-private-token");
  expect(text).not.toContain(jwt);
  expect(text).not.toContain("sk-secret12345");
});

test("redacts credential variants, IPv6, and non-HTML markup in synthetic text", () => {
  const plain = publicSyntheticAssistantText(
    "password='hunter 2' basic QWxhZGRpbjpvcGVuIHNlc2FtZQ== https://alice:secretpass@example.test 2001:db8::1",
    true,
  );
  const markup = publicSyntheticAssistantText("upstream replied <error>private payload</error>", true);

  expect(plain).toContain("password=[redacted-credential]");
  expect(plain).toContain("basic [redacted-credential]");
  expect(plain).toContain("https://alice:[redacted-credential]@example.test");
  expect(plain).toContain("[redacted-ip]");
  expect(plain).not.toContain("hunter 2");
  expect(plain).not.toContain("QWxhZGRpb");
  expect(plain).not.toContain("secretpass");
  expect(plain).not.toContain("2001:db8::1");
  expect(markup).toBe("Provider request failed (unsafe markup response hidden)");
});

test("replaces synthetic provider markup before rendering", () => {
  const text = publicSyntheticAssistantText(`Model request failed: ${cloudflareHtml}`, true);

  expect(text).toBe("Model request failed: Provider request failed with HTTP 502 (unsafe markup response hidden)");
  expect(text).not.toContain("DOCTYPE");
});

test("preserves complete multiline failure checkpoints beyond the status-reason bound", () => {
  const checkpoint = [
    "Incomplete partial result saved before the model request failed. This is not a complete answer.",
    "",
    "Previously saved assistant progress:",
    `- ${"safe progress ".repeat(80)}`,
    "",
    "Tool activity completed before the failure:",
    "- read: completed (/repo/src/runtime.ts)",
    "",
    "The task remains incomplete. Continue after the model service recovers.",
  ].join("\n");

  const text = publicSyntheticAssistantText(checkpoint, true);

  expect(text).toBe(checkpoint);
  expect(text.length).toBeGreaterThan(600);
  expect(text).toContain("\n\nTool activity completed before the failure:\n");
  expect(text).toEndWith("The task remains incomplete. Continue after the model service recovers.");
});

test("redacts credentials and whole unsafe markup items inside failure checkpoints", () => {
  const checkpoint = [
    "Incomplete partial result saved before the model request failed. This is not a complete answer.",
    "",
    "Previously saved assistant progress:",
    "- preserved safe progress",
    "- token=my-private-token from 2001:db8::1",
    "- <error>private provider payload</error>",
    "  continuation must also stay hidden",
    "",
    "The task remains incomplete. Continue after the model service recovers.",
  ].join("\n");

  const text = publicSyntheticAssistantText(checkpoint, true);

  expect(text).toContain("\n- preserved safe progress\n");
  expect(text).toContain("token=[redacted-credential]");
  expect(text).toContain("[redacted-ip]");
  expect(text).toContain("- [unsafe markup hidden]");
  expect(text).toEndWith("The task remains incomplete. Continue after the model service recovers.");
  expect(text).not.toContain("my-private-token");
  expect(text).not.toContain("2001:db8::1");
  expect(text).not.toContain("private provider payload");
  expect(text).not.toContain("continuation must also stay hidden");
});

test("does not alter genuine model-authored assistant text", () => {
  const text = "Explain <html> and token=example literally";
  expect(publicSyntheticAssistantText(text, false)).toBe(text);
});
