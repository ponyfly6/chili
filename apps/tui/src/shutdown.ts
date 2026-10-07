import { CliRenderEvents, type CliRenderer } from "@opentui/core";
import { flushSync, type Root } from "@opentui/react";

/** Finish React cleanup before releasing the native render tree. */
export function shutdownTui(root: Pick<Root, "unmount">, renderer: CliRenderer): Promise<void> {
  if (renderer.isDestroyed) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const destroyed = () => resolve();
    // A signal may destroy the renderer while we yield out of its input callback.
    renderer.once(CliRenderEvents.DESTROY, destroyed);
    setImmediate(() => {
      if (renderer.isDestroyed) return;
      try {
        flushSync(() => root.unmount());
        renderer.destroy();
      } catch (error) {
        renderer.off(CliRenderEvents.DESTROY, destroyed);
        reject(error);
      }
    });
  });
}
