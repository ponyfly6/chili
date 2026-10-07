import { reduceRuntimeEvents, type RuntimeSessionSummary } from "@chili/sdk";
import type { RuntimeSessionStatus } from "@chili/protocol";
import {
  REMOTE_CONTROL_LIMITS,
  requiredCapabilityForOperation,
  type RemoteControlInvocationContext,
  type RemoteControlJsonValue,
  type RemoteControlService,
  type RemoteControlServiceRequest,
} from "@chili/remote-control";
import { parseDesktopRequest } from "../shared/contracts.js";
import {
  DesktopControlService,
  type DesktopRemoteControlRequest,
  type DesktopRemoteControlScope,
  type DesktopRemoteRootSnapshot,
} from "./control-service.js";

/** Leaves space for the protocol result frame's IDs and encrypted envelope. */
export const REMOTE_DESKTOP_RESULT_MAX_BYTES = 48 * 1024;
export const REMOTE_DESKTOP_MAX_MESSAGES = 40;
export const REMOTE_DESKTOP_MAX_SESSIONS = 100;
const MAX_TEXT_JSON_BYTES = 8 * 1024;
const MAX_TITLE_JSON_BYTES = 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type RemoteDesktopSessionSummary = {
  id: string;
  title: string;
  status: "active" | "archived";
  updatedAt: number;
};

export type RemoteDesktopSessionList = {
  sessions: RemoteDesktopSessionSummary[];
  truncated: boolean;
};

export type RemoteDesktopSnapshot = {
  session: RemoteDesktopSessionSummary & {
    runStatus: RuntimeSessionStatus;
    queuedCount: number;
    deliveryUnknown: boolean;
    needsDesktop: { input: boolean };
  };
  messages: { id: string; role: "user" | "assistant"; text: string; createdAt: number }[];
  truncated: boolean;
};

export interface DesktopRemoteControlAdapterOptions {
  /** The exact instance already serving the local desktop window. */
  controlService: DesktopControlService;
}

/**
 * A disposable, workspace-bound adapter. It owns no runtime client, prompt queue,
 * permissions, credentials, or replay state; HostBridge owns request admission.
 */
export class DesktopRemoteControlAdapter implements RemoteControlService {
  readonly #controlService: DesktopControlService;
  readonly #scope: DesktopRemoteControlScope;

  constructor(options: DesktopRemoteControlAdapterOptions) {
    this.#controlService = options.controlService;
    this.#scope = this.#controlService.captureRemoteControlScope();
  }

  /** Abort queued/not-yet-executed work when disabling or replacing the bridge. */
  revoke(): Promise<void> {
    return this.#controlService.revokeRemoteControlScope(this.#scope);
  }

  revokeDevice(deviceId: string): Promise<void> {
    return this.#controlService.revokeRemoteControlDevice(this.#scope, deviceId);
  }

  close(): Promise<void> {
    return this.revoke();
  }

