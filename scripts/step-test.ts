// Exact STEP export: rebuilds models with OpenCascade, checks them against the mesh build, writes
// STEP and reads it back. Run: node scripts/step-test.ts   (exits 1 on any failure)
import Module from "manifold-3d";
import opencascade from "replicad-opencascadejs";
import { importSTEP, measureVolume, setOC, type Shape3D } from "replicad";
import { build } from "../src/geometry.ts";
import { buildBrep, stepOf } from "../src/brep.ts";
import type { CadDoc } from "../src/schema.ts";

let passed = 0, failed = 0;
function check(name: string, cond: unknown, detail?: unknown) {
  if (cond) passed++;
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`); }
}

const w = await Module();
w.setup();
setOC(await opencascade());

const doc: CadDoc = {
  units: "mm",
  parts: [
    {
      id: "bracket", name: "Wall bracket",
      features: [
        { id: "base", type: "box", size: [80, 40, 6] },
        { id: "mount-holes", type: "hole", diameter: 5, at: "base.top", position: [-30, -12, 0], pattern: { grid: { count: [2, 2], step: [60, 24] } } },
        { id: "boss", type: "cylinder", diameter: 16, height: 10, at: "base.top" },
        { id: "boss-bore", type: "hole", diameter: 8, depth: 12, at: "boss.top" },
        { id: "rib", type: "extrude", points: [[0, 0], [20, 0], [0, 15]], height: 4, at: "base.top", position: [10, 5, 0], rotation: [0, 0, 30] },
        { id: "side-hole", type: "hole", diameter: 4, at: "base.right" },
      ],
    },
    {
      id: "knob",
      features: [
        { id: "cone", type: "cylinder", diameter: 30, diameterTop: 18, height: 20 },
        { id: "cap", type: "sphere", diameter: 18, position: [0, 0, 20] },
        { id: "grips", type: "hole", diameter: 3, depth: 25, position: [12, 0, 25], pattern: { circular: { count: 6 } } },
        { id: "point", type: "cylinder", diameter: 6, diameterTop: 0, height: 8, at: "cone.bottom" },
      ],
    },
    {
      id: "pulley",
      features: [
        { id: "wheel", type: "revolve", points: [[5, 0], [25, 0], [25, 3], [20, 5], [25, 7], [25, 10], [5, 10]], angle: 270 },
        { id: "clip", type: "box", size: [100, 100, 8], center: true, position: [0, 0, 5], op: "intersect" },
      ],
    },
  ],
};

const built = build(w, doc);
check("mesh build is clean", built.ok, built.errors);
const t0 = Date.now();
const { parts, dispose } = buildBrep(doc, built);
const ms = Date.now() - t0;
check("every part rebuilt", parts.length === 3, parts.map((p) => p.id));
for (const p of parts) {
  const rel = Math.abs(p.volume - p.meshVolume) / p.meshVolume;
  check(`${p.id}: exact volume within 2% of the mesh`, rel < 0.02, { exact: p.volume, mesh: p.meshVolume, rel });
  const mb = built.parts[p.id].bbox!, bb = p.shape.boundingBox.bounds;
  const off = Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(bb[0][k] - mb.min[k]), Math.abs(bb[1][k] - mb.max[k])]));
  check(`${p.id}: bounding box matches the mesh`, off < 0.5, { exact: bb, mesh: mb });
  console.log(`  ${p.id}: ${p.volume.toFixed(2)} mm³ exact vs ${p.meshVolume.toFixed(2)} mesh (${(((p.volume - p.meshVolume) / p.meshVolume) * 100).toFixed(3)}%)`);
}

const step = stepOf(parts);
const text = await step.text();
check("STEP is AP242 in mm", text.includes("AP242") && /SI_UNIT\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/.test(text));
for (const p of parts) check(`STEP names part ${p.id}`, text.includes(`'${p.name}'`));
check("STEP has analytic surfaces", text.includes("CYLINDRICAL_SURFACE") && text.includes("CONICAL_SURFACE") && text.includes("SPHERICAL_SURFACE"));
check("STEP is not faceted", !text.includes("POLY_LOOP"));

const back = (await importSTEP(step)) as Shape3D;
const total = parts.reduce((s, p) => s + p.volume, 0);
// curved-on-curved intersections (sphere through holes and a cone rim) are written as splines, so allow a hair
check("STEP reads back with the same volume", Math.abs(measureVolume(back) - total) / total < 1e-3, { back: measureVolume(back), total });
const kinds: Record<string, number> = {};
for (const f of back.faces) kinds[f.geomType] = (kinds[f.geomType] ?? 0) + 1;
check("bore holes come back as cylinders", (kinds.CYLINDRE ?? 0) >= 4 + 1 + 1 + 6, kinds);
console.log(`  ${parts.length} parts in ${ms} ms, STEP ${(step.size / 1024).toFixed(1)} KB, faces ${JSON.stringify(kinds)}`);
dispose();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
