import { useEffect, useRef, useState } from "react";
import { detectSystemTheme, type SystemThemePaletteRenderer } from "./system.js";
import type { TuiTheme } from "./types.js";

export const DEFAULT_SYSTEM_THEME_REFRESH_MS = 1_500;

export interface LiveSystemThemeOptions {
  enabled: boolean;
  initialTheme?: TuiTheme | undefined;
  refreshMs?: number | undefined;
}

export function useLiveSystemTheme(renderer: SystemThemePaletteRenderer, options: LiveSystemThemeOptions): TuiTheme | undefined {
  const [systemTheme, setSystemTheme] = useState<TuiTheme | undefined>(options.initialTheme);
  const signatureRef = useRef(tuiThemeSignature(options.initialTheme));

  useEffect(() => {
    const nextSignature = tuiThemeSignature(options.initialTheme);
    if (signatureRef.current === nextSignature) return;
    signatureRef.current = nextSignature;
    setSystemTheme(options.initialTheme);
  }, [options.initialTheme]);

  useEffect(() => {
    if (!options.enabled || !renderer.getPalette) return;

    const refreshMs = options.refreshMs ?? DEFAULT_SYSTEM_THEME_REFRESH_MS;
    let stopped = false;
    let inFlight = false;

    const refresh = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const nextTheme = await detectSystemTheme(renderer, { clearCache: true });
        if (!nextTheme || stopped) return;
        const nextSignature = tuiThemeSignature(nextTheme);
        if (signatureRef.current === nextSignature) return;
        signatureRef.current = nextSignature;
        setSystemTheme(nextTheme);
      } finally {
        inFlight = false;
      }
    };

    void refresh();
    if (refreshMs <= 0) {
      return () => {
        stopped = true;
      };
    }

    const interval = setInterval(() => {
      void refresh();
    }, refreshMs);

    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [options.enabled, options.refreshMs, renderer]);

  return systemTheme;
}

function tuiThemeSignature(theme: TuiTheme | undefined): string {
  return theme ? JSON.stringify(theme.colors) : "";
}
