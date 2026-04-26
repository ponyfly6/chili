import type {
  ChiliModel,
  ChiliModelProvider,
  ModelDescriptor,
  ModelStreamEvent,
  ModelStreamInput,
} from "../types.js";

export const FAUX_CHILI_PROVIDER_ID = "faux";
export const FAUX_CHILI_PROVIDER_NAME = "Faux";
export const FAUX_CHILI_MODEL_ID = "faux-model";

export type FauxChiliScriptEventType =
  | "text_delta"
  | "reasoning_delta"
  | "tool_call_start"
  | "tool_call_delta"
  | "tool_call_end"
  | "finish"
  | "error";

export type FauxChiliScriptEvent = Extract<ModelStreamEvent, { type: FauxChiliScriptEventType }>;

export interface FauxChiliDelayStep {
  readonly type: "delay";
  readonly ms: number;
}

export type FauxChiliScriptStep = FauxChiliScriptEvent | FauxChiliDelayStep;

export interface FauxChiliModelOptions {
  provider?: string;
  model?: string;
  script?: readonly FauxChiliScriptStep[];
}

export interface FauxChiliProviderOptions extends FauxChiliModelOptions {
  id?: string;
  name?: string;
  models?: readonly ModelDescriptor[];
}

const DEFAULT_SCRIPT: readonly FauxChiliScriptStep[] = [{ type: "finish", reason: "stop" }];

export class FauxChiliModel implements ChiliModel {
  readonly provider: string;
  readonly model: string;
  private readonly script: readonly FauxChiliScriptStep[];
  private readonly streamInputs: ModelStreamInput[] = [];

  constructor(options: FauxChiliModelOptions = {}) {
    this.provider = options.provider ?? FAUX_CHILI_PROVIDER_ID;
    this.model = options.model ?? FAUX_CHILI_MODEL_ID;
    this.script = [...(options.script ?? DEFAULT_SCRIPT)];
  }

  get calls(): readonly ModelStreamInput[] {
    return this.streamInputs;
  }

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    this.streamInputs.push(input);

    for (const step of this.script) {
      throwIfAborted(input.signal);

      if (step.type === "delay") {
        await delay(step.ms, input.signal);
        continue;
      }

      yield step;
    }

    throwIfAborted(input.signal);
  }
}

export class FauxChiliProvider implements ChiliModelProvider {
  readonly id: string;
  readonly name: string;
  private readonly script: readonly FauxChiliScriptStep[];
  private readonly descriptors: readonly ModelDescriptor[];

  constructor(options: FauxChiliProviderOptions = {}) {
    this.id = options.id ?? options.provider ?? FAUX_CHILI_PROVIDER_ID;
    this.name = options.name ?? FAUX_CHILI_PROVIDER_NAME;
    this.script = [...(options.script ?? DEFAULT_SCRIPT)];
    this.descriptors = options.models?.map(copyDescriptor) ?? [
      defaultDescriptor(this.id, options.model ?? FAUX_CHILI_MODEL_ID),
    ];
  }

  models(): readonly ModelDescriptor[] {
    return this.descriptors.map(copyDescriptor);
  }

  getModel(model?: string): ChiliModel {
    return new FauxChiliModel({
      provider: this.id,
      model: model ?? this.defaultModel(),
      script: this.script,
    });
  }

  private defaultModel(): string {
    return (
      this.descriptors.find((descriptor) => descriptor.default)?.model ??
      this.descriptors[0]?.model ??
      FAUX_CHILI_MODEL_ID
    );
  }
}

export function createFauxChiliModel(options: FauxChiliModelOptions = {}): FauxChiliModel {
  return new FauxChiliModel(options);
}

export function createFauxChiliProvider(options: FauxChiliProviderOptions = {}): FauxChiliProvider {
  return new FauxChiliProvider(options);
}

function defaultDescriptor(provider: string, model: string): ModelDescriptor {
  return {
    provider,
    model,
    displayName: model,
    apiFamily: "faux",
    default: true,
    capabilities: {
      streaming: true,
      reasoning: true,
      toolCalls: true,
      toolCallDeltas: true,
    },
    inputCapabilities: ["text"],
  };
}

function copyDescriptor(descriptor: ModelDescriptor): ModelDescriptor {
  const copy: ModelDescriptor = { ...descriptor };
  if (descriptor.capabilities) copy.capabilities = { ...descriptor.capabilities };
  if (descriptor.inputCapabilities) copy.inputCapabilities = [...descriptor.inputCapabilities];
  return copy;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
