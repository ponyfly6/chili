export interface DesktopKeychainPolicyInput {
  platform: NodeJS.Platform;
  localAdHocBuild: boolean;
  smokeMode: boolean;
}

export function shouldUseMockKeychain(input: DesktopKeychainPolicyInput): boolean {
  if (input.platform !== "darwin") return false;
  return input.localAdHocBuild || input.smokeMode;
}
