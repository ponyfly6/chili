import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { selectAsset, unpack } = require("../../npm/usechili/runtime.cjs") as {
  selectAsset: (manifest: { assets: Record<string, { url: string }> }, platform: string, arch: string) => { url: string };
  unpack: (archive: Buffer, checksum: string) => Buffer;
};
function archive(name: string, type = "0", data = "binary") {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(data.length.toString(8).padStart(11, "0"), 124);
  header.write(type, 156);
  const compressed = gzipSync(Buffer.concat([header, Buffer.from(data), Buffer.alloc(1024)]));
  return { compressed, checksum: createHash("sha256").update(compressed).digest("hex") };
}

test("npm installer selects only explicitly supported platforms", () => {
  const manifest = { assets: { "darwin-arm64": { url: "https://example.com/chili" } } };
  expect(selectAsset(manifest, "darwin", "arm64").url).toBe("https://example.com/chili");
  expect(() => selectAsset(manifest, "win32", "x64")).toThrow("No Chili binary");
  expect(() => selectAsset(manifest, "darwin", "x64")).toThrow("No Chili binary");
});

test("npm installer rejects corrupt downloads, traversal paths, and symlinks", () => {
  const valid = archive("chili");
  expect(unpack(valid.compressed, valid.checksum).toString()).toBe("binary");
  expect(() => unpack(valid.compressed, "0".repeat(64))).toThrow("checksum");
  const traversal = archive("../../chili");
  expect(() => unpack(traversal.compressed, traversal.checksum)).toThrow("missing");
  const symlink = archive("chili", "2");
  expect(() => unpack(symlink.compressed, symlink.checksum)).toThrow("regular executable");
});
