import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { desktopBuildMetadata } from "./scripts/build-metadata.js";

const desktopSigningIdentity = process.env.CHILI_DESKTOP_SIGN_IDENTITY?.trim() || "-";
const localAdHocBuild = desktopSigningIdentity === "-";
const isolatedBuildRoot = process.env.CHILI_DESKTOP_BUILD_ROOT;
const buildInfoDefine = {
  __CHILI_DESKTOP_BUILD_INFO__: JSON.stringify(desktopBuildMetadata(process.env, resolve(import.meta.dirname, "../.."))),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@chili/protocol", "@chili/sdk", "@chili/remote-control"] })],
    define: {
      ...buildInfoDefine,
      __CHILI_DESKTOP_LOCAL_AD_HOC_BUILD__: JSON.stringify(localAdHocBuild),
    },
    build: {
      ...(isolatedBuildRoot ? { outDir: resolve(isolatedBuildRoot, "out/main") } : {}),
      rollupOptions: {
        input: resolve(import.meta.dirname, "src/main/index.ts"),
      },
    },
  },
  preload: {
    define: buildInfoDefine,
    plugins: [externalizeDepsPlugin({ exclude: ["@chili/protocol", "@chili/sdk", "@chili/remote-control"] })],
    build: {
      ...(isolatedBuildRoot ? { outDir: resolve(isolatedBuildRoot, "out/preload") } : {}),
      rollupOptions: {
        input: resolve(import.meta.dirname, "src/preload/index.ts"),
        output: {
          entryFileNames: "index.js",
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    define: buildInfoDefine,
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [react()],
    build: {
      ...(isolatedBuildRoot ? { outDir: resolve(isolatedBuildRoot, "out/renderer") } : {}),
      rollupOptions: {
        input: resolve(import.meta.dirname, "src/renderer/index.html"),
      },
    },
  },
});
