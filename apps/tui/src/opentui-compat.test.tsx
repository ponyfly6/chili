import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { act, useState } from "react";

test("OpenTUI React renders a frame, reports dimensions, and handles keyboard", async () => {
  const app = await testRender(<CompatProbe />, { width: 42, height: 8, exitOnCtrlC: false });

  try {
    await act(async () => {
      await app.renderOnce();
    });
    expect(app.captureCharFrame()).toContain("compat 42x8 key:none");

    act(() => {
      app.mockInput.pressKey("r");
    });
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("compat 42x8 key:r");

    act(() => {
      app.resize(50, 9);
    });
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("compat 50x9 key:r");
  } finally {
    app.renderer.destroy();
  }
});

function CompatProbe() {
  const dimensions = useTerminalDimensions();
  const [keyName, setKeyName] = useState("none");
  useKeyboard((key) => {
    setKeyName(key.ctrl ? `ctrl+${key.name}` : key.name);
  });

  return (
    <box width="100%" height="100%" flexDirection="column">
      <text>{`compat ${dimensions.width}x${dimensions.height} key:${keyName}`}</text>
    </box>
  );
}
