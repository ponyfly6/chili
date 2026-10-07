import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  sessionConfigAfterSelectionChange,
  sessionConfigResponseForSelection,
} from "./session-config-state.js";

interface ConfigFixture {
  model: { sessionId: string };
  delegation: { sessionId: string };
  marker: string;
}

test("clears config on session switch and accepts only a response for the current selection", () => {
  const sessionA: ConfigFixture = {
    model: { sessionId: "session-a" },
    delegation: { sessionId: "session-a" },
    marker: "A",
  };
  const sessionB: ConfigFixture = {
    model: { sessionId: "session-b" },
    delegation: { sessionId: "session-b" },
    marker: "B",
  };
  expect(sessionConfigAfterSelectionChange("session-a", "session-a", sessionA)).toBe(sessionA);
  expect(sessionConfigAfterSelectionChange("session-a", "session-b", sessionA)).toBeUndefined();
  expect(sessionConfigAfterSelectionChange("session-a", undefined, sessionA)).toBeUndefined();
  expect(sessionConfigResponseForSelection("session-b", sessionA)).toBeUndefined();
  expect(sessionConfigResponseForSelection("session-b", sessionB)).toBe(sessionB);
  expect(sessionConfigResponseForSelection(undefined, sessionA)).toBeUndefined();
});

test("rejects a mixed-session aggregate even when its model session matches", () => {
  const selected = "session-b";
  const matching: ConfigFixture = {
    model: { sessionId: selected },
    delegation: { sessionId: selected },
    marker: "matching",
  };
  expect(sessionConfigResponseForSelection(selected, matching)).toBe(matching);
  expect(sessionConfigResponseForSelection(selected, {
    ...matching,
    model: { sessionId: "session-a" },
  })).toBeUndefined();
  expect(sessionConfigResponseForSelection(selected, {
    ...matching,
    delegation: { sessionId: "session-a" },
  })).toBeUndefined();
});

test("wires App selection changes and async config acceptance through the session boundary", async () => {
  const source = await readFile(resolve(import.meta.dirname, "App.tsx"), "utf8");
  const selection = source.slice(
    source.indexOf("const setSelectedId = useCallback"),
    source.indexOf("const setSnapshot = useCallback"),
  );
  expect(selection).toContain("selectedRef.current = selectedNext");
  expect(selection).toContain("sessionConfigAfterSelectionChange(selectedPrevious, selectedNext, current)");

  const reload = source.slice(
    source.indexOf("const reloadSessionConfig = useCallback"),
    source.indexOf("useEffect(() =>", source.indexOf("const reloadSessionConfig = useCallback")),
  );
  const response = reload.indexOf("await projectTransport().sessionConfig(sessionId)");
  const selectedGuard = reload.indexOf("selectedRef.current === sessionId");
  const aggregateGuard = reload.indexOf("sessionConfigResponseForSelection(selectedRef.current, next)");
  const configUpdate = reload.indexOf("setSessionConfig(accepted)");
  const modelUpdate = reload.indexOf("setModels(accepted.model.models)");
  expect(response).toBeGreaterThan(0);
  expect(selectedGuard).toBeGreaterThan(response);
  expect(aggregateGuard).toBeGreaterThan(selectedGuard);
  expect(configUpdate).toBeGreaterThan(aggregateGuard);
  expect(modelUpdate).toBeGreaterThan(configUpdate);
});

test("replays runtime events that arrive while a cancelled session is resuming", async () => {
  const source = await readFile(resolve(import.meta.dirname, "App.tsx"), "utf8");
  const resume = source.slice(
    source.indexOf("const resumeSession = async"),
    source.indexOf("const saveSessionSettings", source.indexOf("const resumeSession = async")),
  );
  expect(resume).toMatch(
    /coordinator\.refreshSessionSnapshot\(\s*selectedId,\s*\(\) => transport\.resumeSession\(selectedId\),?\s*\)/u,
  );
  expect(resume).not.toContain("const next = await transport.resumeSession(selectedId)");
});
