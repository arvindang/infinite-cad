// Exact exports (STEP solids, DXF outlines of flat faces), loaded only when someone asks for one:
// OpenCascade (~23 MB of WASM) never touches the main viewer bundle or the Worker. Builds the tree
// with manifold for placements, rebuilds it exactly, checks the two agree, and returns the file.
// In: { seq, doc, format, select? }. Out: { seq, file, ms, note? } with the buffer transferred, or { seq, error }.
import Module from "manifold-3d";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { build } from "../src/geometry.ts";
import { buildBrep, outlinesFor, refPlanes, stepOf } from "../src/brep.ts";
import { dxfOf, layoutOutlines } from "../src/dxf.ts";
import type { CadDoc } from "../src/schema.ts";

/** select: the viewer's selected refs (DXF only): flat faces pick the plane, parts pick the part. */
export type StepRequest = { seq: number; doc: CadDoc; format: "step" | "dxf"; select?: string[] };
export type StepReply = { seq: number; file: ArrayBuffer; ms: number; note?: string } | { seq: number; error: string };

const manifold = Module({ locateFile: () => "/js/manifold.wasm" }).then((w) => (w.setup(), w));
const occt = opencascade({ locateFile: () => "/js/replicad_single.wasm" }).then((oc) => setOC(oc));
const MAX_DRIFT = 0.03; // exact vs faceted volume; more than this means the two builds disagree

self.onmessage = async (e: MessageEvent<StepRequest>) => {
  const { seq, doc, format, select = [] } = e.data;
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
      let file: ArrayBuffer, note: string | undefined;
      if (format === "dxf") {
        const outlines = outlinesFor(parts, select, refPlanes(doc, built));
        if (!outlines.length) throw new Error("no flat face to outline");
        file = new TextEncoder().encode(dxfOf(layoutOutlines(outlines.map((o) => ({ name: o.part, entities: o.entities }))))).buffer as ArrayBuffer;
        note = outlines.length === 1 ? `outline of ${outlines[0].part}` : `${outlines.length} outlines, one layer per part`;
      } else file = await stepOf(parts).arrayBuffer();
      self.postMessage({ seq, file, ms: Math.round(performance.now() - t0), note } satisfies StepReply, { transfer: [file] });
    } finally {
      dispose();
    }
  } catch (err) {
    self.postMessage({ seq, error: err instanceof Error ? err.message : String(err) } satisfies StepReply);
  }
};
