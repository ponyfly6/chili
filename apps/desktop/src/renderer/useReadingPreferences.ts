import { useEffect, useRef, useState } from "react";
import { defaultReadingPreferences, type ReadingPreferences } from "../shared/reading-preferences.js";

export function useReadingPreferences() {
  const [preferences, setPreferences] = useState({ ...defaultReadingPreferences });
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    const initialRevision = revision.current;
    void window.chiliDesktop.invoke({ type: "reading.get" }).then((next) => {
      if (active && revision.current === initialRevision) setPreferences(next);
    }).catch(() => { if (active) setSaveFailed(true); });
    return () => { active = false; };
  }, []);
  const savePreferences = async (next: ReadingPreferences) => {
    const request = ++revision.current;
    setPreferences(next);
    setSaving(true);
    setSaveFailed(false);
    try { await window.chiliDesktop.invoke({ type: "reading.set", ...next }); }
    catch { if (revision.current === request) setSaveFailed(true); }
    finally { if (revision.current === request) setSaving(false); }
  };
  return { preferences, saving, saveFailed, savePreferences };
}
