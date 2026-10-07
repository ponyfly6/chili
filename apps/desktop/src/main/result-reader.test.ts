import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_RESULT_IMAGE_BYTES, MAX_RESULT_TEXT_BYTES } from "../shared/result-preview.js";
import { readDesktopResult } from "./result-reader.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "chili-results-"));
  roots.push(root);
  const project = join(root, "workspace");
  await mkdir(project);
  return { root, project };
}

describe("local desktop result reads", () => {
  test("rejects a parent directory replaced after path validation", async () => {
    const readerUrl = new URL("./result-reader.ts", import.meta.url).href;
    // Isolate filesystem scheduling from every other test in this process.
    const script = `
      import assert from "node:assert/strict";
      import { mock } from "bun:test";
      import * as fs from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      const original = { ...fs };
      const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "chili-result-directory-change-")));
      const workspace = join(root, "workspace");
      const directory = join(workspace, "result");
      const retained = join(workspace, "retained");
      const unrelated = join(root, "unrelated");
      await fs.mkdir(directory, { recursive: true });
      await fs.mkdir(unrelated);
      await fs.writeFile(join(directory, "file.txt"), "workspace result");
      await fs.writeFile(join(unrelated, "file.txt"), "unrelated result");
      const target = join(directory, "file.txt");
      let redirected = false;
      let validations = 0;
      async function redirect() {
        await original.rename(directory, retained);
        await original.symlink(unrelated, directory);
        redirected = true;
      }
      async function restore() {
        await original.unlink(directory);
        await original.rename(retained, directory);
        redirected = false;
      }
      mock.module("node:fs/promises", () => ({ ...original, realpath: async (path, ...args) => {
        if (path !== target) return original.realpath(path, ...args);
        validations++;
        if (validations === 2) await restore();
        const canonical = await original.realpath(path, ...args);
        if (validations <= 2) await redirect();
        return canonical;
      } }));
      try {
        const { readDesktopResult } = await import(${JSON.stringify(readerUrl)});
        const result = await readDesktopResult(workspace, "result/file.txt");
        assert.equal(result.status, "unavailable");
        assert.equal(validations, 1, "The changed directory is rejected before reading its file");
      } finally {
        if (redirected) await restore();
        await original.rm(root, { recursive: true, force: true });
      }
    `;
    const child = Bun.spawn({ cmd: [process.execPath, "-e", script], stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("returns bounded UTF-8 content and keeps image data out of filesystem URLs", async () => {
    const { project } = await workspace();
    await writeFile(join(project, "result.md"), "# 已完成\n说明");
    expect(await readDesktopResult(project, "result.md")).toEqual({
      status: "ready", path: "result.md", kind: "markdown", mimeType: "text/markdown", content: "# 已完成\n说明", bytes: 18,
    });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
    await writeFile(join(project, "image.png"), png);
    const image = await readDesktopResult(project, "image.png");
    expect(image.status).toBe("ready");
    if (image.status === "ready") expect(image.content).toBe(png.toString("base64"));
  });

  test("rejects absolute escapes, sibling prefixes and symlinks outside the selected workspace", async () => {
    const { root, project } = await workspace();
    await writeFile(join(root, "secret.txt"), "secret");
    await symlink(join(root, "secret.txt"), join(project, "escape.txt"));
    await symlink(root, join(project, "outside"));
    for (const path of ["../secret.txt", join(root, "secret.txt"), "escape.txt", "outside/secret.txt"]) {
      expect(await readDesktopResult(project, path)).toEqual({ status: "unavailable", reason: "outside_workspace" });
    }
    expect(await readDesktopResult(project, "bad\0.txt")).toEqual({ status: "unavailable", reason: "outside_workspace" });
  });

  test("permits a contained symlink while returning its canonical local path", async () => {
    const { project } = await workspace();
    await writeFile(join(project, "actual.txt"), "value");
    await symlink(join(project, "actual.txt"), join(project, "alias.txt"));
    const read = await readDesktopResult(project, "alias.txt");
    expect(read.status).toBe("ready");
    if (read.status === "ready") expect(read.path).toBe("actual.txt");
  });

  test("rejects oversized content, directories, unsupported binaries and invalid UTF-8", async () => {
    const { project } = await workspace();
    await writeFile(join(project, "large.txt"), Buffer.alloc(MAX_RESULT_TEXT_BYTES + 1, 65));
    await writeFile(join(project, "large.png"), Buffer.alloc(MAX_RESULT_IMAGE_BYTES + 1));
    await writeFile(join(project, "bad.txt"), Buffer.from([255, 254, 65]));
    await writeFile(join(project, "null.txt"), Buffer.from([65, 0, 66]));
    await writeFile(join(project, "document.pdf"), "%PDF");
    await writeFile(join(project, "fake.png"), "<html>not an image</html>");
    await mkdir(join(project, "directory.txt"));
    const expectations = { "large.txt": "too_large", "large.png": "too_large", "bad.txt": "invalid_text", "null.txt": "invalid_text", "document.pdf": "unsupported", "fake.png": "unsupported", "directory.txt": "not_file", "absent.md": "missing" } as const;
    for (const [path, reason] of Object.entries(expectations)) expect(await readDesktopResult(project, path)).toEqual({ status: "unavailable", reason });
  });
});
