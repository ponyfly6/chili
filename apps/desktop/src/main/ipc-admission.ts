import type { DesktopRequest } from "../shared/contracts.js";

export class DesktopIpcCapacityError extends Error {
  override readonly name = "DesktopIpcCapacityError";
  readonly code = "DESKTOP_IPC_CAPACITY";

  constructor(kind: "normal" | "critical") {
    super(`DESKTOP_IPC_CAPACITY: too many in-flight ${kind} desktop requests`);
  }
}

export interface DesktopIpcAdmissionOptions {
  normalMaxItems?: number;
  normalMaxBytes?: number;
  criticalMaxItems?: number;
  criticalMaxBytes?: number;
}

export class DesktopIpcAdmission {
  private normalItems = 0;
  private normalBytes = 0;
  private criticalItems = 0;
  private criticalBytes = 0;
  private readonly normalMaxItems: number;
  private readonly normalMaxBytes: number;
  private readonly criticalMaxItems: number;
  private readonly criticalMaxBytes: number;

  constructor(options: DesktopIpcAdmissionOptions = {}) {
    this.normalMaxItems = positiveLimit(options.normalMaxItems, 8);
    this.normalMaxBytes = positiveLimit(options.normalMaxBytes, 2_000_000);
    this.criticalMaxItems = positiveLimit(options.criticalMaxItems, 16);
    this.criticalMaxBytes = positiveLimit(options.criticalMaxBytes, 512_000);
  }

  admit(request: DesktopRequest): () => void {
    const critical = request.type === "session.stop";
    const bytes = Buffer.byteLength(JSON.stringify(request), "utf8");
    if (critical) {
      if (this.criticalItems >= this.criticalMaxItems || this.criticalBytes + bytes > this.criticalMaxBytes) {
        throw new DesktopIpcCapacityError("critical");
      }
      this.criticalItems += 1;
      this.criticalBytes += bytes;
    } else {
      if (this.normalItems >= this.normalMaxItems || this.normalBytes + bytes > this.normalMaxBytes) {
        throw new DesktopIpcCapacityError("normal");
      }
      this.normalItems += 1;
      this.normalBytes += bytes;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (critical) {
        this.criticalItems = Math.max(0, this.criticalItems - 1);
        this.criticalBytes = Math.max(0, this.criticalBytes - bytes);
      } else {
        this.normalItems = Math.max(0, this.normalItems - 1);
        this.normalBytes = Math.max(0, this.normalBytes - bytes);
      }
    };
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("IPC admission limits must be positive integers");
  return value;
}
