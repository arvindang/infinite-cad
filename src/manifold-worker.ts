// manifold-3d for workerd (Cloudflare Workers). The WASM is bundled by wrangler as a compiled
// WebAssembly.Module and handed to emscripten through instantiateWasm, so nothing is fetched.
import Module from "manifold-3d";
import wasm from "manifold-3d/manifold.wasm";
import type { ManifoldToplevel } from "manifold-3d/manifold";

let ready: Promise<ManifoldToplevel> | undefined;

/** Loads once per isolate. Safe to call on every request. */
export function loadManifold(): Promise<ManifoldToplevel> {
  if (ready) return ready;
  // With nodejs_compat, process.versions.node exists and the emscripten loader takes its Node
  // path (createRequire(import.meta.url) throws in workerd). ENVIRONMENT_IS_NODE is computed in
  // the synchronous part of Module(), so hide process only for that call.
  const g = globalThis as { process?: unknown };
  const saved = g.process;
  g.process = undefined;
  try {
    ready = Module({
      instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
        const instance = new WebAssembly.Instance(wasm, imports);
        done(instance, wasm);
        return instance.exports;
      },
    } as never).then((w: ManifoldToplevel) => {
      w.setup();
      return w;
    });
  } finally {
    g.process = saved;
  }
  ready.catch(() => { ready = undefined; }); // retry on the next call
  return ready;
}
