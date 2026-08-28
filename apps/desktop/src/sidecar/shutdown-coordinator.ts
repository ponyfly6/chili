import {
  createParentLossWatchdog,
  type ParentLossWatchdog,
} from "./parent-loss-watchdog.js";

export interface SidecarShutdownCoordinator {
  installClose(close: (reason: string) => Promise<void>): void;
  requestGraceful(reason: string, exitCode: number): void;
  markParentGone(reason: string): void;
}

export interface SidecarShutdownCoordinatorOptions {
  deadlineMs: number;
  hardContain(): void;
  exit(code: number): void;
  onCloseError(error: unknown): void;
  teardownObservation(): void;
  parentIsAlive?(): boolean;
  createWatchdog?: (onDeadline: () => void) => ParentLossWatchdog;
  scheduleResolvedDecision?: (decision: () => void) => void;
}

export interface SidecarCloseResourcesOptions {
  denyPending(): void;
  closeServer?(): Promise<void>;
  closeHarness?(): Promise<void>;
}

export async function closeSidecarResources(options: SidecarCloseResourcesOptions): Promise<void> {
  const errors: unknown[] = [];
  try {
    options.denyPending();
  } catch (error) {
    errors.push(error);
  }
  if (options.closeServer) {
    try {
      await options.closeServer();
    } catch (error) {
      errors.push(error);
    }
  }
  if (options.closeHarness) {
    try {
      await options.closeHarness();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Sidecar shutdown encountered multiple errors");
}

export function createSidecarShutdownCoordinator(
  options: SidecarShutdownCoordinatorOptions,
): SidecarShutdownCoordinator {
  let close: ((reason: string) => Promise<void>) | undefined;
  let request: { reason: string; exitCode: number } | undefined;
  let closeStarted = false;
  let parentGone = false;
  let terminal = false;

  const watchdog = options.createWatchdog
    ? options.createWatchdog(onDeadline)
    : createParentLossWatchdog({ deadlineMs: options.deadlineMs, onDeadline });

  const startClose = (): void => {
    if (terminal || closeStarted || !request || !close) return;
    closeStarted = true;
    const activeRequest = request;
    void Promise.resolve()
      .then(() => close?.(activeRequest.reason))
      .then(
        () => {
          const decide = (): void => finishResolved(activeRequest.exitCode);
          if (options.scheduleResolvedDecision) {
            options.scheduleResolvedDecision(decide);
          } else {
            // Keep ownership observers installed through the next I/O turn so
            // a queued stdin EOF can promote an otherwise graceful shutdown.
            setImmediate(decide);
          }
        },
        (error) => finishRejected(error),
      );
  };

  const requestShutdown = (reason: string, exitCode: number, lostParent: boolean): void => {
    if (terminal) return;
    if (lostParent) parentGone = true;
    if (request) request.exitCode = Math.max(request.exitCode, exitCode);
    else request = { reason, exitCode };
    watchdog.arm();
    startClose();
  };

  function finishResolved(exitCode: number): void {
    if (terminal) return;
    if (parentGone || options.parentIsAlive?.() === false) {
      terminal = true;
      finishWithHardContainment();
      return;
    }
    terminal = true;
    watchdog.disarm();
    options.teardownObservation();
    options.exit(exitCode);
  }

  function finishRejected(error: unknown): void {
    if (terminal) return;
    terminal = true;
    try {
      options.onCloseError(error);
    } finally {
      finishWithHardContainment();
    }
  }

  function onDeadline(): void {
    if (terminal) return;
    terminal = true;
    finishWithHardContainment();
  }

  function finishWithHardContainment(): void {
    options.hardContain();
    // Production containment terminates the current process group and never
    // returns. Keep a deterministic fallback for platforms where it cannot.
    options.exit(1);
  }

  return {
    installClose(installedClose) {
      if (close) throw new Error("Sidecar close handler is already installed");
      close = installedClose;
      startClose();
    },
    requestGraceful(reason, exitCode) {
      requestShutdown(reason, exitCode, false);
    },
    markParentGone(reason) {
      requestShutdown(reason, 0, true);
    },
  };
}
