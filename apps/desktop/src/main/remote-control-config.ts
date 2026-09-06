import { resolve } from "node:path";
import type { PrivateControlTlsMaterial } from "@chili/remote-control";

export interface DesktopRemoteHttpsConfig {
  bindAddress: string;
  port: number;
  publicOrigin: string;
  tlsCertPath: string;
  tlsKeyPath: string;
  /** Main-only, one-use material prepared for the listener; never persisted or projected. */
  tlsMaterial?: PrivateControlTlsMaterial;
  webRoot: string;
}

/** Local launch configuration only; never accepts browser/IPC-supplied paths. */
export function remoteControlConfiguration(
  environment: NodeJS.ProcessEnv,
  defaultWebRoot: string,
): DesktopRemoteHttpsConfig | undefined {
  const bindAddress = environment.CHILI_REMOTE_BIND_ADDRESS?.trim();
  const portText = environment.CHILI_REMOTE_PORT?.trim();
  const publicOrigin = environment.CHILI_REMOTE_ORIGIN?.trim();
  const tlsCertPath = environment.CHILI_REMOTE_TLS_CERT?.trim();
  const tlsKeyPath = environment.CHILI_REMOTE_TLS_KEY?.trim();
  if (!bindAddress || !portText || !publicOrigin || !tlsCertPath || !tlsKeyPath) return undefined;
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65_535) {
    throw new Error("CHILI_REMOTE_PORT must be a port from 1 to 65535");
  }
  return {
    bindAddress,
    port: Number(portText),
    publicOrigin,
    tlsCertPath: resolve(tlsCertPath),
    tlsKeyPath: resolve(tlsKeyPath),
    webRoot: resolve(environment.CHILI_REMOTE_WEB_ROOT?.trim() || defaultWebRoot),
  };
}
