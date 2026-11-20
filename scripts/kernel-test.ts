// Kernel tests: validate, applyOps, diff, build provenance, resolve facts, determinism.
// Run: node scripts/kernel-test.ts   (exits 1 on any failure)
import Module from "manifold-3d";
import { build, type BuildResult } from "../src/geometry.ts";
import { indexFacts, resolve } from "../src/facts.ts";
import { emptyDoc, schemaDoc, validate, parseRef, type CadDoc } from "../src/schema.ts";
import { allIds, applyOps, canonical, diff, didYouMean, findFeature, type EditOp } from "../src/tree.ts";

let passed = 0, failed = 0;
function check(name: string, cond: unknown, detail?: unknown) {
  if (cond) passed++;
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}
const section = (s: string) => console.log(`\n# ${s}`);

const fixture: CadDoc = {
  units: "mm",
  parts: [
    {
      id: "bracket",
      features: [
        { id: "base", type: "box", size: [80, 40, 6] },
        { id: "mount-holes", type: "hole", diameter: 5, at: "base.top", position: [-30, -12, 0], pattern: { grid: { count: [2, 2], step: [60, 24] } } },
        { id: "boss", type: "cylinder", diameter: 16, height: 10, at: "base.top" },
        { id: "boss-bore", type: "hole", diameter: 8, depth: 12, at: "boss.top" },
        { id: "slots", type: "box", op: "subtract", size: [4, 10, 20], center: true, at: "base.top", position: [-15, 0, 0], pattern: { linear: { count: 2, step: [30, 0, 0] } } },
      ],
    },
    { id: "lid", features: [{ id: "lid-plate", type: "box", size: [80, 40, 3], position: [0, 0, 30] }] },
  ],
};

const w = await Module();
w.setup();

// ---------------------------------------------------------------- schema
section("schema");
check("fixture validates", validate(fixture).length === 0, validate(fixture));
check("emptyDoc validates and builds", validate(emptyDoc()).length === 0 && build(w, emptyDoc()).bodies.length === 0);
check("schemaDoc <= 1.5 KB", schemaDoc().length <= 1536, schemaDoc().length);
check("parseRef instance+role", JSON.stringify(parseRef("mount-holes:2.wall")) === JSON.stringify({ id: "mount-holes", instance: 2, role: "wall" }));
check("parseRef rejects junk", parseRef("Base.Top") === null && parseRef("a:0.top") === null && parseRef("a..b") === null);

const bad = {
  parts: [{
    id: "p",
    features: [
      { id: "base", type: "box", size: [10, 10, -1] },
      { id: "base", type: "cylinder", diameter: 5, height: 2 },
      { id: "Hole_1", type: "hole", diameter: 3, at: "base.topp" },
      { id: "h2", type: "hole", diameter: 3, at: "later.top" },
      { id: "h3", type: "hole", diameter: 3, at: "h2.wall" },
      { id: "pegs", type: "cylinder", diameter: 2, height: 2, pattern: { linear: { count: 3, step: [5, 0, 0] } } },
      { id: "h4", type: "hole", diameter: 1, at: "pegs.top" },
      { id: "later", type: "box", size: [1, 1, 1], op: "glue" },
      { id: "tri", type: "extrude", height: 2, points: [[0, 0], [1, 1], [2, 2]] },
      { id: "x", type: "torus" },
    ],
  }],
} as unknown as CadDoc;
const codes = validate(bad).map((i) => i.code);
for (const c of ["bad_param", "duplicate_id", "bad_id", "unknown_role", "unknown_ref", "not_planar", "ambiguous_ref", "bad_op", "unknown_type"])
  check(`validate reports ${c}`, codes.includes(c as never), codes);
for (const i of validate(bad)) console.log(`  ${i.code.padEnd(14)} ${i.path.padEnd(28)} ${i.message}`);

