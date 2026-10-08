export interface RemoteTask {
  id: string;
  title: string;
  status: "active" | "archived";
  updatedAt: string;
}

export interface RemoteMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface RemoteInputRequest {
  id: string;
  createdAt: string;
  questions: {
    id: string;
    header: string;
    question: string;
    options: { label: string; description: string }[];
    multiple?: true;
  }[];
}

export interface RemoteSnapshot {
  session: RemoteTask & {
    runStatus: string;
    queuedCount: number;
    deliveryUnknown: boolean;
    needsDesktop: { approval: boolean; input: boolean };
  };
  messages: RemoteMessage[];
  inputRequests: RemoteInputRequest[];
  truncated: boolean;
}

export const MAX_PROMPT_BYTES = 32_768;

/** A task-only mobile panel must always have a selected task and a way back. */
export function visibleMobilePanel(preferred: "list" | "task", selectedId: string | null): "list" | "task" {
  return selectedId === null ? "list" : preferred;
}

/** Parse just the public projection; additional fields are never rendered. */
export function readTaskList(value: unknown): { sessions: RemoteTask[]; truncated: boolean } {
  const result = record(value);
  if (!Array.isArray(result.sessions) || result.sessions.length > 200) invalidResult();
  return { sessions: result.sessions.map(readTask), truncated: result.truncated === true };
}

export function readTaskSnapshot(value: unknown): RemoteSnapshot {
  const result = record(value);
  const session = record(result.session);
  const needsDesktop = record(session.needsDesktop);
  if (typeof needsDesktop.approval !== "boolean" || typeof needsDesktop.input !== "boolean") invalidResult();
  if ("deliveryUnknown" in session && typeof session.deliveryUnknown !== "boolean") invalidResult();
  if (!Array.isArray(result.messages) || result.messages.length > 40) invalidResult();
  const inputRequests = readInputRequests("inputRequests" in result ? result.inputRequests : []);
  const messages = result.messages.map((value): RemoteMessage => {
    const message = record(value);
    if (message.role !== "user" && message.role !== "assistant") invalidResult();
    return {
      id: boundedString(message.id, 256),
      role: message.role,
      text: boundedString(message.text, 32_768),
      createdAt: timestamp(message.createdAt),
    };
  });
  if (typeof session.queuedCount !== "number" || !Number.isSafeInteger(session.queuedCount)
    || session.queuedCount < 0) invalidResult();
  return {
    session: {
      ...readTask(session),
      runStatus: boundedString(session.runStatus, 64),
      queuedCount: session.queuedCount,
      deliveryUnknown: session.deliveryUnknown === true,
      needsDesktop: { approval: needsDesktop.approval === true, input: needsDesktop.input === true },
    },
    messages,
    inputRequests,
    truncated: result.truncated === true,
  };
}

function readInputRequests(value: unknown): RemoteInputRequest[] {
  if (!Array.isArray(value) || value.length > 3 || promptByteLength(JSON.stringify(value)) > 24_576) invalidResult();
  const ids = new Set<string>();
  return value.map((value: unknown) => {
    const request = record(value);
    const id = boundedString(request.id, 128);
    if (!id || ids.has(id)) invalidResult();
    ids.add(id);
    if (promptByteLength(JSON.stringify(value)) > 12_288 || !Array.isArray(request.questions) || request.questions.length === 0 || request.questions.length > 3) invalidResult();
    const questionIds = new Set<string>();
    const questions = request.questions.map((value: unknown) => {
      const question = record(value);
      const id = boundedString(question.id, 64);
      if (!/^[A-Za-z0-9._-]+$/.test(id) || ["__proto__", "prototype", "constructor"].includes(id) || questionIds.has(id)) invalidResult();
      questionIds.add(id);
      if (!Array.isArray(question.options) || question.options.length > 3 || question.options.length === 1
        || (question.multiple !== undefined && question.multiple !== true)) invalidResult();
      const labels = new Set<string>();
      const options = question.options.map((value: unknown) => {
        const option = record(value);
        const label = boundedString(option.label, 120);
        if (!label || labels.has(label)) invalidResult();
        labels.add(label);
        return { label, description: boundedString(option.description, 1000) };
      });
      return {
        id, header: boundedString(question.header, 12), question: boundedString(question.question, 2000), options,
        ...(question.multiple === true ? { multiple: true as const } : {}),
      };
    });
    return { id, createdAt: timestamp(request.createdAt), questions };
  });
}

export function promptByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function canSendPrompt(text: string): boolean {
  return text.trim().length > 0 && promptByteLength(text) <= MAX_PROMPT_BYTES;
}

