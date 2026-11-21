// Exact STEP export, loaded only when someone asks for STEP: OpenCascade (~23 MB of WASM) never
// touches the main viewer bundle or the Worker. Builds the tree with manifold for placements,
// rebuilds it exactly, checks the two agree, and returns the file.
// In: { seq, doc }. Out: { seq, step } with the buffer transferred, or { seq, error }.
import Module from "manifold-3d";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { build } from "../src/geometry.ts";
import { buildBrep, stepOf } from "../src/brep.ts";
import type { CadDoc } from "../src/schema.ts";

export type StepRequest = { seq: number; doc: CadDoc };
export type StepReply = { seq: number; step: ArrayBuffer; ms: number } | { seq: number; error: string };

const manifold = Module({ locateFile: () => "/js/manifold.wasm" }).then((w) => (w.setup(), w));
const occt = opencascade({ locateFile: () => "/js/replicad_single.wasm" }).then((oc) => setOC(oc));
const MAX_DRIFT = 0.03; // exact vs faceted volume; more than this means the two builds disagree

self.onmessage = async (e: MessageEvent<StepRequest>) => {
  const { seq, doc } = e.data;
  try {
    const [w] = await Promise.all([manifold, occt]);
    const t0 = performance.now();
    const built = build(w, doc);
    const { parts, dispose } = buildBrep(doc, built);
    try {
      if (!parts.length) throw new Error("nothing to export");
      for (const p of parts) {
        const drift = Math.abs(p.volume - p.meshVolume) / Math.max(p.meshVolume, 1e-9);
        if (drift > MAX_DRIFT) throw new Error(`"${p.id}" came out ${(drift * 100).toFixed(1)}% off the mesh`);
      }
      const step = await stepOf(parts).arrayBuffer();
      self.postMessage({ seq, step, ms: Math.round(performance.now() - t0) } satisfies StepReply, { transfer: [step] });
    } finally {
      dispose();
    }
  } catch (err) {
    self.postMessage({ seq, error: err instanceof Error ? err.message : String(err) } satisfies StepReply);
  }
};
