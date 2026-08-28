import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAX_DESKTOP_ERROR_MESSAGE_BYTES,
  safeDesktopErrorMessage,
} from "../shared/safe-error.js";
import { parseDesktopResponse } from "../shared/contracts.js";

describe("desktop error messages", () => {
  test("redacts labeled and URL credentials through the protocol normalizer", () => {
    const password = "renderer-password-fixture";
    const clientSecret = "renderer-client-secret-fixture";
    const querySecret = "renderer-query-secret-fixture";
    const passwordMessage = safeDesktopErrorMessage(new Error(`password=${password}`));
    const clientSecretMessage = safeDesktopErrorMessage(new Error(`client_secret: ${clientSecret}`));
    const queryMessage = safeDesktopErrorMessage(new Error(
      `https://example.test/fail?token=${querySecret}`,
    ));

    expect(passwordMessage).not.toContain(password);
    expect(clientSecretMessage).not.toContain(clientSecret);
    expect(queryMessage).not.toContain(querySecret);
    expect(passwordMessage).toContain("password=[REDACTED]");
    expect(clientSecretMessage).toContain("client_secret: [REDACTED]");
    expect(queryMessage).toContain("token=[REDACTED]");
  });

  test("bounds a 5MiB worst-escaped message by exact UTF-8 bytes without splitting emoji", () => {
    const loopbackSecret = "renderer-loopback-secret-fixture";
    const unit = "\\\"😀";
    const repetitions = Math.ceil((5 * 1024 * 1024) / Buffer.byteLength(unit, "utf8"));
    const message = safeDesktopErrorMessage(new Error(
      `http://127.0.0.1:4312/fail?password=${loopbackSecret} ${unit.repeat(repetitions)}`,
    ));

    expect(Buffer.byteLength(message, "utf8")).toBe(MAX_DESKTOP_ERROR_MESSAGE_BYTES);
    expect(message).not.toContain(loopbackSecret);
    expect(message).not.toContain("127.0.0.1");
    expect(message).not.toContain("\ufffd");
  });

  test("removes 5MiB of forbidden controls before sidecar state crosses IPC", () => {
    const message = safeDesktopErrorMessage(new Error("\0".repeat(5 * 1024 * 1024)));

    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(MAX_DESKTOP_ERROR_MESSAGE_BYTES);
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/u);
    const parsed = parseDesktopResponse({ type: "app.state" }, {
      sidecar: { phase: "error", attempt: 0, error: message },
      queuedBySession: {},
    });
    expect(parsed.sidecar.error).toBe(message);
  });

  test("re-redacts a credential label that used a control character as a separator", () => {
    const secret = "control-separated-password";
    const message = safeDesktopErrorMessage(new Error(`password\0=${secret}\u007f`));

    expect(message).not.toContain(secret);
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(message).toContain("password=[REDACTED]");
  });

  test("routes both Electron and sidecar stderr messages through the shared sanitizer", async () => {
    const [mainSource, sidecarSource] = await Promise.all([
      readFile(resolve(import.meta.dirname, "index.ts"), "utf8"),
      readFile(resolve(import.meta.dirname, "../sidecar/index.ts"), "utf8"),
    ]);

    expect(mainSource).toContain("safeDesktopErrorMessage as safeLogMessage");
    expect(mainSource).not.toContain("function safeLogMessage");
    expect(sidecarSource).toContain("safeDesktopErrorMessage as safeErrorMessage");
    expect(sidecarSource).not.toContain("function safeErrorMessage");
  });
});