/** A malformed mutation receipt cannot prove that the operation did not run. */
export function readSendReceipt(value: unknown): "accepted" | "queued" {
  if (value && typeof value === "object" && "status" in value
    && (value.status === "accepted" || value.status === "queued")) return value.status;
  throw Object.assign(new Error("Unknown send outcome"), { code: "outcome_unknown" });
}

export function readStopReceipt(value: unknown): boolean {
  if (value && typeof value === "object" && "interrupted" in value
    && typeof value.interrupted === "boolean") return value.interrupted;
  throw Object.assign(new Error("Unknown stop outcome"), { code: "outcome_unknown" });
}

export function readAnswerReceipt(value: unknown): boolean {
  if (value && typeof value === "object" && "resolved" in value && typeof value.resolved === "boolean") return value.resolved;
  throw Object.assign(new Error("Unknown answer outcome"), { code: "outcome_unknown" });
}

export function runStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    idle: "空闲",
    running: "运行中",
    waiting_for_approval: "等待桌面审批",
    waiting_for_input: "等待你的回答",
    cancelling: "正在停止",
    completed: "已完成",
    failed: "已失败",
    interrupted: "已停止",
    cancelled: "已停止",
  };
  return labels[status] ?? "状态更新中";
}

export function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "unknown";
  return typeof error.code === "string" ? error.code.toLowerCase() : "unknown";
}

export function recoveryNeedsPairing(error: unknown): boolean {
  return ["pairing_required", "recovery_invalid", "recovery_record_invalid", "recovery_identity_invalid",
    "recovery_metadata_invalid", "recovery_context_mismatch", "credential_expired", "credential_revoked",
    "device_revoked", "authentication_failed", "pairing_challenge_invalid", "pairing_grant_invalid"].includes(errorCode(error));
}

export function errorMessage(error: unknown): string {
  if (recoveryNeedsPairing(error)) return "此设备的授权已失效或被撤销。请回桌面生成新配对码，然后重新配对。";
  switch (errorCode(error)) {
    case "recovery_storage_failed":
      return "电脑已确认，但手机未能保存连接。请在电脑撤销本次设备后重新配对。";
    case "outcome_storage_unavailable":
      return "暂时无法保存指令提醒，本次操作没有发送。请检查手机存储后重试。";
    case "invalid_recovery_record":
    case "recovery_expired":
    case "device_revoked":
      return "此设备的授权已失效，请回桌面生成新配对码。";
    case "outcome_unknown":
      return "结果未知：请求可能已经执行。请读取任务或回桌面确认；不会自动重发。";
    case "unsupported_browser":
    case "unsupported_crypto":
    case "browser_crypto_unsupported":
      return "此浏览器不支持所需的安全加密能力，请使用受支持的新版本浏览器。不会降级为明文连接。";
    case "insecure_context":
    case "https_required":
    case "trusted_https_required":
      return "需要可信 HTTPS。请先在手机完成证书信任，再打开桌面显示的 HTTPS 地址。";
    case "credential_expired":
    case "credential_revoked":
    case "authentication_failed":
    case "pairing_required":
    case "sequence_exhausted":
      return "授权已失效或被撤销。请回桌面生成新的配对码，然后重新配对。";
    case "pairing_expired":
    case "pairing_invalid":
    case "pairing_rejected":
    case "invalid_pairing_code":
    case "invalid_pairing_response":
      return "配对未完成或配对码已失效。请检查桌面确认提示，使用新配对码再试。";
    case "forbidden":
    case "capability_not_granted":
      return "此操作不在手机授权范围内，请回桌面处理。";
    case "limit_exceeded":
    case "request_limit_exceeded":
      return "请求达到大小或频率限制，请缩短内容或稍后重试。";
    case "invalid_response":
      return "桌面返回了无法显示的数据。请回桌面检查，不会展示原始内容。";
    case "disconnected":
    case "not_connected":
    case "connection_lost":
    case "reconnect_timeout":
    case "admission_pending":
    case "unavailable":
    case "network_error":
    case "ack_timeout":
    case "result_timeout":
      return "连接暂时不可用。请确认手机与电脑仍在同一私网，并尝试重新连接。";
    default:
      return "操作未能完成。请检查连接或回桌面确认；发送内容不会自动重试。";
  }
}

function readTask(value: unknown): RemoteTask {
  const task = record(value);
  if (task.status !== "active" && task.status !== "archived") invalidResult();
  return {
    id: boundedString(task.id, 128),
    title: boundedString(task.title, 1024),
    status: task.status,
    updatedAt: timestamp(task.updatedAt),
  };
}

function timestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) invalidResult();
    return date.toISOString();
  }
  return boundedString(value, 64);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidResult();
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) invalidResult();
  return value;
}

function invalidResult(): never {
  throw Object.assign(new Error("Invalid remote projection"), { code: "invalid_response" });
}
