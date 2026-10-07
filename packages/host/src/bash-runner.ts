import type { RuntimePermissionProfileId } from "@chili/protocol";
import {
  createMacOsSeatbeltBashRunner,
  createUnsandboxedBashRunner,
  type BashRunner,
  type BashRunRequest,
  type ToolResourceDenials,
} from "@chili/tools";

export interface HostBashRunnerOptions {
  permissionProfile: () => RuntimePermissionProfileId;
  allowHostSandboxEscape?: boolean;
  platform?: NodeJS.Platform;
  sandboxedRunner?: BashRunner;
  unsandboxedRunner?: BashRunner;
  resolveResourceDenials?: (request: BashRunRequest) => Promise<ToolResourceDenials | undefined> | ToolResourceDenials | undefined;
}

export function createHostBashRunner(options: HostBashRunnerOptions): BashRunner {
  const platform = options.platform ?? process.platform;
  const allowHostSandboxEscape = options.allowHostSandboxEscape ?? true;
  const unsandboxed = options.unsandboxedRunner ?? createUnsandboxedBashRunner();
  const prepare = async (request: BashRunRequest): Promise<BashRunRequest> => {
    const expectedProfile = options.permissionProfile();
    const latest = await options.resolveResourceDenials?.(request);
    const readPaths = [...new Set([...(request.resourceDenials?.readPaths ?? []), ...(latest?.readPaths ?? [])])];
    const writePaths = [...new Set([...(request.resourceDenials?.writePaths ?? []), ...(latest?.writePaths ?? [])])];
    const hasDenials = readPaths.length > 0 || writePaths.length > 0;
    if (hasDenials && request.sandboxPermissions === "require_escalated") {
      throw new Error("Explicit file resource denies cannot be bypassed by elevated execution.");
    }
    const originalRead = [...(request.resourceDenials?.readPaths ?? [])];
    const originalWrite = [...(request.resourceDenials?.writePaths ?? [])];
    const expected = denialVersion({ readPaths, writePaths });
    const assertCurrentAuthorization = async (): Promise<void> => {
      await request.assertCurrentAuthorization?.();
      if (options.permissionProfile() !== expectedProfile) {
        throw new Error("Shell permission profile changed during preparation; prepare the command again before executing.");
      }
      const current = await options.resolveResourceDenials?.(request);
      if (denialVersion({ readPaths: [...originalRead, ...(current?.readPaths ?? [])], writePaths: [...originalWrite, ...(current?.writePaths ?? [])] }) !== expected) {
        throw new Error("File resource policy changed during shell preparation; prepare the command again before executing.");
      }
    };
    return { ...request, ...(hasDenials ? { resourceDenials: { readPaths, writePaths } } : {}), assertCurrentAuthorization };
  };
  const rejectDisallowedEscalation = (request: Parameters<BashRunner["run"]>[0]) => {
    if ((!allowHostSandboxEscape || request.executionPolicy) && request.sandboxPermissions === "require_escalated") {
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
    // tool review gate runs before this runner
    // is called, while both execution modes use the same unsandboxed backend.
    return {
      async run(request) {
        request = await prepare(request);
        rejectDisallowedEscalation(request);
        if (request.executionPolicy) throw new Error("Scoped execution requires a configured shell sandbox.");
        if (hasResourceDenials(request)) throw new Error("File resource denies require a supported shell sandbox on this host.");
        await request.assertCurrentAuthorization?.();
        return await unsandboxed.run(request);
      },
    };
  }

  const sandboxed = options.sandboxedRunner ?? createMacOsSeatbeltBashRunner();
  return {
    supportsExecutionPolicy: sandboxed.supportsExecutionPolicy === true,
    supportsResourceDenials: sandboxed.supportsResourceDenials === true,
    async run(request) {
      request = await prepare(request);
      rejectDisallowedEscalation(request);
      const resourceRestricted = hasResourceDenials(request);
      if (resourceRestricted && !sandboxed.supportsResourceDenials) {
        throw new Error("This shell backend cannot enforce explicit file resource denies.");
      }
      if (
        (allowHostSandboxEscape && !request.executionPolicy && !resourceRestricted)
        || request.sandboxPermissions === "require_escalated"
      ) {
        await request.assertCurrentAuthorization?.();
        return await unsandboxed.run(request);
      }
      await request.assertCurrentAuthorization?.();
      return await sandboxed.run(request);
    },
  };
}

function hasResourceDenials(request: BashRunRequest): boolean {
  return (request.resourceDenials?.readPaths.length ?? 0) + (request.resourceDenials?.writePaths.length ?? 0) > 0;
}

function denialVersion(denials: ToolResourceDenials): string {
  return JSON.stringify([[...new Set(denials.readPaths)].sort(), [...new Set(denials.writePaths)].sort()]);
}
