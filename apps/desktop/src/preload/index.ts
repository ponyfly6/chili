import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  DESKTOP_EVENT_ACK_CHANNEL,
  DESKTOP_EVENT_CHANNEL,
  DESKTOP_EVENT_READY_CHANNEL,
  DESKTOP_INVOKE_CHANNEL,
  parseDesktopEventReady,
  parseDesktopRequest,
  parseDesktopInvokeResponse,
  type ChiliDesktopApi,
  type DesktopEventEnvelope,
  type DesktopRequest,
  type DesktopResponse,
} from "../shared/contracts.js";
import { DesktopEventReadyLifecycle, DesktopEventStreamReceiver } from "./event-stream-receiver.js";

const listeners = new Set<(event: DesktopEventEnvelope) => void>();
const receiver = new DesktopEventStreamReceiver({
  deliver: (envelope) => {
    if (listeners.size === 0) return false;
    for (const listener of listeners) listener(envelope);
    return true;
  },
  acknowledge: (ack) => ipcRenderer.send(DESKTOP_EVENT_ACK_CHANNEL, ack),
  onError: (error) => console.error("Rejected desktop event", error),
});
const readyLifecycle = new DesktopEventReadyLifecycle({
  invokeReady: async () => parseDesktopEventReady(await ipcRenderer.invoke(DESKTOP_EVENT_READY_CHANNEL)),
  setStream: (streamId) => receiver.setStream(streamId),
  resetStream: () => receiver.reset(),
  onError: (error) => console.error("Desktop event stream failed to start", error),
});

ipcRenderer.on(DESKTOP_EVENT_CHANNEL, (_event: IpcRendererEvent, value: unknown) => receiver.accept(value));

const api: ChiliDesktopApi = Object.freeze({
  async invoke<Request extends DesktopRequest>(value: Request): Promise<DesktopResponse<Request>> {
    const request = parseDesktopRequest(value) as Request;
    const response: unknown = await ipcRenderer.invoke(DESKTOP_INVOKE_CHANNEL, request);
    return parseDesktopInvokeResponse(request, response);
  },
  subscribe(listener: Parameters<ChiliDesktopApi["subscribe"]>[0]) {
    if (typeof listener !== "function") throw new TypeError("Desktop event listener must be a function");
    const wasEmpty = listeners.size === 0;
    listeners.add(listener);
    if (wasEmpty) readyLifecycle.activate();
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (listeners.size === 0) readyLifecycle.deactivate();
    };
  },
});

contextBridge.exposeInMainWorld("chiliDesktop", api);
