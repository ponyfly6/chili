/// <reference types="vite/client" />

import type { ChiliDesktopApi } from "../shared/contracts.js";

declare global {
  interface Window {
    chiliDesktop: ChiliDesktopApi;
  }
}

export {};
