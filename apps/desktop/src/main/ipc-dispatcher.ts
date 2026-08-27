import {
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
