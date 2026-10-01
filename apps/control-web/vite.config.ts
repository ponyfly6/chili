import { defineConfig } from "vite";
import { resolve } from "node:path";

// This build is served by the desktop's private HTTPS host, never a second
// development HTTP origin. No service worker or persistent client storage.
export default defineConfig({
  base: "/",
  build: {
    target: "es2022",
    outDir: process.env.CHILI_DESKTOP_BUILD_ROOT
      ? resolve(process.env.CHILI_DESKTOP_BUILD_ROOT, "resources/control-web")
      : "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
