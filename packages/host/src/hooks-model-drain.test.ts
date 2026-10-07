import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostSessionOwnerConflictError } from "@chili/store";
import { createChiliHost, type ChiliHost, type ChiliHostOptions } from "./host.js";
import * as userModelState from "./user-model-state.js";

test("Host close drains an already started model preference write before releasing ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-hook-model-drain-"));
  const cwd = join(root, "workspace");
  const chiliHome = join(root, "home");
  await mkdir(cwd, { recursive: true });
  const options: ChiliHostOptions = {
    cwd, chiliHome, model: "fake", permissionProfile: "full-access",
    mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false,
  };
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const originalWrite = userModelState.writeUserModelSelection;
  const write = spyOn(userModelState, "writeUserModelSelection").mockImplementation(async (selection, stateOptions) => {
    entered();
    await released;
    await originalWrite(selection, stateOptions);
  });
  let host: ChiliHost | undefined;
  let reopened: ChiliHost | undefined;
  let closing: Promise<void> | undefined;
  try {
    host = await createChiliHost(options);
    const sessionId = (await host.service.createSession()).sessionId;
    const modelSelection = { provider: "fixture", model: "saved-before-close" };
    const changing = host.service.setModel({ sessionId, modelSelection }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await started;
    closing = host.close();
    expect(await Promise.race([changing.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false);
    expect(await Promise.race([closing.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false);
    const other = await createChiliHost(options);
    try {
      await expect(other.service.acquireSession(sessionId)).rejects.toBeInstanceOf(HostSessionOwnerConflictError);
      const independent = await other.service.createSession();
      expect(independent.sessionId).not.toBe(sessionId);
    } finally { await other.close(); }

    release();
    expect(await changing).toMatchObject({ status: "fulfilled", value: { modelSelection } });
    await closing;
    expect(await userModelState.readUserModelSelection({ chiliHome })).toEqual(modelSelection);
    reopened = await createChiliHost(options);
    await reopened.service.acquireSession(sessionId);
    const nextSessionId = (await reopened.service.createSession()).sessionId;
    const nextSelection = { provider: "fixture", model: "saved-by-next-host" };
    await reopened.service.setModel({ sessionId: nextSessionId, modelSelection: nextSelection });
    expect(await userModelState.readUserModelSelection({ chiliHome })).toEqual(nextSelection);
  } finally {
    release();
    await reopened?.close();
    await (closing ?? host?.close());
    write.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("a synchronous committed model observer can close the Host before the mandatory preference write starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-hook-model-commit-close-"));
  const cwd = join(root, "workspace");
  const chiliHome = join(root, "home");
  await mkdir(cwd, { recursive: true });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let writeStarted = false;
  let observerSawStartedWrite: boolean | undefined;
  let armed = false;
  let host: ChiliHost | undefined;
  let closing: Promise<void> | undefined;
  const originalWrite = userModelState.writeUserModelSelection;
  const write = spyOn(userModelState, "writeUserModelSelection").mockImplementation(async (selection, stateOptions) => {
    writeStarted = true;
    entered();
    await released;
    await originalWrite(selection, stateOptions);
  });
  const options: ChiliHostOptions = {
    cwd, chiliHome, model: "fake", permissionProfile: "full-access",
    mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false,
    modules: [{ id: "fixture.close-after-model-commit", runtime: {
      eventTypes: ["session.model_changed"],
      event() {
        if (!armed) return;
        armed = false;
        observerSawStartedWrite = writeStarted;
        closing = host!.close();
      },
    } }],
  };
  try {
    host = await createChiliHost(options);
    const sessionId = (await host.service.createSession()).sessionId;
    const modelSelection = { provider: "fixture", model: "committed-before-close" };
    armed = true;
    const changing = host.service.setModel({ sessionId, modelSelection }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    expect(await Promise.race([started.then(() => true), Bun.sleep(1_000).then(() => false)])).toBe(true);
    expect(observerSawStartedWrite).toBe(false);
    expect(closing).toBeDefined();
    expect(await Promise.race([closing!.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false);
    const other = await createChiliHost(options);
    try {
      await expect(other.service.acquireSession(sessionId)).rejects.toBeInstanceOf(HostSessionOwnerConflictError);
      const independent = await other.service.createSession();
      expect(independent.sessionId).not.toBe(sessionId);
    } finally { await other.close(); }
    release();
    expect(await changing).toMatchObject({ status: "fulfilled", value: { modelSelection } });
    await closing;
    expect(await userModelState.readUserModelSelection({ chiliHome })).toEqual(modelSelection);
  } finally {
    release();
    await (closing ?? host?.close());
    write.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
