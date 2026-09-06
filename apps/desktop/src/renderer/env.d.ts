/// <reference types="vite/client" />

import type { ChiliDesktopApi } from "../shared/contracts.js";
import type { ChiliRemoteDesktopApi } from "../shared/remote-control-contracts.js";

declare global {
  interface Window {
    chiliDesktop: ChiliDesktopApi;
    chiliRemote: ChiliRemoteDesktopApi;
  }
}

export {};
