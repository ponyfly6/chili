import { describe, expect, test } from "bun:test";
import { createNativePostJson, type NativeBridge } from "./native-transport.js";
import type { NativeControlHttpRequest } from "@chili/remote-control/browser";

const id = "704fdbee-ec62-48d3-89cb-d1a25d9b0b98";
const request = (overrides: Partial<NativeControlHttpRequest> = {}): NativeControlHttpRequest => ({
  url: "https://chili.example/api/control/poll",
  headers: { "Content-Type": "application/json", "X-Chili-Control-Client": "native-v1", Authorization: "Bearer fixture" },
  body: "{}", maxResponseBytes: 1024, signal: new AbortController().signal, ...overrides,
});
function bridge(overrides: Partial<NativeBridge> = {}): NativeBridge {
  return { get: async () => ({ value: null }), set: async () => {}, remove: async () => {},
    postJson: async () => ({ status: 200, body: "{}" }), cancel: async () => {}, ...overrides };
}

describe("native HTTPS transport", () => {
  test("sends exactly one POST with only the protocol headers", async () => {
    const calls: unknown[] = [];
    const post = createNativePostJson(bridge({ postJson: async (options) => { calls.push(options); return { status: 200, body: "{}" }; } }), () => id);
    expect(await post(request())).toEqual({ status: 200, body: "{}" });
    expect(calls).toEqual([{ id, url: "https://chili.example/api/control/poll", headers: request().headers, body: "{}", maxResponseBytes: 1024 }]);
  });

  test("rejects cleartext, credentials in URLs, remote pages and browser-only headers before native code", async () => {
    let calls = 0;
    const post = createNativePostJson(bridge({ postJson: async () => { calls++; return { status: 200, body: "{}" }; } }));
    for (const url of ["http://chili.example/api/control/poll", "https://user:pass@chili.example/api/control/poll", "https://chili.example/", "https://chili.example/api/poll#fragment"]) {
      await expect(post(request({ url }))).rejects.toMatchObject({ code: "INVALID_NATIVE_REQUEST" });
    }
    for (const headers of [{ Origin: "https://chili.example" }, { "Sec-Fetch-Site": "same-origin" }, { Authorization: "a\r\nb" }]) {
      await expect(post(request({ headers }))).rejects.toMatchObject({ code: "INVALID_NATIVE_REQUEST" });
    }
    expect(calls).toBe(0);
  });

  test("rejects redirects and oversized native responses", async () => {
    await expect(createNativePostJson(bridge({ postJson: async () => ({ status: 302, body: "" }) }))(request())).rejects.toMatchObject({ code: "REDIRECT_NOT_ALLOWED" });
    await expect(createNativePostJson(bridge({ postJson: async () => ({ status: 200, body: "好".repeat(400) }) }))(request())).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  test("cancels an in-flight call without resending or requiring native completion", async () => {
    const controller = new AbortController();
    let sends = 0;
    const cancelled: string[] = [];
    const post = createNativePostJson(bridge({ postJson: () => { sends++; return new Promise(() => {}); }, cancel: async ({ id }) => { cancelled.push(id); } }), () => id);
    const pending = post(request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toEqual([id]);
    expect(sends).toBe(1);
  });

  test("an already cancelled call never reaches native code", async () => {
    let sends = 0;
    const post = createNativePostJson(bridge({ postJson: async () => { sends++; return { status: 200, body: "{}" }; } }));
    await expect(post(request({ signal: AbortSignal.abort() }))).rejects.toMatchObject({ name: "AbortError" });
    expect(sends).toBe(0);
  });

  test("a failed native call is never retried", async () => {
    let sends = 0;
    const post = createNativePostJson(bridge({ postJson: async () => { sends++; throw Object.assign(new Error(), { code: "HTTP_REQUEST_FAILED" }); } }));
    await expect(post(request())).rejects.toMatchObject({ code: "HTTP_REQUEST_FAILED" });
    expect(sends).toBe(1);
  });
});
