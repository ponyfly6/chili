import { AsyncLocalStorage } from "node:async_hooks";
import { Client, type RequestOptions } from "@modelcontextprotocol/client";
import type { McpInteractionOptions } from "./client.js";

/** Bind embedded input to its originating request, including concurrent calls. */
export class InteractiveMcpSdkClient extends Client {
  private readonly interaction = new AsyncLocalStorage<McpInteractionOptions>();

  installElicitationHandler(): void {
    this.setRequestHandler("elicitation/create", async (request, context) => {
      const handler = this.interaction.getStore()?.elicitation;
      if (!handler) throw new Error("MCP input requires an active session with a user-input handler.");
      context.mcpReq.signal.throwIfAborted();
      return handler(request.params, context.mcpReq.signal);
    });
  }

  protected override _resolveNonCompleteResult(
    decoded: Parameters<Client["_resolveNonCompleteResult"]>[0],
    flow: Parameters<Client["_resolveNonCompleteResult"]>[1],
  ): Promise<unknown> {
    const options = (flow.options as (RequestOptions & { chiliInteraction?: McpInteractionOptions }) | undefined)?.chiliInteraction;
    return this.interaction.run(options ?? {}, () => super._resolveNonCompleteResult(decoded, {
      ...flow,
      retry: async (params, legOptions) => {
        legOptions.signal?.throwIfAborted();
        await options?.beforeRetry?.();
        legOptions.signal?.throwIfAborted();
        return flow.retry(params, legOptions);
      },
    }));
  }
}
