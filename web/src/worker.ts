import type { Cv, WorkerReply, WorkerRequest } from "./types.ts";
import { errorMessage, resultTransfers } from "./types.ts";
import { analyze } from "./matcher.ts";

type CvModule = Cv & { onRuntimeInitialized?: () => void; onAbort?: (message: string) => void };
declare const cv: CvModule | Promise<Cv>;

function send(message: WorkerReply, transfers: ArrayBuffer[] = []): void {
  self.postMessage(message, transfers);
}

async function initialize(): Promise<{ cv: Cv }> {
  self.importScripts("./opencv.js");
  const module = cv;
  if (module instanceof Promise) return module.then((runtime) => ({ cv: runtime }));
  // OpenCV 4.x is a self-resolving thenable; never await the module itself.
  return new Promise((resolve, reject) => {
    module.onAbort = (message) => reject(new Error(`OpenCV 初始化失败：${message}`));
    if (module.Mat) resolve({ cv: module });
    else module.onRuntimeInitialized = () => resolve({ cv: module });
  });
}

initialize().then(({ cv: runtime }) => {
  self.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;
    try {
      const result = analyze(runtime, request.input, (text, value) => {
        send({ type: "progress", id: request.id, text, value });
      });
      send({ type: "result", id: request.id, result }, resultTransfers(result));
    } catch (error) {
      send({ type: "error", id: request.id, message: errorMessage(error), fatal: false });
    }
  };
  send({ type: "ready" });
}).catch((error: unknown) => {
  send({ type: "error", id: null, message: errorMessage(error), fatal: true });
});
