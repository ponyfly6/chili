"use strict";
require("./runtime.cjs").install().catch((error) => {
  console.error(`Chili installation failed: ${error.message}`);
  console.error("You can also install directly from https://usechili.com/download (no Node.js or Bun required).");
  process.exitCode = 1;
});