  async invoke(
    request: RemoteControlServiceRequest,
    context: RemoteControlInvocationContext,
  ): Promise<RemoteControlJsonValue> {
    this.#controlService.assertRemoteControlScope(this.#scope);
    const desktopRequest = parseAdapterRequest(request);
    if (context.capability !== requiredCapabilityForOperation(request.operation)) {
      throw new Error("Remote operation capability is not permitted");
    }
    switch (desktopRequest.type) {
      case "sessions.list":
        return projectRemoteSessionList(await this.#controlService.invokeRemoteControl(desktopRequest, this.#scope, context.signal, context.idempotencyKey, context.deviceId));
      case "session.snapshot":
        return projectRemoteSnapshot(await this.#controlService.invokeRemoteControl(desktopRequest, this.#scope, context.signal, context.idempotencyKey, context.deviceId));
      case "session.send": {
        const result = await this.#controlService.invokeRemoteControl(desktopRequest, this.#scope, context.signal, context.idempotencyKey, context.deviceId);
        return {
          status: result.status,
          ...(result.position !== undefined ? { position: result.position } : {}),
        };
      }
      case "session.stop": {
        const result = await this.#controlService.invokeRemoteControl(desktopRequest, this.#scope, context.signal, context.idempotencyKey, context.deviceId);
        return { interrupted: result.interrupted };
      }
    }
  }
}

/** No raw runtime summary keys (especially cwd or preview) survive this boundary. */
export function projectRemoteSessionList(rows: readonly RuntimeSessionSummary[]): RemoteDesktopSessionList {
  const eligible = rows.filter((row) => SAFE_ID.test(String(row.id)));
  const result: RemoteDesktopSessionList = { sessions: [], truncated: eligible.length !== rows.length };
  for (const row of eligible.slice(0, REMOTE_DESKTOP_MAX_SESSIONS)) {
    const summary = projectSessionSummary(row);
    result.sessions.push(summary);
    if (jsonBytes(result) > REMOTE_DESKTOP_RESULT_MAX_BYTES) {
      result.sessions.pop();
      result.truncated = true;
      break;
    }
    if (summary.title !== (row.title || "Untitled task")) result.truncated = true;
  }
  result.truncated ||= result.sessions.length < rows.length;
  assertResultBudget(result);
  return result;
}

/**
 * Independently projects a root task: no event payload, reasoning, tool input or
 * output, child transcript, approval body, input question, path, or configuration.
 */
export function projectRemoteSnapshot(snapshot: DesktopRemoteRootSnapshot): RemoteDesktopSnapshot {
  const sessionId = String(snapshot.session.id);
  if (!SAFE_ID.test(sessionId)) throw new Error("Task identifier is not supported for remote control");
  const view = reduceRuntimeEvents(snapshot.events.filter((event) => String(event.sessionId) === sessionId));
  const runtimeSession = view.sessions[sessionId];
  const summary = projectSessionSummary(snapshot.session);
  const result: RemoteDesktopSnapshot = {
    session: {
      ...summary,
      runStatus: runtimeSession?.status ?? "idle",
      queuedCount: Math.max(0, Math.min(64, finiteNumber(snapshot.queuedCount))),
      deliveryUnknown: snapshot.deliveryUnknown,
      needsDesktop: {
        input: snapshot.needsDesktop.input,
      },
    },
    messages: [],
    truncated: snapshot.truncated || summary.title !== (snapshot.session.title || "Untitled task"),
  };
  const messages = (runtimeSession?.messageIds ?? []).flatMap((messageId) => {
    const message = view.messages[messageId];
    if (!message || String(message.sessionId) !== sessionId || (message.role !== "user" && message.role !== "assistant")) {
      return [];
    }
    const text = message.parts.flatMap((part) =>
      part.type === "text" && !part.synthetic && String(part.sessionId) === sessionId ? [part.text] : []).join("\n");
    if (!text) return [];
    const boundedText = truncateJsonText(text, MAX_TEXT_JSON_BYTES);
    if (boundedText !== text) result.truncated = true;
    return [{
      id: truncateJsonText(String(message.id), 256),
      role: message.role,
      text: boundedText,
      createdAt: finiteNumber(message.createdAt),
    }];
  });
  result.messages = messages.slice(-REMOTE_DESKTOP_MAX_MESSAGES);
  if (result.messages.length !== messages.length) result.truncated = true;
  while (jsonBytes(result) > REMOTE_DESKTOP_RESULT_MAX_BYTES && result.messages.length > 0) {
    result.messages.shift();
    result.truncated = true;
  }
  assertResultBudget(result);
  return result;
}

function projectSessionSummary(row: RuntimeSessionSummary): RemoteDesktopSessionSummary {
  return {
    id: String(row.id),
    title: truncateJsonText(row.title || "Untitled task", MAX_TITLE_JSON_BYTES),
    status: row.status === "archived" ? "archived" : "active",
    updatedAt: finiteNumber(row.updatedAt),
  };
}

function parseAdapterRequest(request: RemoteControlServiceRequest): DesktopRemoteControlRequest {
  if (!request || typeof request !== "object"
    || Object.keys(request).some((key) => key !== "operation" && key !== "payload")
    || !request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)
    || Object.hasOwn(request.payload, "type")) {
    throw new TypeError("Invalid remote control request");
  }
  if (request.operation !== "sessions.list" && request.operation !== "session.snapshot"
    && request.operation !== "session.send" && request.operation !== "session.stop") {
    throw new TypeError("Operation is not available for remote control");
  }
  const parsed = parseDesktopRequest({ ...request.payload, type: request.operation });
  if (parsed.type === "sessions.list") {
    if (Buffer.byteLength(parsed.query ?? "", "utf8") > REMOTE_CONTROL_LIMITS.maxQueryBytes) {
      throw new TypeError("Remote query is too large");
    }
    return parsed;
  }
  if (parsed.type !== "session.snapshot" && parsed.type !== "session.send" && parsed.type !== "session.stop") {
    throw new TypeError("Operation is not available for remote control");
  }
  if (!SAFE_ID.test(parsed.sessionId)) throw new TypeError("Invalid remote task identifier");
  if (parsed.type === "session.send" && Buffer.byteLength(parsed.text, "utf8") > REMOTE_CONTROL_LIMITS.maxPromptBytes) {
    throw new TypeError("Remote prompt is too large");
  }
  return parsed;
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertResultBudget(value: RemoteControlJsonValue): void {
  if (jsonBytes(value) > REMOTE_DESKTOP_RESULT_MAX_BYTES) throw new Error("Remote snapshot exceeded its byte limit");
}

/** Measures JSON string bytes, including quotes, escapes and lone surrogates. */
function truncateJsonText(value: string, maxBytes: number): string {
  if (jsonBytes(value) <= maxBytes) return value;
  let low = 0;
  let high = Math.min(value.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Do not create a lone surrogate when cutting through a valid pair.
  if (low > 0 && low < value.length && /[\uD800-\uDBFF]/u.test(value[low - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[low]!)) low -= 1;
  return value.slice(0, low);
}
