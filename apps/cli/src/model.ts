import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import { createMiniMaxM27HighspeedRouter } from "@chili/core";
import {
  DEEPSEEK_OPENAI_BASE_URL,
  DEEPSEEK_V4_PRO_MODEL,
  findKnownModel,
  MINIMAX_ANTHROPIC_BASE_URL,
  MINIMAX_M27_HIGHSPEED_MODEL,
  readDeepSeekEnvironment,
  readMiniMaxEnvironment,
} from "@chili/providers";
import { FakeModelRouter } from "./fake-model.js";

export type CliModelName = "fake" | "minimax" | "deepseek" | "legacy-minimax";

interface ProviderRouterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
}

type CliModelOptions = ProviderRouterOptions;

type ProviderRouterFactory = (options?: ProviderRouterOptions) => ProviderModelOrProvider | Promise<ProviderModelOrProvider>;

interface ProviderModel {
  stream(input: ProviderModelStreamInput): AsyncIterable<ProviderModelStreamEvent>;
}

interface ProviderModelProvider {
  getModel(model?: string): ProviderModel;
}

interface ProviderModelStreamInput {
  messages: ModelStreamInput["messages"];
  tools?: ModelStreamInput["tools"];
  system?: readonly string[];
  maxTokens?: number;
  signal?: AbortSignal;
}

type ProviderModelOrProvider = ProviderModel | ProviderModelProvider;

type ProviderModelStreamEvent =
  | ModelStreamEvent
  | { type: "metadata"; [key: string]: unknown }
  | { type: "reasoning_delta"; [key: string]: unknown }
  | { type: "tool_call_start"; [key: string]: unknown }
  | { type: "tool_call_delta"; [key: string]: unknown }
  | { type: "tool_call_end"; name: string; input: unknown; [key: string]: unknown };

const PROVIDERS_PACKAGE_NAME = "@chili/providers";
const DEFAULT_MAX_TOKENS = 4096;

export async function createCliModel(name: CliModelName, options: CliModelOptions = {}): Promise<ModelRouter> {
  if (name === "fake") return new FakeModelRouter();
  if (name === "deepseek") return createProvidersDeepSeekRouter(readDeepSeekOptionsFromEnv(options));
  const miniMaxOptions = readMiniMaxOptionsFromEnv(options);
  if (name === "legacy-minimax") return createMiniMaxM27HighspeedRouter(miniMaxOptions);
  return createProvidersMiniMaxRouter(miniMaxOptions);
}

async function createProvidersMiniMaxRouter(options: ProviderRouterOptions): Promise<ModelRouter> {
  const providers = await loadProvidersModule("minimax");
  const createRouter = resolveMiniMaxFactory(providers);
  const modelOrProvider = await createRouter(options);
  return toModelRouter(modelOrProvider, options.model, "MiniMax");
}

async function createProvidersDeepSeekRouter(options: ProviderRouterOptions): Promise<ModelRouter> {
  const providers = await loadProvidersModule("deepseek");
  const createRouter = resolveDeepSeekFactory(providers);
  const modelOrProvider = await createRouter(options);
  return toModelRouter(modelOrProvider, options.model, "DeepSeek");
}

async function loadProvidersModule(providerName: "minimax" | "deepseek"): Promise<Record<string, unknown>> {
  try {
    return (await import(PROVIDERS_PACKAGE_NAME)) as Record<string, unknown>;
  } catch (error) {
    const fallback = providerName === "minimax" ? " Use --model legacy-minimax to temporarily use the old @chili/core router," : "";
    throw new Error(
      [
        `Unable to load @chili/providers for --model ${providerName}.`,
        fallback,
        "or --model fake for local smoke tests until the providers package is merged.",
      ]
        .filter(Boolean)
        .join(" "),
      { cause: error },
    );
  }
}

function resolveMiniMaxFactory(providers: Record<string, unknown>): ProviderRouterFactory {
  const defaultExport = providers.default;
  const defaultObject = isRecord(defaultExport) ? defaultExport : {};
  const candidates = [
    providers.createMiniMaxRouter,
    providers.createMiniMaxM27HighspeedRouter,
    providers.createMiniMaxM27HighspeedModel,
    providers.createMiniMaxProvider,
    providers.createMiniMaxProviderRouter,
    defaultObject.createMiniMaxRouter,
    defaultObject.createMiniMaxM27HighspeedModel,
    typeof defaultExport === "function" ? defaultExport : undefined,
  ];
  const factory = candidates.find((candidate) => typeof candidate === "function");
  if (!factory) {
    throw new Error(
      "@chili/providers must export createMiniMaxRouter(options) or another compatible MiniMax router factory",
    );
  }
  return factory as ProviderRouterFactory;
}

