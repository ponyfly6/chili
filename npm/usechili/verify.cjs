"use strict";
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { version } = require("./package.json");
const manifest = JSON.parse(readFileSync(resolve(__dirname, "manifest.json"), "utf8"));
if (manifest.version !== version) throw new Error("Build the npm release before publishing: bun run release:npm");
for (const target of ["darwin-arm64", "linux-arm64", "linux-x64"]) {
  const asset = manifest.assets[target];
  const expected = `https://github.com/ponyfly6/chili/releases/download/v${version}/chili-${version}-${target}.tar.gz`;
  if (asset?.url !== expected || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^[a-f0-9]{64}$/.test(asset.binarySha256)) {
    throw new Error(`Invalid release manifest for ${target}`);
  }
}
