import { createHash } from "node:crypto";
import { raceWithSignal, requestDeadline } from "./oauth-refresh.js";
import type { ProviderBackpressureCoordinator, ProviderRequestScope } from "./provider-backpressure.js";
import type { ModelRequestIdentity, ModelStreamEvent, ModelStreamInput } from "./types.js";

/** Includes authentication, account backpressure, connection setup and the complete response. */
export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 300_000;

export function credentialVersionFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function recordRequestIdentity(input: ModelStreamInput, identity: ModelRequestIdentity): Promise<void> {
  input.signal?.throwIfAborted();
  await input.onRequestIdentity?.(identity);
  input.signal?.throwIfAborted();
}

export async function* runModelRequest(
  input: ModelStreamInput,
  stream: (bounded: ModelStreamInput) => AsyncIterable<ModelStreamEvent>,
): AsyncIterable<ModelStreamEvent> {
  const deadline = requestDeadline(input.signal, input.requestTimeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS);
  const iterator = stream({ ...input, signal: deadline.signal })[Symbol.asyncIterator]();
  try {
    while (true) {
      deadline.signal.throwIfAborted();
      const next = await raceWithSignal(iterator.next(), deadline.signal);
      if (next.done) return;
      yield next.value;
    }
  } catch (error) {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    deadline.dispose();
    // An injected transport may ignore cancellation. Do not let it trap the caller's Stop.
    void iterator.return?.().catch(() => undefined);
  }
}

export async function* withProviderBackpressure(
  coordinator: ProviderBackpressureCoordinator,
  scope: ProviderRequestScope,
  signal: AbortSignal | undefined,
  stream: () => AsyncIterable<ModelStreamEvent>,
): AsyncIterable<ModelStreamEvent> {
  await coordinator.beforeRequest(scope, signal);
  try {
    for await (const event of stream()) {
      if (event.type === "error") coordinator.recordError(scope, event.error);
      yield event;
    }
  } catch (error) {
    coordinator.recordError(scope, error);
    throw error;
  }
}
