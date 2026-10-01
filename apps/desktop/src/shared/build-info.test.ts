import { describe, expect, test } from "bun:test";
import { getDesktopBuildInfo } from "./build-info.js";
import { desktopBuildMetadata } from "../../scripts/build-metadata.js";

describe("desktop build identity", () => {
  test("source imports have a safe Bun fallback", () => {
    expect(getDesktopBuildInfo()).toEqual({ channel: "development", revision: "unknown", label: "Development" });
  });

  test("preview metadata requires a full revision and rejects unknown channels", () => {
    expect(() => desktopBuildMetadata({ CHILI_DESKTOP_BUILD_CHANNEL: "preview" }, "/unused")).toThrow("verified full Git revision");
    expect(() => desktopBuildMetadata({ CHILI_DESKTOP_BUILD_CHANNEL: "public" }, "/unused")).toThrow("Invalid desktop build channel");
    expect(desktopBuildMetadata({ CHILI_DESKTOP_BUILD_CHANNEL: "preview", CHILI_DESKTOP_BUILD_REVISION: "a".repeat(40) }, "/unused"))
      .toEqual({ channel: "preview", revision: "a".repeat(40), label: `Preview · ${"a".repeat(12)}` });
  });

  test("bundled identity derives its label without forwarding unknown fields", async () => {
    const module = await bundledInfo({ channel: "preview", revision: "b".repeat(40), label: "secret", sourcePath: "/private/source" });
    expect(module.getDesktopBuildInfo()).toEqual({ channel: "preview", revision: "b".repeat(40), label: `Preview · ${"b".repeat(12)}` });
  });

  test("an invalid compiled identity falls back to development", async () => {
    const module = await bundledInfo({ channel: "preview", revision: "wrong" });
    expect(module.getDesktopBuildInfo()).toEqual({ channel: "development", revision: "unknown", label: "Development" });
  });
});

async function bundledInfo(info: unknown): Promise<{ getDesktopBuildInfo: typeof getDesktopBuildInfo }> {
  const build = await Bun.build({ entrypoints: [new URL("./build-info.ts", import.meta.url).pathname], target: "bun", format: "esm",
    define: { __CHILI_DESKTOP_BUILD_INFO__: JSON.stringify(info) } });
  if (!build.success || !build.outputs[0]) throw new Error("Build identity fixture failed");
  return await import(`data:text/javascript;base64,${Buffer.from(await build.outputs[0].text()).toString("base64")}`);
}
