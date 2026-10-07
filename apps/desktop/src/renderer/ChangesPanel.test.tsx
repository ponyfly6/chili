import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangesPanel, ChangesPanelBody, createChangesLoader, type ChangesLoadState } from "./ChangesPanel.js";
import type { ControlTransport } from "./transport.js";

const result = { scope: "turn" as const, text: "No file-changing tool activity in this turn.", truncated: false };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("an absent turn shows an explicit empty state without reading workspace changes", () => {
  let calls = 0;
  const transport = { diff: async () => { calls += 1; return result; } } as unknown as ControlTransport;
  const html = renderToStaticMarkup(<ChangesPanel transport={transport} sessionId="session_1" revision={1} />);
  expect(html).toContain("还没有可查看的修改记录");
  expect(html).toContain('aria-pressed="true">最近修改');
  expect(html).toContain("整个目录");
  expect(calls).toBe(0);
});

test("empty turn changes are not represented as a delivery or a changed file", () => {
  const html = renderToStaticMarkup(<ChangesPanelBody state={{ status: "ready", result }} resetKey="turn_1" onRetry={() => {}} />);
  expect(html).toContain("这次记录没有文件改动。");
  expect(html).not.toContain("成果");
  expect(html).not.toContain("diff-review-file");
});

test("request failures remain escaped and offer retry", () => {
  const html = renderToStaticMarkup(<ChangesPanelBody state={{ status: "error", message: "<script>failed</script>" }} resetKey="turn_1" onRetry={() => {}} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain("重试");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});

test("an obsolete request cannot publish after its scope or session is disposed", async () => {
  let complete!: (value: typeof result) => void;
  const states: ChangesLoadState[] = [];
  const loader = createChangesLoader({
    load: () => new Promise((resolve) => { complete = resolve; }),
    onState: (state) => states.push(state),
  });
  loader.refresh(true);
  expect(states.map((state) => state.status)).toEqual(["loading"]);
  loader.dispose();
  complete(result);
  await settle();
  expect(states.map((state) => state.status)).toEqual(["loading"]);
});

test("bursts during a request produce one trailing refresh and never overlapping reads", async () => {
  const completions: Array<(value: typeof result) => void> = [];
  let active = 0;
  let maxActive = 0;
  const states: ChangesLoadState[] = [];
  const loader = createChangesLoader({
    load: () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<typeof result>((resolve) => completions.push((value) => { active -= 1; resolve(value); }));
    },
    onState: (state) => states.push(state),
    delayMs: 0,
  });
  try {
    loader.refresh(true);
    for (let index = 0; index < 20; index += 1) loader.refresh();
    expect(completions).toHaveLength(1);
    completions[0]!(result);
    await settle();
    await settle();
    expect(completions).toHaveLength(2);
    expect(maxActive).toBe(1);
    completions[1]!(result);
    await settle();
    expect(states.at(-1)?.status).toBe("ready");
    expect(completions).toHaveLength(2);
  } finally { loader.dispose(); }
});

test("failed reads can be retried without recreating the panel", async () => {
  let attempts = 0;
  const states: ChangesLoadState[] = [];
  const loader = createChangesLoader({
    load: async () => { if (attempts++ === 0) throw new Error("Unavailable"); return result; },
    onState: (state) => states.push(state),
  });
  try {
    loader.refresh(true);
    await settle();
    expect(states.at(-1)).toEqual({ status: "error", message: "Unavailable" });
    loader.refresh(true);
    await settle();
    expect(states.at(-1)).toEqual({ status: "ready", result });
  } finally { loader.dispose(); }
});
