import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";

export function responsesFixtureUserText(body: unknown): string {
  assert.ok(body && typeof body === "object" && "input" in body && Array.isArray(body.input));
  const latest = body.input.findLast((item: unknown) => item && typeof item === "object" && "role" in item && item.role === "user") as { content?: unknown } | undefined;
  assert.ok(latest, "Responses fixture requires a user input");
  if (typeof latest.content === "string") return latest.content;
  assert.ok(Array.isArray(latest.content), "Responses fixture requires user content");
  return latest.content.flatMap((part: unknown) => part && typeof part === "object" && "type" in part
    && part.type === "input_text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("");
}

/** Incomplete responses deliberately stay open until the tested runtime cancels them. */
export function writeResponsesFixtureText(response: ServerResponse, id: string, text: string, complete: boolean): () => void {
  begin(response, id);
  const itemId = `${id}_message`;
  event(response, { type: "response.output_item.added", output_index: 0,
    item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] } });
  event(response, { type: "response.output_text.delta", output_index: 0, item_id: itemId, content_index: 0, delta: text });
  const completeResponse = (): void => {
    assert.ok(!response.destroyed && !response.writableEnded, "The fixture stream must still be active");
    event(response, { type: "response.output_text.done", output_index: 0, item_id: itemId, content_index: 0, text });
    finish(response, id, { id: itemId, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }] });
  };
  if (complete) completeResponse();
  return completeResponse;
}

export function writeResponsesFixtureTool(response: ServerResponse, id: string, name: string, input: Record<string, unknown>): void {
  begin(response, id);
  const item = { id: `${id}_function`, type: "function_call", call_id: `${id}-${name}`, name,
    arguments: JSON.stringify(input), status: "completed" };
  event(response, { type: "response.output_item.added", output_index: 0,
    item: { ...item, arguments: "", status: "in_progress" } });
  event(response, { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments });
  finish(response, id, item);
}

function begin(response: ServerResponse, id: string): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  event(response, { type: "response.created", response: { id, model: "deepseek-v4-pro", status: "in_progress", output: [] } });
}

function finish(response: ServerResponse, id: string, item: Record<string, unknown>): void {
  event(response, { type: "response.output_item.done", output_index: 0, item });
  event(response, { type: "response.completed", response: { id, model: "deepseek-v4-pro", status: "completed", output: [item],
    usage: { input_tokens: 8, output_tokens: 8, total_tokens: 16 } } });
  response.end();
}

function event(response: ServerResponse, payload: Record<string, unknown>): void {
  response.write(`event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`);
}
