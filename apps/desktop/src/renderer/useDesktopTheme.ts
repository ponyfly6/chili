import { useLayoutEffect, useRef, useState } from "react";
import {
  applyDesktopTheme,
  parseDesktopTheme,
  type DesktopTheme,
} from "./theme.js";

export function useDesktopTheme() {
  const [theme, setTheme] = useState(() => parseDesktopTheme(document.documentElement.getAttribute("data-theme")));
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);

  useLayoutEffect(() => applyDesktopTheme(theme), [theme]);

  const changeTheme = async (next: DesktopTheme) => {
    const currentRevision = ++revision.current;
    setTheme(next);
    setSaving(true);
    setSaveFailed(false);
    try {
      await window.chiliDesktop.invoke({ type: "appearance.set", theme: next });
    } catch {
      if (currentRevision === revision.current) setSaveFailed(true);
    } finally {
      if (currentRevision === revision.current) setSaving(false);
    }
  };

  return { theme, changeTheme, saveFailed, saving };
}