function resolveDeepSeekFactory(providers: Record<string, unknown>): ProviderRouterFactory {
  const defaultExport = providers.default;
  const defaultObject = isRecord(defaultExport) ? defaultExport : {};
  const candidates = [
    providers.createDeepSeekRouter,
    providers.createDeepSeekV4Model,
    providers.createDeepSeekProvider,
    defaultObject.createDeepSeekRouter,
    defaultObject.createDeepSeekV4Model,
    defaultObject.createDeepSeekProvider,
    typeof defaultExport === "function" ? defaultExport : undefined,
  ];
  const factory = candidates.find((candidate) => typeof candidate === "function");
  if (!factory) {
    throw new Error("@chili/providers must export createDeepSeekRouter(options) or another compatible DeepSeek factory");
  }
  return factory as ProviderRouterFactory;
}

function toModelRouter(modelOrProvider: ProviderModelOrProvider, modelName: string | undefined, providerName: string): ModelRouter {
  if (isProviderModelProvider(modelOrProvider)) {
    return new ProviderModelRouterAdapter(modelOrProvider.getModel(modelName));
  }
  if (isProviderModel(modelOrProvider)) return new ProviderModelRouterAdapter(modelOrProvider);
  throw new Error(`@chili/providers ${providerName} factory did not return a model or provider-compatible object`);
}

function readMiniMaxOptionsFromEnv(input: CliModelOptions): ProviderRouterOptions {
  const options: ProviderRouterOptions = { maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS };
  const env = readMiniMaxEnvironment();
  const resolvedApiKey = input.apiKey ?? env.apiKey;
  const resolvedBaseUrl = input.baseUrl ?? env.baseUrl ?? MINIMAX_ANTHROPIC_BASE_URL;
  const resolvedModel = input.model ?? env.model ?? MINIMAX_M27_HIGHSPEED_MODEL;

  if (resolvedApiKey) options.apiKey = resolvedApiKey;
  if (resolvedBaseUrl) options.baseUrl = resolvedBaseUrl;
  if (resolvedModel) options.model = resolvedModel;
  if (input.fetch) options.fetch = input.fetch;
  return options;
}

function readDeepSeekOptionsFromEnv(input: CliModelOptions): ProviderRouterOptions {
  const options: ProviderRouterOptions = { maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS };
  const env = readDeepSeekEnvironment();
  const resolvedApiKey = input.apiKey ?? env.apiKey;
  const resolvedBaseUrl = input.baseUrl ?? env.baseUrl ?? DEEPSEEK_OPENAI_BASE_URL;
  const resolvedModel = input.model ?? env.model ?? DEEPSEEK_V4_PRO_MODEL;

  if (resolvedApiKey) options.apiKey = resolvedApiKey;
  if (resolvedBaseUrl) options.baseUrl = resolvedBaseUrl;
  if (resolvedModel) options.model = resolvedModel;
  if (input.fetch) options.fetch = input.fetch;
  return options;
}

function isProviderModel(value: unknown): value is ProviderModel {
  return isRecord(value) && typeof value.stream === "function";
}

function isProviderModelProvider(value: unknown): value is ProviderModelProvider {
  return isRecord(value) && typeof value.getModel === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class ProviderModelRouterAdapter implements ModelRouter {
  constructor(private readonly model: ProviderModel) {}

  async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
    for await (const event of this.model.stream(toProviderInput(input))) {
      if (isModelStreamEvent(event)) {
        yield enrichMetadata(event as ModelStreamEvent);
      }
    }
  }
}

function enrichMetadata(event: ModelStreamEvent): ModelStreamEvent {
  if (event.type !== "metadata" || !event.provider || !event.model) return event;
  const descriptor = findKnownModel(event.provider, event.model);
  if (!descriptor) return event;

  const output: Extract<ModelStreamEvent, { type: "metadata" }> = { ...event };
  if (output.contextWindowTokens === undefined && descriptor.contextWindowTokens !== undefined) {
    output.contextWindowTokens = descriptor.contextWindowTokens;
  }
  if (output.maxOutputTokens === undefined && descriptor.maxOutputTokens !== undefined) {
    output.maxOutputTokens = descriptor.maxOutputTokens;
  }
  return output;
}

function isModelStreamEvent(event: ProviderModelStreamEvent): boolean {
  return (
    event.type === "metadata" ||
    event.type === "text_delta" ||
    event.type === "reasoning_delta" ||
    event.type === "tool_call_start" ||
    event.type === "tool_call_delta" ||
    event.type === "tool_call_end" ||
    event.type === "tool_call" ||
    event.type === "finish" ||
    event.type === "error"
  );
}

function toProviderInput(input: ModelStreamInput): ProviderModelStreamInput {
  const providerInput: ProviderModelStreamInput = {
    messages: input.messages,
    tools: input.tools,
    system: input.system,
  };
  if (input.signal) providerInput.signal = input.signal;
  return providerInput;
}
