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

test("does not alter genuine model-authored assistant text", () => {
  const text = "Explain <html> and token=example literally";
  expect(publicSyntheticAssistantText(text, false)).toBe(text);
});