// ---------------------------------------------------------------- tree
section("tree");
check("allIds", JSON.stringify(allIds(fixture)) === JSON.stringify(["bracket", "lid", "base", "mount-holes", "boss", "boss-bore", "slots", "lid-plate"]), allIds(fixture));
check("findFeature", findFeature(fixture, "boss")?.part.id === "bracket" && findFeature(fixture, "boss")?.index === 2 && !findFeature(fixture, "nope"));
check("canonical key order", canonical({ size: [1, 2, 3], type: "box", id: "a", at: undefined }) === '{"id":"a","type":"box","size":[1,2,3]}', canonical({ size: [1, 2, 3], type: "box", id: "a" }));
check("canonical stable across key order", canonical(JSON.parse(JSON.stringify(fixture))) === canonical(structuredClone(fixture)));
check("didYouMean typo", didYouMean(fixture, "mount-hole")[0] === "mount-holes" && didYouMean(fixture, "bos").includes("boss"), didYouMean(fixture, "mount-hole"));
check("didYouMean nothing close", didYouMean(fixture, "zzzzzzzz").length === 0);

const ok = (ops: EditOp[]) => {
  const r = applyOps(fixture, ops);
  if (!r.ok) console.log("  unexpected issues:", r.issues.map((i) => i.message));
  return r;
};

// update: merge patch, only that feature changes
let r = ok([{ op: "update", id: "mount-holes", set: { diameter: 3.2 } }]);
check("update ok", r.ok);
if (r.ok) {
  check("update changed only mount-holes", JSON.stringify(r.changed) === '["mount-holes"]', r.changed);
  const others = allIds(fixture).filter((id) => id !== "mount-holes" && findFeature(fixture, id));
  check("update leaves other features byte-identical", others.every((id) => canonical(findFeature(fixture, id)!.feature) === canonical(findFeature(r.ok ? r.doc : fixture, id)!.feature)));
  check("update kept other fields", (findFeature(r.doc, "mount-holes")!.feature as { pattern?: unknown }).pattern !== undefined);
  check("input doc not mutated", (findFeature(fixture, "mount-holes")!.feature as { diameter: number }).diameter === 5);
}
r = ok([{ op: "update", id: "slots", set: { pattern: null, note: "one slot" } }]);
check("update null deletes a field", r.ok && !("pattern" in findFeature(r.doc, "slots")!.feature) && findFeature(r.doc, "slots")!.feature.note === "one slot");

// replace: may change type
r = ok([{ op: "replace", id: "boss", feature: { id: "boss", type: "box", size: [16, 16, 10], at: "base.top" } }]);
check("replace changes type", r.ok && findFeature(r.doc, "boss")!.feature.type === "box" && JSON.stringify(r.changed) === '["boss"]');

// add: default part is ambiguous with two parts; part / after work
let rf = applyOps(fixture, [{ op: "add", feature: { id: "rib", type: "box", size: [2, 30, 8], at: "base.top" } }]);
check("add without part fails when several parts", !rf.ok && rf.issues[0].message.startsWith('op 0 (add "rib"): the model has 2 parts'), !rf.ok && rf.issues);
r = ok([{ op: "add", feature: { id: "rib", type: "box", size: [2, 30, 8], at: "base.top" }, part: "bracket" }]);
check("add to part appends", r.ok && findFeature(r.doc, "rib")!.index === 5 && JSON.stringify(r.changed) === '["rib"]');
r = ok([{ op: "add", feature: { id: "rib", type: "box", size: [2, 30, 8], at: "base.top" }, after: "base" }]);
check("add after inserts", r.ok && findFeature(r.doc, "rib")!.index === 1);
const single: CadDoc = { units: "mm", parts: [fixture.parts[0]] };
const rs = applyOps(single, [{ op: "add", feature: { id: "rib", type: "box", size: [2, 30, 8], at: "base.top" } }]);
check("add defaults to the only part", rs.ok && findFeature(rs.doc, "rib")?.part.id === "bracket");

// add_part
r = ok([{ op: "add_part", part: { id: "spacer", features: [{ id: "spacer-ring", type: "cylinder", diameter: 10, height: 4 }] } }]);
check("add_part", r.ok && r.doc.parts.length === 3 && r.changed.includes("spacer") && r.changed.includes("spacer-ring"), r.ok && r.changed);
const fromEmpty = applyOps(emptyDoc(), [{ op: "add_part", part: { id: "p", features: [{ id: "b", type: "box", size: [1, 1, 1] }] } }]);
check("add_part on empty doc", fromEmpty.ok);

