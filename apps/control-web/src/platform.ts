import type { ControlClientPlatform, DeviceRecoveryRecord } from "@chili/remote-control/browser";
import type { OutcomeStore } from "./outcome-journal.js";

/** Only the bundled native entry point may supply this bridge. */
export interface ControlAppPlatform {
  kind: "native";
  createClientPlatform(baseUrl: string): ControlClientPlatform;
  recoveryStore: {
    load(): Promise<DeviceRecoveryRecord | null>;
    save(record: DeviceRecoveryRecord): Promise<void>;
    clear(): Promise<void>;
  };
  outcomeStore: OutcomeStore;
  onResume?(listener: () => void): () => void;
}
