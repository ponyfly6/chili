import {
  DESKTOP_INVOKE_CLOSING_RESPONSE,
  parseDesktopRequest,
  parseDesktopResponse,
  type DesktopRequest,
  type DesktopResponse,
} from "../shared/contracts.js";
import { DesktopIpcAdmission } from "./ipc-admission.js";
import { safeDesktopErrorMessage } from "../shared/safe-error.js";

export interface DesktopRequestHandler {
  invoke<Request extends DesktopRequest>(request: Request): Promise<DesktopResponse<Request>>;
}

export interface DesktopResyncCompleter {
  completeResync(barrierId: string): { status: "completed" | "retry" };
}

export interface DesktopInvokeShutdownGate {
  beginShutdown(): void;
  isShuttingDown(): boolean;
  invoke<T>(operation: () => Promise<T> | T): Promise<T | typeof DESKTOP_INVOKE_CLOSING_RESPONSE>;
}

export function createDesktopInvokeShutdownGate(): DesktopInvokeShutdownGate {
  let shuttingDown = false;
  return {
    beginShutdown() {
      shuttingDown = true;
    },
    isShuttingDown() {
      return shuttingDown;
    },
    async invoke<T>(operation: () => Promise<T> | T) {
      if (shuttingDown) return DESKTOP_INVOKE_CLOSING_RESPONSE;
      try {
        return await operation();
      } catch (error) {
        if (shuttingDown) return DESKTOP_INVOKE_CLOSING_RESPONSE;
        throw error;
      }
    },
  };
}

export function createDesktopRequestDispatcher(
  handler: DesktopRequestHandler,
  resync: DesktopResyncCompleter,
  admission = new DesktopIpcAdmission(),
): (value: unknown) => Promise<unknown> {
  return async (value: unknown) => {
    const request = parseDesktopRequest(value);
    if (request.type === "events.resync.complete") {
      return parseDesktopResponse(request, resync.completeResync(request.barrierId));
    }
    const release = admission.admit(request);
    try {
      const response = await handler.invoke(request);
      return parseDesktopResponse(request, response);
    } catch (error) {
      throw new Error(safeDesktopErrorMessage(error));
    } finally {
      release();
    }
  };
}
