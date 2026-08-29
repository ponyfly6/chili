import type {
  RemoteControlInvocationContext,
  RemoteControlService,
  RemoteControlServiceRequest,
} from "./host-bridge.js";
import type { RemoteControlJsonValue, RemoteControlOperation } from "./protocol.js";

export interface MockControlServiceCall {
  /** One-based position in this mock's in-memory call log. */
  ordinal: number;
  operation: RemoteControlOperation;
}

export type MockControlServiceRequest = RemoteControlServiceRequest;
export type MockControlServiceInvocationContext = RemoteControlInvocationContext;

export interface MockControlServiceOptions {
  /** Number of redacted recent calls retained for assertions and diagnostics. */
  maxRecordedCalls?: number;
}

const DEFAULT_MAX_RECORDED_CALLS = 256;

/**
 * Host-neutral control-service stand-in for the Phase 0 vertical slice.
 *
 * The call log intentionally retains only the operation name. Request payloads,
 * device identity, credentials, and pairing material are never copied into it.
 * Responses are fixed fixtures and therefore cannot reflect user or host data.
 */
export class MockControlService implements RemoteControlService {
  readonly #calls: MockControlServiceCall[] = [];
  readonly #maxRecordedCalls: number;
  #totalCallCount = 0;

  constructor(options: MockControlServiceOptions = {}) {
    const maxRecordedCalls =
      options.maxRecordedCalls ?? DEFAULT_MAX_RECORDED_CALLS;
    if (!Number.isSafeInteger(maxRecordedCalls) || maxRecordedCalls < 1) {
      throw new TypeError("maxRecordedCalls must be a positive safe integer");
    }
    this.#maxRecordedCalls = maxRecordedCalls;
  }

  get calls(): readonly MockControlServiceCall[] {
    return this.#calls.map((call) => ({ ...call }));
  }

  get totalCallCount(): number {
    return this.#totalCallCount;
  }

  async invoke(
    request: MockControlServiceRequest,
    _context: MockControlServiceInvocationContext,
  ): Promise<RemoteControlJsonValue> {
    this.#totalCallCount += 1;
    if (this.#calls.length >= this.#maxRecordedCalls) this.#calls.shift();
    this.#calls.push({
      ordinal: this.#totalCallCount,
      operation: request.operation,
    });

    switch (request.operation) {
      case "sessions.list":
        return {
          sessions: [
            {
              id: "session-demo",
              status: "active",
              title: "Remote control demo",
            },
          ],
        };
      case "session.snapshot":
        return {
          session: {
            id: "session-demo",
            status: "active",
            summary: "Fixed mock snapshot",
          },
        };
      case "session.send":
        return {
          accepted: true,
          disposition: "queued",
        };
      case "session.stop":
        return {
          accepted: true,
          status: "stopping",
        };
    }
  }
}
