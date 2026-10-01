import type { RuntimePermissionProfileId } from "@chili/protocol";
import {
  createMacOsSeatbeltBashRunner,
  createUnsandboxedBashRunner,
  type BashRunner,
} from "@chili/tools";

export interface HostBashRunnerOptions {
  permissionProfile: () => RuntimePermissionProfileId;
  allowHostSandboxEscape?: boolean;
  platform?: NodeJS.Platform;
  sandboxedRunner?: BashRunner;
  unsandboxedRunner?: BashRunner;
}

export function createHostBashRunner(options: HostBashRunnerOptions): BashRunner {
  const platform = options.platform ?? process.platform;
  const allowHostSandboxEscape = options.allowHostSandboxEscape ?? true;
  const unsandboxed = options.unsandboxedRunner ?? createUnsandboxedBashRunner();
  const rejectDisallowedEscalation = (request: Parameters<BashRunner["run"]>[0]) => {
    if (!allowHostSandboxEscape && request.sandboxPermissions === "require_escalated") {
      throw new Error("Scoped workers cannot request execution outside the host sandbox.");
    }
  };
  if (platform !== "darwin") {
    if (!allowHostSandboxEscape) {
      return {
        async run() {
          throw new Error("Scoped worker Bash is unavailable because this host has no configured shell sandbox.");
        },
      };
    }
    // Non-macOS platforms do not currently have a Chili shell sandbox. The
    // tool approval lifecycle still gates require_escalated before this runner
    // is called, while both execution modes use the same unsandboxed backend.
    return {
      async run(request) {
        rejectDisallowedEscalation(request);
        return await unsandboxed.run(request);
      },
    };
  }

  const sandboxed = options.sandboxedRunner ?? createMacOsSeatbeltBashRunner();
  return {
    async run(request) {
      rejectDisallowedEscalation(request);
      if (
        (allowHostSandboxEscape && options.permissionProfile() === "full-access")
        || request.sandboxPermissions === "require_escalated"
      ) {
        return await unsandboxed.run(request);
      }
      return await sandboxed.run(request);
    },
  };
}
