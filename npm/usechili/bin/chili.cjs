#!/usr/bin/env node
"use strict";
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const binary = resolve(__dirname, "chili-native");
if (!existsSync(binary)) {
  console.error("Chili's executable is missing. Run npm rebuild usechili to complete installation, or visit https://usechili.com/download.");
  process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) console.error(`Cannot start Chili: ${result.error.message}`);
process.exit(result.status ?? (result.signal === "SIGINT" ? 130 : result.signal === "SIGTERM" ? 143 : 1));
