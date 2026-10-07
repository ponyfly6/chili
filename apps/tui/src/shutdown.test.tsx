import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { CliRenderEvents } from "@opentui/core";
import { createRoot, flushSync } from "@opentui/react";
import { useEffect } from "react";
import { shutdownTui } from "./shutdown.js";

test("exit finishes React effects before native renderer destruction", async () => {
  const app = await createTestRenderer({ width: 40, height: 10 });
  const root = createRoot(app.renderer);
  const order: string[] = [];
  function View() {
    useEffect(() => {
      order.push("mounted");
      return () => { order.push("cleaned"); };
    }, []);
    return <text>Exit safely</text>;
  }
  try {
    flushSync(() => root.render(<View />));
    expect(order).toEqual(["mounted"]);
    app.renderer.once(CliRenderEvents.DESTROY, () => { order.push("destroyed"); });
    const closing = shutdownTui(root, app.renderer);
    // The renderer's current input callback is allowed to return first.
    expect(order).toEqual(["mounted"]);
    await closing;
    expect(order).toEqual(["mounted", "cleaned", "destroyed"]);
  } finally {
    app.renderer.destroy();
  }
});

test("external destruction while shutdown yields settles without unmounting freed native state", async () => {
  const app = await createTestRenderer({ width: 40, height: 10 });
  const root = { unmount() { throw new Error("Must not unmount after native destruction"); } };
  const closing = shutdownTui(root, app.renderer);
  app.renderer.destroy();
  await closing;
  // Also run the deferred shutdown callback after external destruction.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("an already destroyed renderer needs no further React or native cleanup", async () => {
  const app = await createTestRenderer({ width: 40, height: 10 });
  app.renderer.destroy();
  await shutdownTui({ unmount() { throw new Error("Already destroyed"); } }, app.renderer);
});

test("repeated shutdown requests clean up only once", async () => {
  const app = await createTestRenderer({ width: 40, height: 10 });
  let unmounts = 0;
  const root = { unmount() { unmounts++; } };
  const first = shutdownTui(root, app.renderer);
  const second = shutdownTui(root, app.renderer);
  await Promise.all([first, second]);
  await shutdownTui(root, app.renderer);
  expect(unmounts).toBe(1);
});