// remove: feature and part
r = ok([{ op: "remove", id: "boss-bore" }]);
check("remove feature", r.ok && !findFeature(r.doc, "boss-bore") && JSON.stringify(r.removed) === '["boss-bore"]' && r.changed.length === 0);
r = ok([{ op: "remove", id: "lid" }]);
check("remove part removes its features", r.ok && r.doc.parts.length === 1 && r.removed.includes("lid") && r.removed.includes("lid-plate"), r.ok && r.removed);
rf = applyOps(fixture, [{ op: "remove", id: "base" }]);
check("remove base fails (others are placed on it)", !rf.ok && rf.issues.some((i) => i.message.startsWith('op 0 (remove "base"): "mount-holes" is placed on base.top')), !rf.ok && rf.issues.map((i) => i.message));
r = ok([{ op: "remove", id: "boss-bore" }, { op: "remove", id: "boss" }]);
check("remove dependent then referent in one edit", r.ok);

// rename: feature (rewrites at, keeps instance/role), part, chains collapse
r = ok([{ op: "rename", id: "base", to: "plate" }]);
check("rename feature ok", r.ok);
if (r.ok) {
  check("rename rewrites every at", ["mount-holes", "boss", "slots"].every((id) => findFeature(r.ok ? r.doc : fixture, id)!.feature.at === "plate.top"));
  check("rename result", JSON.stringify(r.renames) === '{"base":"plate"}' && r.removed.length === 0 && r.changed.includes("plate") && r.changed.includes("boss"), r);
}
const inst: CadDoc = structuredClone(fixture);
inst.parts[0].features.push({ id: "pin", type: "cylinder", diameter: 2, height: 3, at: "mount-holes:2.wall" } as never);
inst.parts[0].features[1] = { ...inst.parts[0].features[1], depth: 4 } as never;
inst.parts[0].features[5] = { ...inst.parts[0].features[5], at: "mount-holes:2.floor" } as never;
r = applyOps(inst, [{ op: "rename", id: "mount-holes", to: "holes" }]);
check("rename keeps instance and role", r.ok && findFeature(r.doc, "pin")!.feature.at === "holes:2.floor", r.ok ? findFeature(r.doc, "pin")!.feature.at : r.issues);
r = ok([{ op: "rename", id: "bracket", to: "mount" }]);
check("rename part", r.ok && r.doc.parts[0].id === "mount" && r.renames.bracket === "mount");
r = ok([{ op: "rename", id: "boss", to: "post" }, { op: "rename", id: "post", to: "pillar" }]);
check("rename chain collapses", r.ok && JSON.stringify(r.renames) === '{"boss":"pillar"}' && findFeature(r.doc, "boss-bore")!.feature.at === "pillar.top", r.ok && r.renames);
rf = applyOps(fixture, [{ op: "rename", id: "boss", to: "base" }]);
check("rename to used id fails", !rf.ok && rf.issues[0].message === 'op 0 (rename "boss"): id "base" is already used');

// atomic failure, op-indexed messages, did-you-mean
rf = applyOps(fixture, [
  { op: "update", id: "boss", set: { diameter: 20 } },
  { op: "update", id: "mount-hole", set: { diameter: 3 } },
  { op: "update", id: "boss", set: { id: "x" } },
  { op: "frobnicate" } as never,
]);
check("failed edit returns every op issue", !rf.ok && rf.issues.length === 3, !rf.ok && rf.issues);
if (!rf.ok) {
  check("op 1 message with did-you-mean", rf.issues[0].message === 'op 1 (update "mount-hole"): no feature "mount-hole" (did you mean "mount-holes"?)', rf.issues[0].message);
  check("op 2 can't change id", rf.issues[1].message.startsWith('op 2 (update "boss"): set can\'t change id or type'));
  check("op 3 unknown op", rf.issues[2].message.startsWith("op 3 (frobnicate): unknown op"));
}
rf = applyOps(fixture, [{ op: "update", id: "base", set: { size: [80, 40] } }, { op: "update", id: "boss", set: { at: "base.side" } }]);
check("validation issues attributed to ops", !rf.ok && rf.issues.some((i) => i.message.startsWith('op 0 (update "base"): box "base": size')) && rf.issues.some((i) => i.message.startsWith('op 1 (update "boss"): cylinder "boss": at "base.side"')), !rf.ok && rf.issues.map((i) => i.message));
check("fixture untouched after failures", canonical(fixture) === canonical(structuredClone(fixture)) && findFeature(fixture, "boss")!.feature.type === "cylinder");
if (!rf.ok) for (const i of rf.issues) console.log(`  ${i.message}`);

