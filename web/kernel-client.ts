// A second kernel worker for compare: builds any tree off the main thread, one promise per build.
// Created on first use; terminate() frees its manifold instance (phones feel a second one).
import type { CadDoc } from "../src/schema.ts";
import type { BuildReply, BuildRequest } from "./kernel-worker";

export interface KernelClient {
  build(doc: CadDoc): Promise<BuildReply>;
  terminate(): void;
}

export function kernelClient(): KernelClient {
  let worker: Worker | null = null;
  let seq = 0;
  const waiting = new Map<number, { resolve: (r: BuildReply) => void; reject: (e: Error) => void }>();
  const fail = (err: Error) => {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  function start(): Worker {
    const w = new Worker("/js/kernel-worker.js", { type: "module" });
    w.addEventListener("message", (e: MessageEvent<BuildReply>) => {
      const job = waiting.get(e.data.seq);
      if (!job) return;
      waiting.delete(e.data.seq);
      job.resolve(e.data);
    });
    w.addEventListener("error", (e) => {
      fail(new Error(e.message || "Couldn't load the geometry kernel"));
      w.terminate();
      if (worker === w) worker = null;
    });
    return w;
  }
  return {
    build(doc) {
      worker ??= start();
      const s = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(s, { resolve, reject });
        worker!.postMessage({ seq: s, doc } satisfies BuildRequest);
      });
    },
    terminate() {
      worker?.terminate();
      worker = null;
      fail(new Error("stopped"));
    },
  };
}
