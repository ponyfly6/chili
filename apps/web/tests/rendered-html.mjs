import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://chili.example/", {
      headers: { accept: "text/html", host: "chili.example" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Chili landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]*lang="zh-CN"/i);
  assert.match(html, /<title>Chili · 为你做事的个人 AI<\/title>/i);
  assert.match(html, /你的想法，/);
  assert.match(html, /行动派/);
  assert.match(html, /个人代理 · 规划中/);
  assert.match(html, /移动端 · 开发预览/);
  assert.match(html, /持续跟进与主动提醒尚未上线/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /git clone/);
  assert.match(html, /https:\/\/github\.com\/ponyfly6\/chili/);
  assert.match(html, /property="og:image" content="https:\/\/chili\.example\/og\.png"/i);
  assert.match(html, /name="twitter:card" content="summary_large_image"/i);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/i);
});

test("ships only Chili-specific public assets", async () => {
  await Promise.all([
    access(new URL("../public/chili-icon.svg", import.meta.url)),
    access(new URL("../public/favicon.svg", import.meta.url)),
    access(new URL("../public/og.png", import.meta.url)),
  ]);

  await Promise.all([
    assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url))),
    assert.rejects(access(new URL("../app/_sites-preview/preview.css", import.meta.url))),
    assert.rejects(access(new URL("../public/file.svg", import.meta.url))),
    assert.rejects(access(new URL("../public/globe.svg", import.meta.url))),
  ]);
});
