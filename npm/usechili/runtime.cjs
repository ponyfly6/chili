"use strict";
const { createHash } = require("node:crypto");
const { mkdir, writeFile, rename, rm, readFile } = require("node:fs/promises");
const { gunzipSync } = require("node:zlib");
const { resolve } = require("node:path");
const { execFileSync } = require("node:child_process");

function selectAsset(manifest, platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  const asset = manifest.assets[target];
  if (!asset) throw new Error(`No Chili binary for ${target}. Supported: ${Object.keys(manifest.assets).join(", ")}.`);
  return asset;
}

function unpack(buffer, expectedHash) {
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || actual !== expectedHash) throw new Error("Chili download checksum mismatch.");
  const tar = gunzipSync(buffer, { maxOutputLength: 512 * 1024 * 1024 });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/, "").trim();
    if (!name) break;
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid Chili archive entry.");
    const size = Number.parseInt(sizeText, 8);
    const start = offset + 512;
    if (start + size > tar.length) throw new Error("Truncated Chili archive.");
    if (name === "chili" || name === "./chili") {
      if (![0, 48].includes(header[156]) || size === 0) throw new Error("Chili archive entry must be a regular executable file.");
      return tar.subarray(start, start + size);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error("Chili executable missing from archive.");
}

async function download(url, remaining = 5) {
  if (new URL(url).protocol !== "https:") throw new Error("Chili downloads require HTTPS.");
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(600_000) });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || remaining === 0) throw new Error("Too many Chili download redirects.");
    return download(new URL(location, url).href, remaining - 1);
  }
  if (!response.ok) throw new Error(`Chili download failed (${response.status}). Retry with npm rebuild usechili.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 256 * 1024 * 1024) throw new Error("Chili download exceeds the maximum release size.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function install(directory = __dirname) {
  const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
  const asset = selectAsset(manifest);
  const binary = unpack(await download(asset.url), asset.sha256);
  if (createHash("sha256").update(binary).digest("hex") !== asset.binarySha256) throw new Error("Chili executable checksum mismatch.");
  const destination = resolve(directory, "bin/chili-native");
  await mkdir(resolve(directory, "bin"), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, binary, { mode: 0o755, flag: "wx" });
    const actual = execFileSync(temporary, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
    if (actual !== `chili ${manifest.version}`) throw new Error("Chili release version mismatch.");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

module.exports = { selectAsset, unpack, download, install };
