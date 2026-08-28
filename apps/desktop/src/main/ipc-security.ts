import { isTrustedRendererUrl, type RendererTrustPolicy } from "./window-security.js";

export interface DesktopIpcSenderBoundary {
  expectedWindow: unknown;
  ownerWindow: unknown;
  expectedWebContents: unknown;
  senderWebContents: unknown;
  expectedMainFrame: unknown;
  senderFrame: { url: string } | null | undefined;
}

export function requireTrustedDesktopIpcSender(
  boundary: DesktopIpcSenderBoundary,
  policy: RendererTrustPolicy,
): void {
  if (
    boundary.ownerWindow !== boundary.expectedWindow
    || boundary.senderWebContents !== boundary.expectedWebContents
    || !boundary.senderFrame
    || boundary.senderFrame !== boundary.expectedMainFrame
  ) {
    throw new Error("Rejected desktop IPC from an untrusted frame");
  }
  if (!isTrustedRendererUrl(boundary.senderFrame.url, policy)) {
    throw new Error("Rejected desktop IPC from an untrusted origin");
  }
}
