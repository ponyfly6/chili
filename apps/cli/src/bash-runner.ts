import type { RuntimePermissionProfileId } from "@chili/protocol";
import {
  createMacOsSeatbeltBashRunner,
  createUnsandboxedBashRunner,
  type BashRunner,
} from "@chili/tools";

export interface CliBashRunnerOptions {
  permissionProfile: () => RuntimePermissionProfileId;
  platform?: NodeJS.Platform;
  sandboxedRunner?: BashRunner;
  unsandboxedRunner?: BashRunner;
}

export function createCliBashRunner(options: CliBashRunnerOptions): BashRunner {
  const platform = options.platform ?? process.platform;
  const unsandboxed = options.unsandboxedRunner ?? createUnsandboxedBashRunner();
  if (platform !== "darwin") return unsandboxed;

  const sandboxed = options.sandboxedRunner ?? createMacOsSeatbeltBashRunner();
  return {
    run(request) {
      if (options.permissionProfile() === "full-access") {
        return unsandboxed.run(request);
      }
      return sandboxed.run(request);
    },
  };
}