// diff
const d = diff(fixture, (applyOps(fixture, [{ op: "update", id: "boss", set: { height: 12 } }, { op: "remove", id: "lid" }, { op: "add", feature: { id: "rib", type: "box", size: [1, 1, 1] }, part: "bracket" }]) as { doc: CadDoc }).doc);
check("diff", JSON.stringify(d) === '{"added":["rib"],"changed":["boss"],"removed":["lid","lid-plate"]}', d);

// ---------------------------------------------------------------- build + provenance
section("build");
function counts(res: BuildResult, body: string) {
  const b = res.bodies.find((x) => x.bodyId === body)!;
  const m = new Map<string, number>();
  for (const t of b.triRef) m.set(b.refs[t], (m.get(b.refs[t]) ?? 0) + 1);
  return m;
}
const res = build(w, fixture);
check("build ok", res.ok && res.errors.length === 0, res.errors);
check("two bodies", res.bodies.map((b) => b.bodyId).join() === "bracket,lid");
const bc = counts(res, "bracket");
console.log(`  bracket: ${res.bodies[0].triRef.length} tris; ` + [...bc].sort().map(([k, v]) => `${k}=${v}`).join(" "));
for (const ref of ["base.top", "base.bottom", "mount-holes:1.wall", "mount-holes:4.wall", "boss.side", "boss.top", "boss-bore.wall", "boss-bore.floor", "slots:2.left"])
  check(`ref present: ${ref}`, (bc.get(ref) ?? 0) > 0);
check("boss.bottom consumed by union", !bc.has("boss.bottom"));
check("every triangle has a known ref", res.bodies.every((b) => b.refs.every((r) => !r.startsWith("?"))));
check("triVerts and indices are the same array", res.bodies[0].triVerts === res.bodies[0].indices && res.bodies[0].triVerts.length === res.bodies[0].triRef.length * 3);
const bb = res.bodies[0];
check("hole walls flagged backside", bb.triRef.every((t, i) => !bb.refs[t].includes(".wall") || bb.backside[i] === 1));
check("genus counts through holes (4 mount + 2 slots)", res.parts.bracket.genus === 6, res.parts.bracket.genus);
const res2 = build(w, fixture);
check("rebuild deterministic", res2.bodies[0].triRef.length === bb.triRef.length && res2.bodies[0].triRef.every((v, i) => res2.bodies[0].refs[v] === bb.refs[bb.triRef[i]]));
const grown = applyOps(fixture, [{ op: "update", id: "base", set: { size: [120, 50, 8] } }]);
const res3 = grown.ok ? build(w, grown.doc) : res;
check("resize keeps ref set", JSON.stringify([...counts(res3, "bracket").keys()].sort()) === JSON.stringify([...bc.keys()].sort()));

