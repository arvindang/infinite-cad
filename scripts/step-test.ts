// Exact STEP export: rebuilds models with OpenCascade, checks them against the mesh build, writes
// STEP and reads it back. Run: node scripts/step-test.ts   (exits 1 on any failure)
import Module from "manifold-3d";
import opencascade from "replicad-opencascadejs";
import { importSTEP, measureVolume, setOC, type Shape3D } from "replicad";
import { build } from "../src/geometry.ts";
import { buildBrep, outlineOf, outlinesFor, refPlanes, stepOf } from "../src/brep.ts";
import { bounds, dxfOf, layoutOutlines, type DxfEntity } from "../src/dxf.ts";
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
    {
      id: "plate",
      features: [
        { id: "slab", type: "extrude", points: [[-30, -15], [30, -15], [30, 15], [-30, 15]], arcs: [null, 15, null, 15], height: 5 },
        { id: "slot", type: "extrude", op: "subtract", points: [[-10, -3], [10, -3], [10, 3], [-10, 3]], arcs: [null, 3, null, 3], height: 7, at: "slab.top", position: [0, 0, -6] },
        { id: "notch", type: "extrude", points: [[-8, 0], [8, 0], [8, 10], [-8, 10]], arcs: [null, null, -8], height: 4, at: "slab.top" },
      ],
    },
    { id: "bead", features: [{ id: "ring", type: "revolve", points: [[5, 0], [10, 0], [10, 6], [5, 6]], arcs: [null, 4] }] },
  ],
};

const built = build(w, doc);
check("mesh build is clean", built.ok, built.errors);
const t0 = Date.now();
const { parts, dispose } = buildBrep(doc, built);
const ms = Date.now() - t0;
check("every part rebuilt", parts.length === 5, parts.map((p) => p.id));
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
check("STEP has arcs as circles and a torus", text.includes("CIRCLE") && text.includes("TOROIDAL_SURFACE"));

const back = (await importSTEP(step)) as Shape3D;
const total = parts.reduce((s, p) => s + p.volume, 0);
// curved-on-curved intersections (sphere through holes and a cone rim) are written as splines, so allow a hair
check("STEP reads back with the same volume", Math.abs(measureVolume(back) - total) / total < 1e-3, { back: measureVolume(back), total });
const kinds: Record<string, number> = {};
for (const f of back.faces) kinds[f.geomType] = (kinds[f.geomType] ?? 0) + 1;
check("bore holes come back as cylinders", (kinds.CYLINDRE ?? 0) >= 4 + 1 + 1 + 6, kinds);
console.log(`  ${parts.length} parts in ${ms} ms, STEP ${(step.size / 1024).toFixed(1)} KB, faces ${JSON.stringify(kinds)}`);

// ---- DXF: flat-face outlines from the exact solids
const part = (id: string) => parts.find((p) => p.id === id)!;
const count = (es: DxfEntity[], kind: DxfEntity["kind"]) => es.filter((e) => e.kind === kind).length;
const radii = (es: DxfEntity[]) => [...new Set(es.flatMap((e) => (e.kind === "arc" || e.kind === "circle" ? [+e.r.toFixed(6)] : [])))].sort((a, b) => a - b);
const size = (es: DxfEntity[]) => { const b = bounds(es); return [+(b.max[0] - b.min[0]).toFixed(6), +(b.max[1] - b.min[1]).toFixed(6)]; };

const plate = outlineOf(part("plate"))!;
check("plate: default is its largest flat face (the bottom)", plate.plane.normal[2] < -0.999, plate.plane);
check("plate: slab and slot come out as 4 lines and 4 true arcs", count(plate.entities, "line") === 4 && count(plate.entities, "arc") === 4 && count(plate.entities, "poly") === 0, plate.entities.map((e) => e.kind));
check("plate: arc radii 3 and 15", radii(plate.entities).join() === "3,15", radii(plate.entities));
check("plate: 90 x 30 mm", size(plate.entities).join() === "90,30", size(plate.entities));

const bracket = outlineOf(part("bracket"))!;
check("bracket: base bottom with the 4 mount holes as circles", count(bracket.entities, "circle") === 4 && radii(bracket.entities).join() === "2.5" && size(bracket.entities).join() === "80,40", { kinds: bracket.entities.map((e) => e.kind), size: size(bracket.entities) });

const faceOf = refPlanes(doc, built);
const picked = outlinesFor(parts, ["boss.top", "notch.top", "knob"], faceOf);
check("selected refs pick their faces and parts", picked.map((o) => o.part).join() === "bracket,plate,knob", picked.map((o) => o.part));
const boss = picked[0];
check("boss.top: ring of the boss and its bore", count(boss.entities, "circle") === 2 && radii(boss.entities).join() === "4,8" && Math.abs(boss.plane.offset - 16) < 1e-6, { r: radii(boss.entities), plane: boss.plane });
const notch = picked[1];
const bite = notch.entities.find((e) => e.kind === "arc") as Extract<DxfEntity, { kind: "arc" }> | undefined;
const nb = bounds(notch.entities);
check("notch.top: seen from above, not mirrored (the bite is at +Y)", !!bite && Math.abs(bite.c[1] - nb.max[1]) < 1e-6 && Math.abs(bite.r - 8) < 1e-6, { bite, nb });
check("a face that isn't flat is skipped for its part's default", outlinesFor(parts, ["cap.surface"], faceOf)[0]?.part === "knob");

const dxf = dxfOf(layoutOutlines([plate, bracket].map((o) => ({ name: o.part, entities: o.entities }))));
const pairs = dxf.trimEnd().split("\r\n");
const codes: [string, string][] = [];
for (let i = 0; i + 1 < pairs.length; i += 2) codes.push([pairs[i].trim(), pairs[i + 1]]);
const has = (c: string, v: string) => codes.some(([a, b]) => a === c && b === v);
const after = (name: string) => { const i = codes.findIndex(([a, b]) => a === "9" && b === name); return codes[i + 1]; };
check("DXF: even group pairs ending in EOF", pairs.length % 2 === 0 && codes.at(-1)?.join() === "0,EOF");
check("DXF: R12 in millimetres", after("$ACADVER")?.[1] === "AC1009" && after("$INSUNITS")?.join() === "70,4");
check("DXF: one layer per part, every entity on a declared layer", has("2", "plate") && has("2", "bracket") && codes.filter(([a]) => a === "8").every(([, b]) => b === "plate" || b === "bracket"));
check("DXF: arcs and circles, no polylines", codes.filter(([a, b]) => a === "0" && b === "ARC").length === 4 && codes.filter(([a, b]) => a === "0" && b === "CIRCLE").length === 4 && !has("0", "POLYLINE"));
const xs = codes.filter(([a]) => a === "10").map(([, b]) => Number(b));
check("DXF: parts laid out side by side from the origin", Math.min(...xs) >= -1e-9 && Math.max(...xs) > 90 + 10, { min: Math.min(...xs), max: Math.max(...xs) });
console.log(`  DXF ${(dxf.length / 1024).toFixed(1)} KB, ${codes.filter(([a]) => a === "0").length - 1} records`);
dispose();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
