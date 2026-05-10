import type { Message } from "@chili/protocol";
import type { ModelInputCapability, ModelStreamInput } from "./types.js";

export interface ImageInputSupportOptions {
  provider?: string;
  model: string;
  inputCapabilities?: readonly ModelInputCapability[] | undefined;
}

export function messagesContainDirectImageInput(messages: readonly Message[]): boolean {
  return messages.some((message) =>
    message.parts.some((part) => part.type === "image"),
  );
}

export function assertImageInputSupported(
  input: ModelStreamInput,
  options: ImageInputSupportOptions,
): void {
  if (!messagesContainDirectImageInput(input.messages)) return;
  if (options.inputCapabilities === undefined || options.inputCapabilities.includes("image")) return;

  const modelLabel = [options.provider, options.model].filter(Boolean).join("/");
  throw new Error(
    `${modelLabel} does not support image input. Switch to an image-capable model before sending images.`,
  );
}
