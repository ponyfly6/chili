export const PERSISTED_ERROR_LIMITS = {
  messageBytes: 16 * 1024,
  nameBytes: 128,
  codeBytes: 256,
} as const;

const CREDENTIAL_LABEL_PATTERN_SOURCE = String.raw`(?:api[_ -]?key|secret[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|auth[_ -]?token|oauth[_ -]?token|private[_ -]?token|client[_ -]?secret|consumer[_ -]?secret|session(?:[_ -]?(?:cookie|id))?|aws[_ -]?secret[_ -]?access[_ -]?key|private[_ -]?key|signing[_ -]?key|webhook[_ -]?secret|password|passwd|passphrase|pwd|cookie|authorization|token|secret)`;
const CREDENTIAL_NAMESPACE_PATTERN_SOURCE = String.raw`(?:[A-Za-z0-9]+[_-])*`;
const NAMESPACED_CREDENTIAL_LABEL_PATTERN_SOURCE = String.raw`${CREDENTIAL_NAMESPACE_PATTERN_SOURCE}${CREDENTIAL_LABEL_PATTERN_SOURCE}`;
const MESSAGE_CREDENTIAL_CONTROL_GAP_PATTERN_SOURCE = String.raw`[\u0000-\u001f\u007f-\u009f]*`;
const MESSAGE_CREDENTIAL_REQUIRED_GAP_PATTERN_SOURCE = String.raw`(?:\s|[\u0000-\u001f\u007f-\u009f])+`;
const MESSAGE_CREDENTIAL_LABEL_SEPARATOR_PATTERN_SOURCE = String.raw`(?:[_ -]|[\u0000-\u001f\u007f-\u009f])*`;
const MESSAGE_CREDENTIAL_LABEL_PATTERN_SOURCE = messageCredentialLabelPattern();
const MESSAGE_AUTH_SCHEME_PATTERN_SOURCE = String.raw`(?:${messageCredentialWord("bearer")}|${messageCredentialWord("basic")}|${messageCredentialWord("apiKey")}|${messageCredentialWord("token")})`;
const CREDENTIAL_SCALAR_PATTERN_SOURCE = String.raw`(?:\[REDACTED(?:_JWT)?\](?=$|[\s,;'"<>}\]])|"[^"\r\n]+"|'[^'\r\n]+'|<[^<>\r\n]+>|[^\s,;'"<>}]+)`;
const CREDENTIAL_ASSIGNMENT_VALUE_PATTERN_SOURCE = String.raw`(?:"[^"\r\n]+"|'[^'\r\n]+'|<[^<>\r\n]+>|[^\r\n&,;'"<>}]+)`;
const CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(["']?(?<![A-Za-z0-9])(?=[A-Za-z])${CREDENTIAL_NAMESPACE_PATTERN_SOURCE}${MESSAGE_CREDENTIAL_LABEL_PATTERN_SOURCE}\b["']?\s*(?::|=)\s*)(?:(?:Bearer|Basic|ApiKey|Token)[ \t]+)?${CREDENTIAL_ASSIGNMENT_VALUE_PATTERN_SOURCE}`,
  "giu",
);
const CREDENTIAL_IS_LINE_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?=[A-Za-z])(${CREDENTIAL_NAMESPACE_PATTERN_SOURCE}${MESSAGE_CREDENTIAL_LABEL_PATTERN_SOURCE})\b${MESSAGE_CREDENTIAL_REQUIRED_GAP_PATTERN_SOURCE}(is)${MESSAGE_CREDENTIAL_REQUIRED_GAP_PATTERN_SOURCE}([^\r\n]*)`,
  "giu",
);
const AUTHORIZATION_SCHEME_PATTERN = new RegExp(
  String.raw`\b(${messageCredentialWord("authorization")})${MESSAGE_CREDENTIAL_REQUIRED_GAP_PATTERN_SOURCE}(${MESSAGE_AUTH_SCHEME_PATTERN_SOURCE})${MESSAGE_CREDENTIAL_REQUIRED_GAP_PATTERN_SOURCE}${CREDENTIAL_SCALAR_PATTERN_SOURCE}`,
  "giu",
);
const SENSITIVE_HEADER_PATTERN = new RegExp(
  String.raw`\b((?:${messageCredentialWord("set")}${MESSAGE_CREDENTIAL_LABEL_SEPARATOR_PATTERN_SOURCE}${messageCredentialWord("cookie")}|${messageCredentialWord("cookie")}|${messageCredentialWord("authorization")})\s*:\s*)[^\r\n]*`,
  "giu",
);
const STANDALONE_BEARER_PATTERN = new RegExp(
  String.raw`\b(${messageCredentialWord("bearer")})${MESSAGE_CREDENTIAL_REQUIRED_GAP_PATTERN_SOURCE}${CREDENTIAL_SCALAR_PATTERN_SOURCE}`,
  "giu",
);
const PROVIDER_SECRET_KEY_PATTERN = new RegExp(
  String.raw`\b${messageCredentialWord("sk")}${MESSAGE_CREDENTIAL_CONTROL_GAP_PATTERN_SOURCE}-${MESSAGE_CREDENTIAL_CONTROL_GAP_PATTERN_SOURCE}[A-Za-z0-9_-]+\b`,
  "giu",
);
const ANSI_STRING_ESCAPE_PATTERN = /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]*?(?:\u0007|\u009c|\u001b\\|$)/gu;
const ANSI_CSI_ESCAPE_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*(?:[@-~]|$)/gu;
const ANSI_SINGLE_ESCAPE_PATTERN = /\u001b(?:[78=>cDEHMNOZ]|[()#%*+\-./][0-2A-Z])/gu;
const CREDENTIAL_QUERY_KEY_PATTERN = new RegExp(
  String.raw`^(?:${NAMESPACED_CREDENTIAL_LABEL_PATTERN_SOURCE}|key)$`,
  "iu",
);
const CREDENTIAL_IDENTIFIER_PATTERN = new RegExp(
  String.raw`^(?:[A-Za-z0-9]+[_.:-])*${CREDENTIAL_LABEL_PATTERN_SOURCE}[_.:-]([A-Za-z0-9._~-]+)$`,
  "iu",
);
const CAMEL_CREDENTIAL_LABELS = [
  "awsSecretAccessKey",
  "consumerSecret",
  "refreshToken",
  "clientSecret",
  "sessionCookie",
  "accessToken",
  "privateToken",
  "privateKey",
  "signingKey",
  "webhookSecret",
  "secretKey",
  "oauthToken",
  "authToken",
  "passphrase",
  "authorization",
  "sessionId",
  "password",
  "apiKey",
  "idToken",
  "passwd",
  "cookie",
  "session",
  "secret",
  "token",
  "pwd",
] as const;
const SAFE_CREDENTIAL_IDENTIFIER_STATUS_PATTERN = /^(?:invalid|invalidated|expired|missing|unavailable|revoked|required|empty|malformed|not[_-]?found)(?:[_-]?error)?$/iu;
const SAFE_SESSION_IDENTIFIER_PATTERN_SOURCE = String.raw`[A-Za-z0-9][A-Za-z0-9._:-]{0,511}`;
const SAFE_SESSION_LIFECYCLE_LINE_PATTERN = new RegExp(
  String.raw`^(?:(?:approval root|delegation (?:root|parent)|parent|child) )?session is (?:not active(?:: ${SAFE_SESSION_IDENTIFIER_PATTERN_SOURCE}(?: \((?:active|archived)\))?)?|already running(?:: ${SAFE_SESSION_IDENTIFIER_PATTERN_SOURCE})?|active|archived|idle|running|waiting_for_approval|cancelling|cancelled|failed|busy)[.!]?$`,
  "iu",
);

export type PersistedErrorCode = string | number;

export interface PersistedErrorDetails {
  name: string;
  code?: PersistedErrorCode;
  truncated?: true;
  originalMessageBytes?: number;
}

export type NormalizedPersistedError = Error & {
  code?: PersistedErrorCode;
  persistedErrorDetails: PersistedErrorDetails;
};

/**
 * Creates a fresh, persistence-safe Error. Accessors on hostile thrown values are
 * guarded, and stack/cause/custom object graphs are deliberately not copied.
 */
export function normalizePersistedError(value: unknown): NormalizedPersistedError {
  const rawMessage = errorMessage(value);
  const sanitizedMessage = redactPersistedErrorMessage(
    sanitizePersistedErrorControls(redactPersistedErrorMessage(rawMessage)),
  );
  const boundedMessage = boundRedactedPersistedErrorMessage(
    sanitizedMessage,
    utf8Bytes(rawMessage),
  );
  const priorDetails = safePersistedDetails(safeGet(value, "persistedErrorDetails"));
  const name = safeIdentifier(safeGet(value, "name"), PERSISTED_ERROR_LIMITS.nameBytes) ?? "Error";
  const code = safeCode(safeGet(value, "code"));
  const truncated = boundedMessage.truncated || priorDetails?.truncated === true;
  const originalMessageBytes = boundedMessage.truncated
    ? boundedMessage.originalBytes
    : (priorDetails?.originalMessageBytes ?? boundedMessage.originalBytes);
  const details: PersistedErrorDetails = {
    name,
    ...(code === undefined ? {} : { code }),
    ...(truncated
      ? { truncated: true, originalMessageBytes }
      : {}),
  };
  const error = new Error(boundedMessage.text) as NormalizedPersistedError;
  error.name = name;
  if (code !== undefined) error.code = code;
  Object.defineProperty(error, "persistedErrorDetails", {
    configurable: false,
    enumerable: true,
    value: Object.freeze(details),
    writable: false,
  });
  return error;
}

function boundRedactedPersistedErrorMessage(value: string, rawMessageBytes: number): {
  text: string;
  bytes: number;
  originalBytes: number;
  truncated: boolean;
} {
  const bounded = boundPersistedErrorMessage(value);
  if (!bounded.truncated && rawMessageBytes <= PERSISTED_ERROR_LIMITS.messageBytes) return bounded;
  const marker = `\n[error message truncated from ${rawMessageBytes} bytes]`;
  const markerBytes = utf8Bytes(marker);
  const prefix = truncateUtf8(value, Math.max(0, PERSISTED_ERROR_LIMITS.messageBytes - markerBytes));
  const text = `${prefix}${truncateUtf8(marker, PERSISTED_ERROR_LIMITS.messageBytes - utf8Bytes(prefix))}`;
  return {
    text,
    bytes: utf8Bytes(text),
    originalBytes: rawMessageBytes,
    truncated: true,
  };
}

function redactPersistedErrorMessage(value: string): string {
  const withoutSensitiveUrls = value.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+/gu, (candidate) => {
    try {
      const url = new URL(candidate);
      if (isLoopbackHostname(url.hostname)) return "[loopback URL redacted]";
      let changed = false;
      if (url.username || url.password) {
        url.username = "REDACTED";
        url.password = "";
        changed = true;
      }
      for (const key of [...url.searchParams.keys()]) {
        if (!isCredentialQueryKey(key)) continue;
        url.searchParams.set(key, "[REDACTED]");
        changed = true;
      }
      return changed ? url.toString() : candidate;
    } catch {
      return candidate;
    }
  });
  return redactCredentialIsPhrases(withoutSensitiveUrls)
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(AUTHORIZATION_SCHEME_PATTERN, "$1 $2 [REDACTED]")
    .replace(SENSITIVE_HEADER_PATTERN, "$1[REDACTED]")
    .replace(STANDALONE_BEARER_PATTERN, "$1 [REDACTED]")
    .replace(PROVIDER_SECRET_KEY_PATTERN, "sk-[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED_JWT]");
}

function redactCredentialIsPhrases(value: string): string {
  return value.replace(
    CREDENTIAL_IS_LINE_PATTERN,
    (match: string, label: string, isWord: string, _tail: string, offset: number, source: string) => {
      const line = lineAt(source, offset);
      return SAFE_SESSION_LIFECYCLE_LINE_PATTERN.test(line)
        ? match
        : `${label} ${isWord} [REDACTED]`;
    },
  );
}

function lineAt(value: string, offset: number): string {
  const lfStart = value.lastIndexOf("\n", offset - 1);
  const crStart = value.lastIndexOf("\r", offset - 1);
  const start = Math.max(lfStart, crStart) + 1;
  const lfEnd = value.indexOf("\n", offset);
  const crEnd = value.indexOf("\r", offset);
  const endings = [lfEnd, crEnd].filter((candidate) => candidate >= 0);
  const end = endings.length > 0 ? Math.min(...endings) : value.length;
  return value.slice(start, end).trim();
}

function sanitizePersistedErrorControls(value: string): string {
  // Remove ANSI sequences before their introducer controls, otherwise a CSI such
  // as ESC [31m would leave the printable "[31m" suffix behind. Keep LF and TAB
  // for readable diagnostics; message credential patterns tolerate those bytes
  // inside labels so they cannot be used to evade redaction.
  return value
    .replace(ANSI_STRING_ESCAPE_PATTERN, "")
    .replace(ANSI_CSI_ESCAPE_PATTERN, "")
    .replace(ANSI_SINGLE_ESCAPE_PATTERN, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}

function messageCredentialLabelPattern(): string {
  const label = (...words: string[]): string => words
    .map((word) => messageCredentialWord(word))
    .join(MESSAGE_CREDENTIAL_LABEL_SEPARATOR_PATTERN_SOURCE);
  const session = messageCredentialWord("session");
  return String.raw`(?:${label("api", "key")}|${label("secret", "key")}|${label("access", "token")}|${label("refresh", "token")}|${label("id", "token")}|${label("auth", "token")}|${label("oauth", "token")}|${label("private", "token")}|${label("client", "secret")}|${label("consumer", "secret")}|${session}(?:${MESSAGE_CREDENTIAL_LABEL_SEPARATOR_PATTERN_SOURCE}(?:${messageCredentialWord("cookie")}|${messageCredentialWord("id")}))?|${label("aws", "secret", "access", "key")}|${label("private", "key")}|${label("signing", "key")}|${label("webhook", "secret")}|${messageCredentialWord("password")}|${messageCredentialWord("passwd")}|${messageCredentialWord("passphrase")}|${messageCredentialWord("pwd")}|${messageCredentialWord("cookie")}|${messageCredentialWord("authorization")}|${messageCredentialWord("token")}|${messageCredentialWord("secret")})`;
}

function messageCredentialWord(value: string): string {
  return [...value].join(MESSAGE_CREDENTIAL_CONTROL_GAP_PATTERN_SOURCE);
}

function isCredentialQueryKey(value: string): boolean {
  const canonical = sanitizePersistedErrorControls(value).replace(/[\t\n]/gu, "");
  return CREDENTIAL_QUERY_KEY_PATTERN.test(canonical);
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "0.0.0.0"
    || hostname.startsWith("127.")
    || hostname === "::1"
    || hostname.startsWith("::ffff:7f");
}

function safePersistedDetails(value: unknown): PersistedErrorDetails | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const truncated = safeGet(value, "truncated");
  const originalMessageBytes = safeGet(value, "originalMessageBytes");
  if (truncated !== true) return undefined;
  if (typeof originalMessageBytes !== "number" || !Number.isSafeInteger(originalMessageBytes) || originalMessageBytes < 0) {
    return { name: "Error", truncated: true };
  }
  return { name: "Error", truncated: true, originalMessageBytes };
}

export function boundPersistedErrorMessage(value: string): {
  text: string;
  bytes: number;
  originalBytes: number;
  truncated: boolean;
} {
  const originalBytes = utf8Bytes(value);
  const limit = PERSISTED_ERROR_LIMITS.messageBytes;
  if (originalBytes <= limit) {
    return { text: value, bytes: originalBytes, originalBytes, truncated: false };
  }
  const marker = `\n[error message truncated from ${originalBytes} bytes]`;
  const markerBytes = utf8Bytes(marker);
  const prefix = truncateUtf8(value, Math.max(0, limit - markerBytes));
  const text = `${prefix}${truncateUtf8(marker, limit - utf8Bytes(prefix))}`;
  return { text, bytes: utf8Bytes(text), originalBytes, truncated: true };
}

function errorMessage(value: unknown): string {
  const message = safeGet(value, "message");
  if (typeof message === "string") return message;
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    const rendered = String(value);
    return rendered === "[object Object]" ? "Unknown error" : rendered;
  } catch {
    return "Unknown error";
  }
}

function safeCode(value: unknown): PersistedErrorCode | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  return safeIdentifier(value, PERSISTED_ERROR_LIMITS.codeBytes);
}

function safeIdentifier(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) return undefined;
  if (redactPersistedErrorMessage(value) !== value || looksLikeCredentialIdentifier(value)) return undefined;
  return truncateUtf8(value, maxBytes) || undefined;
}

function looksLikeCredentialIdentifier(value: string): boolean {
  const match = CREDENTIAL_IDENTIFIER_PATTERN.exec(value);
  if (match?.[1]) return !SAFE_CREDENTIAL_IDENTIFIER_STATUS_PATTERN.test(match[1]);
  for (const label of CAMEL_CREDENTIAL_LABELS) {
    if (value.length <= label.length) continue;
    if (value.slice(0, label.length).toLowerCase() !== label.toLowerCase()) continue;
    const suffix = value.slice(label.length);
    if (!/^[A-Z]/u.test(suffix)) continue;
    return !SAFE_CREDENTIAL_IDENTIFIER_STATUS_PATTERN.test(suffix);
  }
  return false;
}

function safeGet(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
