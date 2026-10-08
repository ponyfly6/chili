import { App as NativeApp } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { createNativeControlPlatform, type DeviceRecoveryRecord } from "@chili/remote-control/browser";
import type { ControlAppPlatform } from "../../control-web/src/platform.js";
import type { StoredMutationOutcome } from "../../control-web/src/outcome-journal.js";
import { createNativePostJson, type NativeBridge } from "./native-transport.js";

const native = registerPlugin<NativeBridge>("ChiliNative");
const RECOVERY_KEY = "device-recovery.v1";
const OUTCOMES_KEY = "uncertain-outcomes.v1";

export function createMobilePlatform(): ControlAppPlatform {
  if (!Capacitor.isNativePlatform()) throw new Error("Chili mobile must run inside the installed app.");
  return {
    kind: "native",
    createClientPlatform: (baseUrl) => createNativeControlPlatform({ baseUrl, crypto: window.crypto, postJson: createNativePostJson(native) }),
    recoveryStore: {
      async load() {
        const stored = await native.get({ key: RECOVERY_KEY });
        // The protocol validates the entire record before attempting resume.
        return stored.value === null ? null : JSON.parse(stored.value) as DeviceRecoveryRecord;
      },
      async save(record) { await native.set({ key: RECOVERY_KEY, value: JSON.stringify(record) }); },
      async clear() { await native.remove({ key: RECOVERY_KEY }); },
    },
    outcomeStore: {
      async load() {
        const stored = await native.get({ key: OUTCOMES_KEY });
        // UI validation rejects malformed entries; it never treats them as a
        // safe successful result or silently retries the original operation.
        return stored.value === null ? [] : JSON.parse(stored.value) as readonly StoredMutationOutcome[];
      },
      async save(outcomes) { await native.set({ key: OUTCOMES_KEY, value: JSON.stringify(outcomes) }); },
    },
    onResume(listener) {
      let active = true;
      const subscription = NativeApp.addListener("appStateChange", ({ isActive }) => { if (active && isActive) listener(); });
      return () => {
        active = false;
        void subscription.then((handle) => handle.remove()).catch(() => undefined);
      };
    },
  };
}
