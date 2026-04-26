import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "@chili/core";
import { createMiniMaxM27HighspeedRouter } from "@chili/core";
import { FakeModelRouter } from "./fake-model.js";

export type CliModelName = "fake" | "minimax" | "legacy-minimax";

interface MiniMaxRouterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
}

type CliModelOptions = MiniMaxRouterOptions;

type MiniMaxRouterFactory = (options?: MiniMaxRouterOptions) => ModelRouter | Promise<ModelRouter>;
type ProviderMiniMaxFactory = (options?: MiniMaxRouterOptions) => ProviderModelOrProvider | Promise<ProviderModelOrProvider>;

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
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimaxi.com/anthropic";
const DEFAULT_MINIMAX_MODEL = "MiniMax-M2.7-highspeed";
const DEFAULT_MAX_TOKENS = 4096;

export async function createCliModel(name: CliModelName, options: CliModelOptions = {}): Promise<ModelRouter> {
  if (name === "fake") return new FakeModelRouter();
  const miniMaxOptions = readMiniMaxOptionsFromEnv(options);
  if (name === "legacy-minimax") return createMiniMaxM27HighspeedRouter(miniMaxOptions);
  return createProvidersMiniMaxRouter(miniMaxOptions);
}

async function createProvidersMiniMaxRouter(options: MiniMaxRouterOptions): Promise<ModelRouter> {
  const providers = await loadProvidersModule();
  const createRouter = resolveMiniMaxFactory(providers);
  const modelOrProvider = await createRouter(options);
  return toModelRouter(modelOrProvider, options.model);
}

async function loadProvidersModule(): Promise<Record<string, unknown>> {
  try {
    return (await import(PROVIDERS_PACKAGE_NAME)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      [
        "Unable to load @chili/providers for --model minimax.",
        "Use --model legacy-minimax to temporarily use the old @chili/core router,",
        "or --model fake for local smoke tests until the providers package is merged.",
      ].join(" "),
      { cause: error },
    );
  }
}

function resolveMiniMaxFactory(providers: Record<string, unknown>): ProviderMiniMaxFactory {
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
  return factory as ProviderMiniMaxFactory;
}

function toModelRouter(modelOrProvider: ProviderModelOrProvider, modelName?: string): ModelRouter {
  if (isProviderModelProvider(modelOrProvider)) {
    return new ProviderModelRouterAdapter(modelOrProvider.getModel(modelName));
  }
  if (isProviderModel(modelOrProvider)) return new ProviderModelRouterAdapter(modelOrProvider);
  throw new Error("@chili/providers MiniMax factory did not return a model or provider-compatible object");
}

function readMiniMaxOptionsFromEnv(input: CliModelOptions): MiniMaxRouterOptions {
  const options: MiniMaxRouterOptions = { maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS };
  const apiKey = process.env.MINIMAX_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const baseUrl =
    process.env.MINIMAX_BASE_URL ??
    process.env.MINIMAX_ANTHROPIC_BASE_URL ??
    process.env.ANTHROPIC_BASE_URL ??
    DEFAULT_MINIMAX_BASE_URL;
  const model = process.env.MINIMAX_MODEL ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MINIMAX_MODEL;
  const resolvedApiKey = input.apiKey ?? apiKey;
  const resolvedBaseUrl = input.baseUrl ?? baseUrl;
  const resolvedModel = input.model ?? model;

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
        yield event as ModelStreamEvent;
      }
    }
  }
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