// ---------------------------------------------------------------- resolve
section("resolve");
const facts = indexFacts(res);
const R = (ref: string) => resolve(fixture, res, facts, ref) as Record<string, any>;
const hole = R("mount-holes:2.wall");
console.log("  mount-holes:2.wall", JSON.stringify({ ...hole, source: undefined }));
check("face facts", hole.kind === "face" && hole.exists && hole.surface === "cylinder" && hole.fromCut && Math.abs(hole.area - 94.18) < 0.1 && hole.patches === 1);
check("face adjacency", hole.adjacent.map((a: { ref: string }) => a.ref).sort().join() === "base.bottom,base.top");
check("face design + deps", hole.design.diameter === 5 && hole.dependsOn[0] === "base.top");
const top = R("base.top");
check("plane facts", top.normal.join() === "0,0,1" && top.planeOffset === 6 && top.design.origin.join() === "0,0,6");
check("dependents transitive", ["mount-holes", "boss", "boss-bore", "slots"].every((id) => top.dependents.includes(id)), top.dependents);
check("consumed face", R("boss.bottom").exists === false && R("boss.bottom").status === "consumed");
const boss = R("boss");
check("feature facts", boss.kind === "feature" && boss.status === "present" && boss.touches.includes("base") && boss.dependents.includes("boss-bore"), boss);
const part = R("bracket");
check("part facts", part.kind === "part" && part.genus === 6 && part.components === 1 && part.size.join() === "80,40,16", part);
check("unknown role", R("base.topp").kind === "unknown");
check("instance required", R("slots.left").kind === "unknown" && /slots:1.left/.test(R("slots.left").message));
check("lid part", R("lid").kind === "part" && R("lid-plate.top").exists === true);

// ---------------------------------------------------------------- other primitives
section("other primitives");
const enclosure: CadDoc = {
  parts: [
    {
      id: "case",
      features: [
        { id: "shell", type: "extrude", height: 30, points: [[0, 0], [60, 0], [60, 40], [0, 40]], edges: ["front", "right", "back", "left"] },
        { id: "cavity", type: "box", op: "subtract", size: [56, 36, 30], at: "shell.top", position: [0, 0, -28] },
        { id: "port", type: "hole", diameter: 8, at: "shell.front" },
        { id: "vents", type: "hole", diameter: 3, at: "shell.bottom", position: [-15, -10, 0], pattern: { grid: { count: [4, 3], step: [10, 10] } } },
        { id: "round", type: "sphere", diameter: 74, op: "intersect", position: [30, 20, 15] },
      ],
    },
    {
      id: "knob",
      features: [
        { id: "knob-body", type: "revolve", points: [[0, 0], [10, 0], [10, 8], [6, 14], [0, 14]], edges: ["base", "skirt", "taper", "crown", "axis"] },
        { id: "grips", type: "box", op: "subtract", size: [2, 4, 10], position: [10, 0, 0], pattern: { circular: { count: 8 } } },
      ],
    },
  ],
};
const e = build(w, enclosure);
const ef = indexFacts(e);
const E = (ref: string) => resolve(enclosure, e, ef, ref) as Record<string, any>;
check("enclosure builds", e.ok, e.errors);
check("extrude named edge", E("shell.front").normal?.join() === "0,-1,0");
check("through port cuts both walls (2 patches)", E("port.wall").patches === 2);
check("grid instance 12", E("vents:12.wall").exists);
check("intersect face present", E("round.surface").exists && E("round.surface").surface === "sphere");
check("revolve roles", E("knob-body.crown").surface === "plane" && E("knob-body.taper").surface === "cone" && E("knob-body.skirt").surface === "cylinder");
check("circular pattern instance", E("grips:8.left").exists);
const empty = build(w, { parts: [{ id: "nothing", features: [{ id: "a", type: "box", size: [10, 10, 10] }, { id: "b", type: "box", size: [5, 5, 5], op: "intersect", position: [50, 0, 0] }] }] });
check("empty part reported", !empty.ok && /is empty/.test(empty.errors[0]?.message ?? ""), empty.errors);

// ---------------------------------------------------------------- perf
section("perf");
for (const [nx, ny] of [[4, 4], [10, 10], [15, 15]]) {
  const doc: CadDoc = { parts: [{ id: "plate", features: [
    { id: "base", type: "box", size: [nx * 10 + 10, ny * 10 + 10, 4] },
    { id: "holes", type: "hole", diameter: 4, at: "base.top", position: [-(nx - 1) * 5, -(ny - 1) * 5, 0], pattern: { grid: { count: [nx, ny], step: [10, 10] } } },
  ] }] };
  const t = performance.now(); const b = build(w, doc); const t1 = performance.now(); indexFacts(b); const t2 = performance.now();
  console.log(`  ${nx * ny} holes: ${b.bodies[0]?.triRef.length} tris, build ${(t1 - t).toFixed(0)} ms, facts ${(t2 - t1).toFixed(0)} ms`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
