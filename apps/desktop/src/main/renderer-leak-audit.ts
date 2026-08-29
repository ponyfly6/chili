export const RENDERER_CREDENTIAL_PATTERN_SOURCE = String.raw`https?://(?:127[.]0[.]0[.]1|localhost)(?=[:/?#]|$)|(?:^|[^A-Za-z0-9_])bearer(?:[^A-Za-z0-9_]|$)|chili[.]sidecar[.]credential[.]v1:|"(?:authorization|proxy-authorization|token|authToken|accessToken|refreshToken|idToken|apiKey|credential|credentials)" *:`;

export function containsRendererCredentialMaterial(serialized: string): boolean {
  return new RegExp(RENDERER_CREDENTIAL_PATTERN_SOURCE, "iu").test(serialized);
}
