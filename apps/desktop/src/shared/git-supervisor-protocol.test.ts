import { expect, test } from "bun:test";
import { encodeGitOwnerFrame, encodeGitResultFrame, parseGitOwnerFrame, parseGitResultFrame } from "./git-supervisor-protocol.js";

test("Git control frames preserve real exit codes and reject duplicate or aliased frames", () => {
  for (const code of [0, 1, 128, 255]) {
    expect(parseGitResultFrame(encodeGitResultFrame({ code, signal: null }))).toEqual({ code, signal: null });
  }
  expect(parseGitResultFrame(encodeGitResultFrame({ code: null, signal: "SIGTERM" })))
    .toEqual({ code: null, signal: "SIGTERM" });
  const frame = encodeGitResultFrame({ code: 0, signal: null });
  for (const invalid of [
    Buffer.concat([frame, frame]), Buffer.concat([frame, Buffer.from("x")]),
    Buffer.from("chili.git.result.v1:256:-\n"), Buffer.from("chili.git.result.v1:0:SIGTERM\n"),
    Buffer.from("chili.git.result.v1:-:-\n"), Buffer.from("chili.git.result.v1:00:-\n"),
    Buffer.from(frame.map((byte, index) => index === 0 ? byte | 0x80 : byte)),
  ]) expect(() => parseGitResultFrame(invalid)).toThrow("Invalid Git result frame");
  const owner = Buffer.from(encodeGitOwnerFrame(123, 456));
  expect(parseGitOwnerFrame(owner)).toEqual({ parentPid: 123, supervisorPid: 456 });
  expect(() => parseGitOwnerFrame(Buffer.concat([owner, owner]))).toThrow();
  expect(() => encodeGitOwnerFrame(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow();
});
