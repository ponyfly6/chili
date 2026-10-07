import { expect, test } from "bun:test";
import { parseDesktopRequest, parseDesktopResponse } from "./contracts.js";
import { MAX_RESULT_TEXT_BYTES } from "./result-preview.js";

test("result IPC admits only a bounded path and the explicit project owner", () => {
  expect(parseDesktopRequest({ type: "result.read", path: "output/result.html", projectId: "project1" })).toEqual({ type: "result.read", path: "output/result.html", projectId: "project1" });
  for (const input of [
    { type: "result.read", path: "bad\0.txt" },
    { type: "result.read", path: "x".repeat(4_097) },
    { type: "result.read", path: "a.txt", root: "/etc" },
    { type: "result.read", path: 42 },
  ]) expect(() => parseDesktopRequest(input)).toThrow();
});

test("result responses validate content kinds, limits and isolated preview URLs", () => {
  const request = { type: "result.read", path: "a.html" } as const;
  const value = { status: "ready", path: "a.html", kind: "html", mimeType: "text/html", content: "<h1>Hello</h1>", bytes: 14, previewUrl: "chili-result://cc9423e9-49c2-41c1-b5de-606a9b866c50/a.html" } as const;
  expect(parseDesktopResponse(request, value)).toEqual(value);
  for (const altered of [
    { ...value, bytes: MAX_RESULT_TEXT_BYTES + 1 },
    { ...value, kind: "image" },
    { ...value, mimeType: "application/javascript" },
    { ...value, previewUrl: "https://evil.test/a.html" },
    { ...value, previewUrl: "chili://app/a.html" },
    { ...value, previewUrl: "chili-result://user@cc9423e9-49c2-41c1-b5de-606a9b866c50/a.html" },
    { ...value, previewUrl: "chili-result://cc9423e9-49c2-41c1-b5de-606a9b866c50:3/a.html" },
    { ...value, privatePath: "/outside/secret" },
  ]) expect(() => parseDesktopResponse(request, altered)).toThrow();
  expect(parseDesktopResponse(request, { status: "unavailable", reason: "outside_workspace" })).toEqual({ status: "unavailable", reason: "outside_workspace" });
});

test("reading preferences include strict auto-open state", () => {
  expect(parseDesktopRequest({ type: "reading.set", expandWork: false, autoOpenResults: true })).toEqual({ type: "reading.set", expandWork: false, autoOpenResults: true });
  expect(() => parseDesktopRequest({ type: "reading.set", expandWork: false, autoOpenResults: "true" })).toThrow();
  expect(parseDesktopResponse({ type: "reading.get" }, { expandWork: true, autoOpenResults: false })).toEqual({ expandWork: true, autoOpenResults: false });
});
