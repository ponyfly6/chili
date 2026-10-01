import { expect, test } from "bun:test";
import { normalizePersistedError, PERSISTED_ERROR_LIMITS } from "./persisted-error.js";

test("redacts Bearer credentials and loopback URLs before persisted error truncation", () => {
  const bearerToken = "secret-token._~+/==";
  const ipv4Url = "http://127.0.0.1:43123/private/callback?access_token=url-secret#fragment";
  const localhostUrl = "https://auth.localhost:9443/oauth/callback?code=local-code";
  const ipv6Url = "http://[::1]:8123/internal/path?secret=ipv6-secret";
  const externalUrl = "https://api.example.com/status?code=public-diagnostic";
  const source = Object.assign(new Error([
    "Provider request failed while retaining useful context.",
    `Authorization: Bearer ${bearerToken}`,
    `endpoints: ${ipv4Url} ${localhostUrl} ${ipv6Url}`,
    `remote diagnostic: ${externalUrl}`,
    "错".repeat(Math.ceil((20 * 1024) / 3)),
  ].join("\n")), {
    name: "RemoteAuthError",
    code: "E_REMOTE_AUTH",
    cause: { bearerToken, ipv4Url },
  });

  const normalized = normalizePersistedError(source);

  expect(normalized.name).toBe("RemoteAuthError");
  expect(normalized.code).toBe("E_REMOTE_AUTH");
  expect(normalized.message).toContain("Provider request failed while retaining useful context.");
  expect(normalized.message).toContain("Authorization: [REDACTED]");
  expect(normalized.message).toContain("[loopback URL redacted]");
  expect(normalized.message).toContain(externalUrl);
  expect(normalized.message).not.toContain(bearerToken);
  expect(normalized.message).not.toContain(ipv4Url);
  expect(normalized.message).not.toContain("local-code");
  expect(normalized.message).not.toContain("ipv6-secret");
  expect(normalized.message).toContain("error message truncated from");
  expect(Buffer.byteLength(normalized.message, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
  expect((normalized as Error & { cause?: unknown }).cause).toBeUndefined();
  expect(normalized.persistedErrorDetails).toMatchObject({
    name: "RemoteAuthError",
    code: "E_REMOTE_AUTH",
    truncated: true,
  });
});

test("does not redact non-loopback HTTP diagnostics or unrelated secret-like text", () => {
  const message = "request https://example.com/v1/items?id=42 failed with api_key_like_text";
  expect(normalizePersistedError(new Error(message)).message).toBe(message);
});

for (const message of [
  "Session is not active: session_http (archived)",
  "Session is already running: session_http",
  "Delegation parent session is not active: session_parent (archived)",
  "child session is busy",
] as const) {
  test(`preserves an exact session lifecycle diagnostic: ${message}`, () => {
    const once = normalizePersistedError(new Error(message));
    const twice = normalizePersistedError(once);

    expect(once.message).toBe(message);
    expect(twice.message).toBe(message);
  });
}

for (const [message, secret] of [
  ["session is SESSION_SECRET_123", "SESSION_SECRET_123"],
  ["session is not SESSION_SECRET_123", "SESSION_SECRET_123"],
  ["session is already SESSION_SECRET_123", "SESSION_SECRET_123"],
  ["token is not TOKEN_SECRET_123", "TOKEN_SECRET_123"],
  ["Session is not active: session_http (archived) EXTRA_SECRET", "EXTRA_SECRET"],
] as const) {
  test(`does not widen the session lifecycle allowlist: ${message}`, () => {
    const once = normalizePersistedError(new Error(message));
    const twice = normalizePersistedError(once);

    expect(once.message).toContain("[REDACTED]");
    expect(once.message).not.toContain(secret);
    expect(twice.message).toBe(once.message);
  });
}

test("redacts established credential shapes and drops credential-like error identities", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature_value";
  const message = [
    "api_key=api-secret-1234",
    "access_token=access-secret-1234",
    "refresh_token: refresh-secret-1234",
    "id token is id-secret-1234",
    "authorization=auth-secret-1234",
    "token=plain-secret-1234",
    "sk-providersecret123",
    jwt,
  ].join("\n");
  const normalized = normalizePersistedError(Object.assign(new Error(message), {
    name: "sk-namesecret123",
    code: "token_TOPSECRET123",
  }));

  expect(normalized.name).toBe("Error");
  expect(normalized.code).toBeUndefined();
  expect(normalized.persistedErrorDetails).toEqual({ name: "Error" });
  for (const secret of [
    "api-secret-1234",
    "access-secret-1234",
    "refresh-secret-1234",
    "id-secret-1234",
    "auth-secret-1234",
    "plain-secret-1234",
    "providersecret123",
    jwt,
  ]) {
    expect(normalized.message).not.toContain(secret);
  }
  expect(normalized.message).toContain("[REDACTED]");
  expect(normalized.message).toContain("sk-[REDACTED]");
  expect(normalized.message).toContain("[REDACTED_JWT]");
});

for (const [label, message] of [
  ["assignment placeholder", "password=abc"],
  ["is placeholder", "token is abc"],
  ["authorization scheme placeholder", "Authorization Basic abc"],
  ["authorization header placeholder", "Authorization: Basic abc"],
  ["cookie header placeholder", "Cookie: session=abc; second=def"],
  ["Bearer placeholder", "Bearer abcdefgh"],
  ["provider key placeholder", "sk-providersecret123"],
  ["JWT placeholder", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature_value"],
  ["quoted JSON placeholder", '{"clientSecret":"abc"}'],
  ["external URL placeholders", "https://user:password@example.com/status?token=abc&code=42"],
  ["loopback URL placeholder", "http://localhost:43123/private?token=abc"],
] as const) {
  test(`keeps ${label} idempotent across repeated normalization`, () => {
    const once = normalizePersistedError(new Error(message));
    const twice = normalizePersistedError(once);
    const threeTimes = normalizePersistedError(twice);
    expect(twice.message).toBe(once.message);
    expect(threeTimes.message).toBe(once.message);
  });
}

test("removes terminal controls, reveals control-obfuscated credential labels, and preserves raw size", () => {
  const secret = "CONTROL_OBFUSCATED_SECRET";
  const tabSecret = "TAB_LABEL_SECRET";
  const lineFeedSecret = "LINE_FEED_LABEL_SECRET";
  const ansiSecret = "ANSI_LABEL_SECRET";
  const oscSecret = "OSC_LABEL_SECRET";
  const raw = [
    `pass\u0000word=${secret}`,
    `to\u001bken=${secret}`,
    `api\u0007key=${secret}`,
    `pass\tword=${tabSecret}`,
    `pass\nword=${lineFeedSecret}`,
    `pass\u001b[31mword=${ansiSecret}\u001b[0m`,
    `client\u001b]0;hostile-title\u0007secret=${oscSecret}`,
    "normal\u0000password=ordinary-diagnostic",
    "tab\tkept\rline-feed-kept",
    "\u0000\u001b\u0007\u007f".repeat(2 * 1024 * 1024),
  ].join("\n");
  const rawBytes = Buffer.byteLength(raw, "utf8");
  const once = normalizePersistedError(new Error(raw));
  const twice = normalizePersistedError(once);

  for (const value of [secret, tabSecret, lineFeedSecret, ansiSecret, oscSecret, "ordinary-diagnostic"]) {
    expect(once.message).not.toContain(value);
  }
  expect(once.message).toContain("password=[REDACTED]");
  expect(once.message).toContain("token=[REDACTED]");
  expect(once.message).toContain("apikey=[REDACTED]");
  expect(once.message).toContain("pass\tword=[REDACTED]");
  expect(once.message).toContain("pass\nword=[REDACTED]");
  expect(once.message).toContain("clientsecret=[REDACTED]");
  expect(once.message).toContain("normalpassword=[REDACTED]");
  expect(once.message).toContain("tab\tkept\nline-feed-kept");
  expect(once.message).not.toContain("[31m");
  expect(once.message).not.toContain("[0m");
  expect(once.message).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
  expect(Buffer.byteLength(once.message, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
  expect(once.persistedErrorDetails).toMatchObject({ truncated: true, originalMessageBytes: rawBytes });
  expect(twice.message).toBe(once.message);
  expect(twice.persistedErrorDetails).toEqual(once.persistedErrorDetails);
});

test("redacts every standalone Bearer scalar and unquoted assignment tails", () => {
  const unicodeToken = "秘密令牌";
  const mixedCaseToken = "AbcDefGh1";
  const spacedToken = "alpha beta secret";
  const angleToken = "ANGLE_TOKEN_SECRET";
  const angleAssignment = "ANGLE_ASSIGNMENT_SECRET";
  const hugeControlSeparatedToken = "Z".repeat(5 * 1024 * 1024);
  const message = [
    `password=${spacedToken}`,
    `password=<${angleAssignment}>`,
    "Bearer x",
    "bearer abc",
    `bearer ${unicodeToken}`,
    `bEaReR ${mixedCaseToken}`,
    `Bearer "${spacedToken}"`,
    `Bearer <${angleToken}>`,
    "Bearer\nNEWLINE_BEARER_SECRET",
    "Bearer\r\n CRLF_BEARER_SECRET",
    "Bearer\u0000NUL_BEARER_SECRET",
    "Bearer\u00a0NBSP_BEARER_SECRET",
    "bearer animal",
    "sk-x",
    "sk-abc",
    "sk-secret",
    "SK-MixedCase1",
    `Bearer\u0000${hugeControlSeparatedToken}`,
  ].join("\n");

  const once = normalizePersistedError(new Error(message));
  const twice = normalizePersistedError(once);

  for (const secret of [
    unicodeToken,
    mixedCaseToken,
    spacedToken,
    angleToken,
    angleAssignment,
    "NEWLINE_BEARER_SECRET",
    "CRLF_BEARER_SECRET",
    "NUL_BEARER_SECRET",
    "NBSP_BEARER_SECRET",
    hugeControlSeparatedToken.slice(0, 1_024),
  ]) {
    expect(once.message).not.toContain(secret);
  }
  expect(once.message).toContain("password=[REDACTED]");
  expect(once.message).toContain("bearer [REDACTED]");
  expect(once.message).toContain("bEaReR [REDACTED]");
  expect(once.message).toContain("Bearer [REDACTED]");
  expect(once.message).not.toContain("bearer animal");
  expect(once.message).not.toContain("sk-x");
  expect(once.message).not.toContain("sk-abc");
  expect(once.message).not.toContain("sk-secret");
  expect(once.message).not.toContain("MixedCase1");
  expect(once.message.match(/sk-\[REDACTED\]/giu)).toHaveLength(4);
  expect(once.message).toContain(`error message truncated from ${Buffer.byteLength(message, "utf8")} bytes`);
  expect(twice.message).toBe(once.message);
});

test("treats C0, C1, DEL, and Unicode whitespace as credential grammar gaps", () => {
  const controls = ["\u0000", "\u0007", "\u001b", "\u007f", "\u0080", "\u009f", "\u00a0", "\u202f", "\u2003", "\ufeff"];
  const messages: string[] = [];
  const secrets: string[] = [];
  for (const [index, gap] of controls.entries()) {
    const suffix = `GAP_SECRET_${index}`;
    secrets.push(
      `BEARER_${suffix}`,
      `TOKEN_BEFORE_${suffix}`,
      `TOKEN_AFTER_${suffix}`,
      `AUTH_BEFORE_${suffix}`,
      `AUTH_AFTER_${suffix}`,
    );
    messages.push(
      `Bearer${gap}BEARER_${suffix}`,
      `token${gap}is TOKEN_BEFORE_${suffix}`,
      `token is${gap}TOKEN_AFTER_${suffix}`,
      `Authorization${gap}Basic AUTH_BEFORE_${suffix}`,
      `Authorization Basic${gap}AUTH_AFTER_${suffix}`,
    );
  }
  for (const [index, gap] of ["\t", "\n", "\u0000", "\u007f", "\u0080"].entries()) {
    const suffix = `INTERNAL_GAP_SECRET_${index}`;
    secrets.push(
      `BEARER_${suffix}`,
      `AUTH_${suffix}`,
      `SK_WORD_${suffix}`,
      `SK_HYPHEN_${suffix}`,
      `SK_VALUE_${suffix}`,
    );
    messages.push(
      `Bea${gap}rer BEARER_${suffix}`,
      `Authorization Ba${gap}sic AUTH_${suffix}`,
      `s${gap}k-SK_WORD_${suffix}`,
      `sk${gap}-SK_HYPHEN_${suffix}`,
      `sk-${gap}SK_VALUE_${suffix}`,
    );
  }

  const once = normalizePersistedError(new Error(messages.join("\n")));
  const twice = normalizePersistedError(once);

  for (const secret of secrets) expect(once.message).not.toContain(secret);
  expect(once.message.match(/\[REDACTED\]/gu)?.length).toBe(messages.length);
  expect(once.message).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
  expect(twice.message).toBe(once.message);
});

test("keeps a worst-sized credential placeholder idempotent", () => {
  const raw = `password=${"x".repeat(5 * 1024 * 1024)}`;
  const once = normalizePersistedError(new Error(raw));
  const twice = normalizePersistedError(once);
  const threeTimes = normalizePersistedError(twice);

  expect(once.message).toContain("password=[REDACTED]");
  expect(once.message).toContain(`truncated from ${Buffer.byteLength(raw, "utf8")} bytes`);
  expect(twice.message).toBe(once.message);
  expect(threeTimes.message).toBe(once.message);
  expect(threeTimes.persistedErrorDetails).toEqual(once.persistedErrorDetails);
});

for (const message of [
  "password=[REDACTED]PASSWORD_SUFFIX_SECRET",
  "token is [REDACTED]TOKEN_SUFFIX_SECRET",
  "Authorization Basic [REDACTED]AUTH_SUFFIX_SECRET",
] as const) {
  test(`does not treat a redaction placeholder as a safe credential prefix: ${message.slice(0, 24)}`, () => {
    const normalized = normalizePersistedError(new Error(message));
    expect(normalized.message).toContain("[REDACTED]");
    expect(normalized.message).not.toContain("SUFFIX_SECRET");
    expect(normalizePersistedError(normalized).message).toBe(normalized.message);
  });
}

test("retains source truncation bytes after redaction and preserves ordinary machine codes", () => {
  const rawToken = "T".repeat(5 * 1024 * 1024);
  const normalized = normalizePersistedError(Object.assign(new Error(`Bearer ${rawToken}`), {
    code: "TOKEN_INVALIDATED",
  }));

  expect(normalized.code).toBe("TOKEN_INVALIDATED");
  expect(normalized.message).toContain("Bearer [REDACTED]");
  expect(normalized.message).not.toContain(rawToken.slice(0, 1_024));
  expect(normalized.message).toContain(`error message truncated from ${Buffer.byteLength(`Bearer ${rawToken}`, "utf8")} bytes`);
  expect(normalized.persistedErrorDetails).toMatchObject({
    code: "TOKEN_INVALIDATED",
    truncated: true,
    originalMessageBytes: Buffer.byteLength(`Bearer ${rawToken}`, "utf8"),
  });
});

test("redacts auth schemes, percent-encoded credentials, and external URL credential fields", () => {
  const message = [
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "authorization=ApiKey APIKEYSECRET123",
    "access token is Token ACCESSSECRET123",
    "Bearer abc%2Fdef%3Dghi",
    "api_key=key%2Fsecret%3Dvalue",
    "https://user-secret:password-secret@example.com/v1/status?code=42&access_token=url%2Fsecret%3Dvalue&key=key-secret",
  ].join("\n");
  const normalized = normalizePersistedError(new Error(message));

  for (const secret of [
    "dXNlcjpwYXNzd29yZA",
    "APIKEYSECRET123",
    "ACCESSSECRET123",
    "abc%2Fdef%3Dghi",
    "key%2Fsecret%3Dvalue",
    "user-secret",
    "password-secret",
    "url%2Fsecret%3Dvalue",
    "key-secret",
  ]) {
    expect(normalized.message).not.toContain(secret);
  }
  expect(normalized.message).toContain("example.com/v1/status");
  expect(normalized.message).toContain("code=42");
  expect(normalized.message).toContain("REDACTED@example.com");
});

test("redacts hierarchical URL credentials and control-obfuscated decoded query keys", () => {
  const urls = [
    "postgres://dbuser:dbpassword@example.com/app?code=42",
    "redis://:redispassword@example.com/0",
    "amqp://rabbit:rabbitpassword@example.com/vhost",
    "ftp://ftpuser:ftppassword@example.com/file",
    "custom+ssh://user%40name:pass%20word@example.com/path?to%00ken=URL_NUL_SECRET&code=public",
    "https://example.com/path?to%09ken=URL_TAB_SECRET&to%0Aken=URL_LF_SECRET",
    "https://example.com/path?to%1Bken=URL_ESC_SECRET&pass%1B%5B31mword=URL_CSI_SECRET",
    "postgres://loopuser:looppassword@localhost/private",
  ];
  const publicUrl = "custom+ssh://example.com/public?code=42";
  const ordinaryText = "Windows C:\\repo\\file and opaque foo:bar are ordinary diagnostics";
  const once = normalizePersistedError(new Error([...urls, publicUrl, ordinaryText].join("\n")));
  const twice = normalizePersistedError(once);

  for (const secret of [
    "dbuser",
    "dbpassword",
    "redispassword",
    "rabbit",
    "rabbitpassword",
    "ftpuser",
    "ftppassword",
    "user%40name",
    "pass%20word",
    "URL_NUL_SECRET",
    "URL_TAB_SECRET",
    "URL_LF_SECRET",
    "URL_ESC_SECRET",
    "URL_CSI_SECRET",
    "loopuser",
    "looppassword",
  ]) {
    expect(once.message).not.toContain(secret);
  }
  expect(once.message).toContain("postgres://REDACTED@example.com/app?code=42");
  expect(once.message).toContain("custom+ssh://REDACTED@example.com/path");
  expect(once.message).toContain("code=public");
  expect(once.message).toContain("[loopback URL redacted]");
  expect(once.message).toContain(publicUrl);
  expect(once.message).toContain(ordinaryText);
  expect(twice.message).toBe(once.message);
});

test("redacts namespaced credential labels without widening to arbitrary key-like words", () => {
  const assignments = [
    "OPENAI_API_KEY=OPENAI_NAMESPACE_SECRET",
    "github_token=GITHUB_NAMESPACE_SECRET",
    "DB_PASSWORD=DB_NAMESPACE_SECRET",
    "DATABASE_CLIENT_SECRET=CLIENT_NAMESPACE_SECRET",
    "MY_SECRET=GENERIC_NAMESPACE_SECRET",
    "STRIPE_SECRET_KEY=STRIPE_NAMESPACE_SECRET",
    "consumer_secret=CONSUMER_NAMESPACE_SECRET",
    "auth_token=AUTH_NAMESPACE_SECRET",
    "oauth_token=OAUTH_NAMESPACE_SECRET",
    "private_token=PRIVATE_NAMESPACE_SECRET",
    '{"openai_api_key":"JSON_NAMESPACE_SECRET"}',
    "X-Api-Key: HEADER_NAMESPACE_SECRET",
  ];
  const queryUrl = "https://example.com/status?x-api-key=QUERY_DASH_SECRET&OPENAI_API_KEY=QUERY_NAMESPACE_SECRET&code=42";
  const ordinary = [
    "normalpassword=ordinary",
    "monkey=ordinary",
    "public_key=ordinary",
    "notasecretary=ordinary",
    "api_key_like_text=ordinary",
  ];
  const once = normalizePersistedError(new Error([...assignments, queryUrl, ...ordinary].join("\n")));
  const twice = normalizePersistedError(once);

  for (const secret of [
    "OPENAI_NAMESPACE_SECRET",
    "GITHUB_NAMESPACE_SECRET",
    "DB_NAMESPACE_SECRET",
    "CLIENT_NAMESPACE_SECRET",
    "GENERIC_NAMESPACE_SECRET",
    "STRIPE_NAMESPACE_SECRET",
    "CONSUMER_NAMESPACE_SECRET",
    "AUTH_NAMESPACE_SECRET",
    "OAUTH_NAMESPACE_SECRET",
    "PRIVATE_NAMESPACE_SECRET",
    "JSON_NAMESPACE_SECRET",
    "HEADER_NAMESPACE_SECRET",
    "QUERY_DASH_SECRET",
    "QUERY_NAMESPACE_SECRET",
  ]) {
    expect(once.message).not.toContain(secret);
  }
  expect(once.message).toContain("code=42");
  for (const line of ordinary) expect(once.message).toContain(line);
  expect(twice.message).toBe(once.message);
});

test("drops namespaced credential identities while preserving status-only suffixes", () => {
  const unsafe = normalizePersistedError(Object.assign(new Error("request failed"), {
    name: "OPENAI_API_KEY_supersecret",
    code: "STRIPE_SECRET_KEY_supersecret",
  }));
  expect(unsafe.name).toBe("Error");
  expect(unsafe.code).toBeUndefined();

  const status = normalizePersistedError(Object.assign(new Error("request failed"), {
    name: "OPENAI_API_KEY_INVALID",
    code: "STRIPE_SECRET_KEY_EXPIRED",
  }));
  expect(status.name).toBe("OPENAI_API_KEY_INVALID");
  expect(status.code).toBe("STRIPE_SECRET_KEY_EXPIRED");
});

for (const [label, message, secret] of [
  ["plain token-is value", "token is abcdefgh", "abcdefgh"],
  ["plain access-token-is value", "access token is abcdefgh", "abcdefgh"],
  ["diagnostic-looking token value", "token is invalid", "invalid"],
  ["Authorization Basic without colon", "Authorization Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
  ["authorization ApiKey without colon", "authorization ApiKey ABCDEFGH", "ABCDEFGH"],
  ["client_secret assignment", "client_secret=verysecret123", "verysecret123"],
  ["client-secret assignment", "client-secret=verysecret456", "verysecret456"],
  ["password assignment", "password=hunter2secret", "hunter2secret"],
  ["labeled cookie assignment", "cookie: session=abcdefghijk", "abcdefghijk"],
  ["session id assignment", "session_id=sessionsecret123", "sessionsecret123"],
  [
    "external URL client_secret query",
    "request https://example.com/status?code=401&client_secret=abcdefghijk failed",
    "abcdefghijk",
  ],
  ["short password assignment", "password=abc", "abc"],
  ["one-character token assignment", "token=x", "x"],
  ["one-character Authorization Basic", "Authorization Basic x", " x"],
  ["Unicode password assignment", "password=秘密", "秘密"],
  ["emoji token assignment", "token=🔑", "🔑"],
  ["quoted JSON password", '{"password":"hunter2secret"}', "hunter2secret"],
  ["quoted JSON client secret", '{"client_secret":"verysecret123"}', "verysecret123"],
  ["camel clientSecret assignment", "clientSecret=camelvalue", "camelvalue"],
  ["camel accessToken assignment", "accessToken: shortvalue", "shortvalue"],
  ["quoted JSON camel clientSecret", '{"clientSecret":"jsoncamelvalue"}', "jsoncamelvalue"],
  ["space-containing quoted password", 'password="alpha beta secret"', "alpha beta secret"],
  ["space-containing quoted token-is", 'token is "alpha beta secret"', "alpha beta secret"],
  ["quoted Authorization Basic header", 'Authorization: Basic "abc def"', "abc def"],
  ["bare secret assignment", "secret=verysecret", "verysecret"],
  ["private key assignment", "private_key=privatevalue", "privatevalue"],
  ["AWS secret access key assignment", "AWS_SECRET_ACCESS_KEY=awssecretvalue", "awssecretvalue"],
  ["webhook secret assignment", "webhook_secret=webhookvalue", "webhookvalue"],
  ["passphrase assignment", "passphrase=phrasevalue", "phrasevalue"],
  ["pwd assignment", "pwd=p", "=p"],
  [
    "short percent-encoded external URL token",
    "request https://example.com/v1/status?code=401&token=%E7%A7%98 failed",
    "%E7%A7%98",
  ],
] as const) {
  test(`redacts ${label}`, () => {
    const normalized = normalizePersistedError(new Error(message));
    expect(normalized.message).toContain("REDACTED");
    expect(normalized.message).not.toContain(secret);
  });
}

for (const [label, message, secrets] of [
  ["Cookie header", "Cookie: foo=abcd; bar=secondsecret", ["foo=abcd", "bar=secondsecret"]],
  ["Set-Cookie header", "Set-Cookie: session=abcdefgh; HttpOnly; token=secondsecret", ["session=abcdefgh", "secondsecret"]],
] as const) {
  test(`redacts the complete ${label} value`, () => {
    const normalized = normalizePersistedError(new Error(message));
    expect(normalized.message).toContain("[REDACTED]");
    for (const secret of secrets) expect(normalized.message).not.toContain(secret);
  });
}

test("drops credential-shaped password and client secret identities", () => {
  const normalized = normalizePersistedError(Object.assign(new Error("request failed"), {
    name: "password_supersecret123",
    code: "client_secret.supersecret123",
  }));
  expect(normalized.name).toBe("Error");
  expect(normalized.code).toBeUndefined();
});

for (const [name, code] of [
  ["password_supersecret", "E_SAFE"],
  ["RemoteError", "client_secret.supersecret"],
  ["session_cookie_supersecret", "E_SAFE"],
  ["private_key_supersecret", "E_SAFE"],
  ["RemoteError", "webhook_secret.supersecret"],
] as const) {
  test(`drops pure-alpha credential identity ${name}/${code}`, () => {
    const normalized = normalizePersistedError(Object.assign(new Error("request failed"), { name, code }));
    if (name === "RemoteError") expect(normalized.name).toBe("RemoteError");
    else expect(normalized.name).toBe("Error");
    if (code === "E_SAFE") expect(normalized.code).toBe("E_SAFE");
    else expect(normalized.code).toBeUndefined();
  });
}

for (const [name, code] of [
  ["passwordSupersecret", "E_SAFE"],
  ["PasswordSupersecret", "E_SAFE"],
  ["RemoteError", "clientSecretSupersecret"],
  ["RemoteError", "AccessTokenSupersecret"],
] as const) {
  test(`drops camel credential identity ${name}/${code}`, () => {
    const normalized = normalizePersistedError(Object.assign(new Error("request failed"), { name, code }));
    if (name === "RemoteError") expect(normalized.name).toBe("RemoteError");
    else expect(normalized.name).toBe("Error");
    if (code === "E_SAFE") expect(normalized.code).toBe("E_SAFE");
    else expect(normalized.code).toBeUndefined();
  });
}

for (const [name, code] of [
  ["PasswordInvalidError", "E_SAFE"],
  ["ClientSecretMissingError", "TokenInvalidatedError"],
  ["AccessTokenExpired", "client_secret.not_found_error"],
] as const) {
  test(`preserves credential-related status identity ${name}/${code}`, () => {
    const normalized = normalizePersistedError(Object.assign(new Error("request failed"), { name, code }));
    expect(normalized.name).toBe(name);
    expect(normalized.code).toBe(code);
  });
}
