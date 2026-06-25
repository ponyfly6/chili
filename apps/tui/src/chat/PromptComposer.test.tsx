import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { chiliDarkTheme } from "../theme/index.js";
import { PromptComposer, promptComposerHeight } from "./PromptComposer.js";

test("uses one prompt row by default", () => {
  expect(promptComposerHeight({
    completions: [],
    paletteOpen: false,
    paletteItems: [],
    prompt: "",
    width: 80,
  })).toBe(3);
});

test("grows prompt rows for multiline input up to a small cap", () => {
  const base = {
    completions: [],
    paletteOpen: false,
    paletteItems: [],
    width: 80,
  };

  expect(promptComposerHeight({ ...base, prompt: "one\ntwo" })).toBe(4);
  expect(promptComposerHeight({ ...base, prompt: "one\ntwo\nthree\nfour" })).toBe(5);
});

test("keeps the prompt cursor aligned after complex emoji input", async () => {
  function PromptHarness() {
    const [prompt, setPrompt] = useState("");
    return (
      <PromptComposer
        width={80}
        prompt={prompt}
        disabled={false}
        completions={[]}
        paletteOpen={false}
        paletteItems={[]}
        paletteIndex={0}
        focused={true}
        onPromptChange={setPrompt}
        onSubmit={() => undefined}
        completionIndex={0}
        theme={chiliDarkTheme}
      />
    );
  }

  const app = await testRender(<PromptHarness />, { width: 90, height: 10, exitOnCtrlC: false });

  try {
    await act(async () => {
      await app.renderOnce();
      await app.mockInput.pressKeys(["👍🏽"]);
    });
    await app.renderOnce();

    // The prompt starts at column 3 inside the bordered composer. The emoji is
    // two cells wide, so the cursor should sit immediately after it at column 6.
    expect(app.captureSpans().cursor).toEqual([6, 2]);
  } finally {
    app.renderer.destroy();
  }
});

test("pastes clipboard text at the input cursor", async () => {
  function PromptHarness() {
    const [prompt, setPrompt] = useState("");
    return (
      <PromptComposer
        width={80}
        prompt={prompt}
        disabled={false}
        completions={[]}
        paletteOpen={false}
        paletteItems={[]}
        paletteIndex={0}
        focused={true}
        onPromptChange={setPrompt}
        onPasteShortcut={async () => "X"}
        onSubmit={() => undefined}
        completionIndex={0}
        theme={chiliDarkTheme}
      />
    );
  }

  const app = await testRender(<PromptHarness />, { width: 90, height: 10, exitOnCtrlC: false });

  try {
    await act(async () => {
      await app.renderOnce();
      await app.mockInput.typeText("ac");
      app.mockInput.pressArrow("left");
      app.mockInput.pressKey("v", { ctrl: true });
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("aXc");
    expect(app.captureCharFrame()).not.toContain("acX");
  } finally {
    app.renderer.destroy();
  }
});

test("keeps prompt text longer than the native input default", async () => {
  let latest = "";

  function PromptHarness() {
    const [prompt, setPrompt] = useState("");
    return (
      <PromptComposer
        width={80}
        prompt={prompt}
        disabled={false}
        completions={[]}
        paletteOpen={false}
        paletteItems={[]}
        paletteIndex={0}
        focused={true}
        onPromptChange={(value) => {
          latest = value;
          setPrompt(value);
        }}
        onSubmit={() => undefined}
        completionIndex={0}
        theme={chiliDarkTheme}
      />
    );
  }

  const app = await testRender(<PromptHarness />, { width: 90, height: 10, exitOnCtrlC: false });

  try {
    const text = "x".repeat(1205);
    await act(async () => {
      await app.renderOnce();
      await app.mockInput.typeText(text);
    });
    await app.renderOnce();

    expect(latest).toHaveLength(text.length);
  } finally {
    app.renderer.destroy();
  }
});
