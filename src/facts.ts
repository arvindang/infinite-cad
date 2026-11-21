// Geometry facts for `resolve`: what a face / feature / part ref means in the built result.
// Pure functions over BuildResult (typed arrays + source), no WASM: runs wherever the mesh is.

import type { BodyMesh, BuildResult } from "./geometry.ts";
import { apply, localFaceFrame } from "./geometry.ts";
import type { FactChange, FactsSnapshot } from "./collab.ts";
import { type CadDoc, type Feature, type Vec3, defaultOp, formatRef, instanceCount, parseRef, planarRoles, rolesOf } from "./schema.ts";

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const rv = (v: number[]) => v.map(r3) as Vec3;

interface RefStats {
  ref: string;
  body: string;
  triangles: number;
  area: number;
  centroid: Vec3;
  normalSum: Vec3;
  min: Vec3;
  max: Vec3;
  verts: Set<number>;
  patches: number;
  adjacent: Map<string, number>; // ref -> shared edge length
  backside: boolean;
}

export interface FactIndex {
  byRef: Map<string, RefStats>;
}

/** One pass over every body: per-ref area, centroid, normal, bbox, patches and edge adjacency. */
export function indexFacts(res: BuildResult): FactIndex {
  const byRef = new Map<string, RefStats>();
  for (const b of res.bodies) indexBody(b, byRef);
  return { byRef };
}

function indexBody(b: BodyMesh, byRef: Map<string, RefStats>) {
  const P = b.positions, T = b.triVerts, n = b.triRef.length;
  // Weld by position so adjacency doesn't depend on Manifold's vertex sharing.
  const weld = new Map<string, number>();
  const wid = new Uint32Array(P.length / 3);
  for (let v = 0; v < wid.length; v++) {
    const k = `${Math.round(P[3 * v] * 1e4)},${Math.round(P[3 * v + 1] * 1e4)},${Math.round(P[3 * v + 2] * 1e4)}`;
    let id = weld.get(k);
    if (id == null) { id = weld.size; weld.set(k, id); }
    wid[v] = id;
  }
  const stats = b.refs.map((ref): RefStats => ({
    ref, body: b.bodyId, triangles: 0, area: 0, centroid: [0, 0, 0], normalSum: [0, 0, 0],
    min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], verts: new Set(), patches: 0, adjacent: new Map(), backside: false,
  }));
  const edges = new Map<number, number[]>(); // welded edge -> triangles
  const nw = weld.size;
  for (let t = 0; t < n; t++) {
    const s = stats[b.triRef[t]];
    const ia = T[3 * t], ib = T[3 * t + 1], ic = T[3 * t + 2];
    const A: Vec3 = [P[3 * ia], P[3 * ia + 1], P[3 * ia + 2]], B: Vec3 = [P[3 * ib], P[3 * ib + 1], P[3 * ib + 2]], C: Vec3 = [P[3 * ic], P[3 * ic + 1], P[3 * ic + 2]];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const cr: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const area = Math.hypot(...cr) / 2;
    s.triangles++;
    s.area += area;
    for (let k = 0; k < 3; k++) {
      s.centroid[k] += (area * (A[k] + B[k] + C[k])) / 3;
      s.normalSum[k] += cr[k] / 2;
      s.min[k] = Math.min(s.min[k], A[k], B[k], C[k]);
      s.max[k] = Math.max(s.max[k], A[k], B[k], C[k]);
    }
    if (b.backside[t]) s.backside = true;
    const w = [wid[ia], wid[ib], wid[ic]];
    for (const x of w) s.verts.add(x);
    for (let k = 0; k < 3; k++) {
      const a = w[k], c = w[(k + 1) % 3];
      const key = Math.min(a, c) * nw + Math.max(a, c);
      const list = edges.get(key);
      if (list) list.push(t); else edges.set(key, [t]);
    }
  }
  // Adjacency between refs, and connected patches within a ref (union-find over shared edges).
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const wpos = new Float64Array(nw * 3);
  for (let v = 0; v < wid.length; v++) for (let k = 0; k < 3; k++) wpos[wid[v] * 3 + k] = P[3 * v + k];
  for (const [key, tris] of edges) {
    if (tris.length < 2) continue;
    const a = Math.floor(key / nw), c = key % nw;
    const len = Math.hypot(wpos[3 * a] - wpos[3 * c], wpos[3 * a + 1] - wpos[3 * c + 1], wpos[3 * a + 2] - wpos[3 * c + 2]);
    const [t0, t1] = tris;
    const r0 = b.triRef[t0], r1 = b.triRef[t1];
    if (r0 === r1) parent[find(t0)] = find(t1);
    else {
      const s0 = stats[r0], s1 = stats[r1];
      s0.adjacent.set(s1.ref, (s0.adjacent.get(s1.ref) ?? 0) + len);
      s1.adjacent.set(s0.ref, (s1.adjacent.get(s0.ref) ?? 0) + len);
    }
  }
  const roots = stats.map(() => new Set<number>());
  for (let t = 0; t < n; t++) roots[b.triRef[t]].add(find(t));
  stats.forEach((s, i) => {
    s.patches = roots[i].size;
    s.centroid = s.centroid.map((c) => c / (s.area || 1)) as Vec3;
    byRef.set(s.ref, s);
  });
}

// ---------- dependencies (from source, not geometry) ----------

function atTarget(f: Feature): string | undefined {
  return f.at ? parseRef(f.at)?.id : undefined;
}

export function dependencies(doc: CadDoc, id: string) {
  const all = doc.parts.flatMap((p) => p.features);
  const byId = new Map(all.map((f) => [f.id, f]));
  const dependsOn: string[] = [];
  for (let cur = byId.get(id); cur && atTarget(cur); cur = byId.get(atTarget(cur)!)) dependsOn.push(cur.at!);
  const dependents: string[] = [];
  const walk = (target: string) => {
    for (const f of all) if (atTarget(f) === target && !dependents.includes(f.id)) { dependents.push(f.id); walk(f.id); }
  };
  walk(id);
  return { dependsOn, dependents };
}

// ---------- resolve ----------

export type Resolved =
  | { ref: string; kind: "unknown"; message: string }
  | ({ ref: string; kind: "face" } & Record<string, unknown>)
  | ({ ref: string; kind: "feature" } & Record<string, unknown>)
  | ({ ref: string; kind: "part" } & Record<string, unknown>);

function faceSurface(f: Feature, role: string): string {
  if (planarRoles(f).includes(role) || role === "cap") return "plane";
  if (f.type === "cylinder" || f.type === "hole") return f.type === "cylinder" && f.diameterTop != null && f.diameterTop !== f.diameter ? "cone" : "cylinder";
  if (f.type === "sphere") return "sphere";
  if (f.type === "revolve") {
    // A profile edge sweeps a disk/annulus (horizontal), cylinder (vertical) or cone (slanted).
    const i = rolesOf(f).indexOf(role);
    if (i < 0 || i >= f.points.length) return "plane"; // start/end caps
    const a = f.points[i], b = f.points[(i + 1) % f.points.length];
    return Math.abs(a[1] - b[1]) < 1e-9 ? "plane" : Math.abs(a[0] - b[0]) < 1e-9 ? "cylinder" : "cone";
  }
  return "plane";
}

export function resolve(doc: CadDoc, res: BuildResult, facts: FactIndex, refStr: string): Resolved {
  const r = parseRef(refStr);
  if (!r) return { ref: refStr, kind: "unknown", message: `"${refStr}" is not a ref (expected part, feature, feature.role or feature:n.role)` };

  const part = doc.parts.find((p) => p.id === r.id);
  if (part) {
    const s = res.parts[part.id];
    const faces = [...facts.byRef.values()].filter((x) => x.body === part.id);
    return {
      ref: refStr, kind: "part", exists: !!s && s.volume > 0,
      volume: s && r3(s.volume), surfaceArea: s && r3(s.surfaceArea),
      bbox: s?.bbox && { min: rv(s.bbox.min), max: rv(s.bbox.max) },
      size: s?.bbox && rv(s.bbox.max.map((v, i) => v - s.bbox!.min[i])),
      genus: s?.genus, components: s?.components, triangles: s?.triangles,
      features: part.features.map((f) => f.id), faces: faces.length,
    };
  }

  const fb = res.features[r.id];
  if (!fb) return { ref: refStr, kind: "unknown", message: `no part or feature "${r.id}"` };
  const f = fb.feature;
  const multi = fb.instances.length > 1;
  if (r.instance && r.instance > fb.instances.length) return { ref: refStr, kind: "unknown", message: `"${r.id}" has ${fb.instances.length} instance(s)` };
  const { dependsOn, dependents } = dependencies(doc, f.id);
  const source = f;

  if (!r.role) {
    // Feature (or one pattern instance).
    const prefixes = r.instance ? [formatRef(f.id, r.instance)] : multi ? fb.instances.map((i) => i.ref) : [f.id];
    const designed = res.designedRefs.filter((d) => prefixes.some((p) => d.startsWith(p + ".")));
    const present = designed.map((d) => facts.byRef.get(d)).filter((x): x is RefStats => !!x);
    const touches = new Set<string>();
    for (const s of present) for (const a of s.adjacent.keys()) { const id = parseRef(a)!.id; if (id !== f.id) touches.add(id); }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const s of present) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], s.min[k]); max[k] = Math.max(max[k], s.max[k]); }
    return {
      ref: refStr, kind: "feature", type: f.type, part: fb.partId, op: fb.op,
      status: fb.error ? "error" : present.length === 0 ? "consumed" : "present",
      error: fb.error, instances: fb.instances.length,
      faces: designed.map((d) => ({ ref: d, present: facts.byRef.has(d), area: r3(facts.byRef.get(d)?.area ?? 0) })),
      bbox: present.length ? { min: rv(min), max: rv(max) } : null,
      dependsOn, dependents, touches: [...touches], source,
    };
  }

  // Face.
  const inst = fb.instances[(r.instance ?? 1) - 1];
  const faceRef = formatRef(f.id, multi ? (r.instance ?? undefined) : undefined, r.role);
  if (multi && !r.instance) return { ref: refStr, kind: "unknown", message: `"${f.id}" has ${fb.instances.length} instances; use ${f.id}:1.${r.role} … ${f.id}:${fb.instances.length}.${r.role}` };
  if (!res.designedRefs.includes(faceRef)) return { ref: refStr, kind: "unknown", message: `${f.type} "${f.id}" has no face "${r.role}"` };
  const s = facts.byRef.get(faceRef);
  const surface = faceSurface(f, r.role);
  // Designed geometry (from params): the face frame, or the axis for round faces.
  let design: Record<string, unknown> | undefined;
  const lf = inst && localFaceFrame(f, r.role, inst.holeDepth);
  if (lf && inst) {
    const m = inst.matrix as number[];
    const flip = fb.op === "subtract" ? -1 : 1;
    design = {
      origin: rv(apply(m, [lf[12], lf[13], lf[14]])),
      normal: rv(apply(m, [lf[8] * flip, lf[9] * flip, lf[10] * flip], 0)),
      u: rv(apply(m, [lf[0], lf[1], lf[2]], 0)),
    };
  } else if (inst && (f.type === "cylinder" || f.type === "hole")) {
    const m = inst.matrix as number[];
    design = { axisOrigin: rv(apply(m, [0, 0, 0])), axis: rv(apply(m, [0, 0, 1], 0)), diameter: f.diameter, depth: inst.holeDepth };
  }
  if (!s) {
    return { ref: refStr, kind: "face", exists: false, status: fb.error ? "error" : "consumed", part: fb.partId, feature: f.id, role: r.role, surface, design, dependsOn, dependents, source };
  }
  const nl = Math.hypot(...s.normalSum);
  const flatness = nl / (s.area || 1); // 1 = perfectly planar, ~0 = closed/round
  const out: Record<string, unknown> = {
    ref: refStr, kind: "face", exists: true, status: "present", part: fb.partId, feature: f.id, role: r.role,
    surface, fromCut: s.backside, area: r3(s.area), centroid: rv(s.centroid),
    normal: flatness > 0.2 ? rv(s.normalSum.map((c) => c / nl)) : null, flatness: r3(flatness),
    bbox: { min: rv(s.min), max: rv(s.max) }, size: rv(s.max.map((v, i) => v - s.min[i])),
    patches: s.patches, triangles: s.triangles,
    adjacent: [...s.adjacent.entries()].sort((a, b) => b[1] - a[1]).map(([ref, len]) => ({ ref, edgeLength: r3(len) })),
    design, dependsOn, dependents, source,
  };
  if (surface === "plane" && flatness > 0.999) out.planeOffset = r3(dot3(s.normalSum.map((c) => c / nl) as Vec3, s.centroid));
  return out as Resolved;
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------- snapshots (comment anchors) ----------

type Box = { min: Vec3; max: Vec3 } | null | undefined;

/** The measured facts of a resolved ref, small enough to keep with a comment. Null for an unknown ref. */
export function snapshotFacts(r: Resolved): FactsSnapshot | null {
  const x = r as Record<string, any>;
  const keep = (o: FactsSnapshot): FactsSnapshot => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as FactsSnapshot;
  if (r.kind === "unknown") return null;
  if (r.kind === "part") {
    return keep({
      kind: "part", source: "kernel", presence: x.exists ? "present" : "consumed",
      volume: x.volume, surfaceArea: x.surfaceArea, genus: x.genus, bbox: (x.bbox as Box) ?? null, size: x.size ?? undefined,
    });
  }
  if (r.kind === "feature") {
    const faces = x.faces as { present: boolean }[];
    return keep({
      kind: "feature", source: "kernel", presence: x.status, type: x.type, part: x.part, op: x.op, instances: x.instances,
      facesPresent: `${faces.filter((f) => f.present).length}/${faces.length}`, bbox: (x.bbox as Box) ?? null,
    });
  }
  return keep({
    kind: "face", source: "kernel", presence: x.status, part: x.part, surface: x.surface,
    area: x.area, centroid: x.centroid, normal: x.normal, planeOffset: x.planeOffset, bbox: x.bbox, size: x.size,
  });
}

/** What can be said about a ref from the source alone, when the kernel can't run. Null if it isn't in the tree. */
export function sourceSnapshot(doc: CadDoc, ref: string): FactsSnapshot | null {
  const r = parseRef(ref);
  if (!r) return null;
  if (doc.parts.some((p) => p.id === r.id)) return { kind: "part", source: "none" };
  for (const p of doc.parts) {
    const i = p.features.findIndex((f) => f.id === r.id);
    if (i < 0) continue;
    const f = p.features[i];
    return { kind: r.role ? "face" : "feature", source: "none", type: f.type, part: p.id, op: defaultOp(f, i), instances: instanceCount(f.pattern) };
  }
  return null;
}

const TOL = 1e-3;
function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= TOL * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

/** Fields that differ between two snapshots (numbers within 1e-3 relative count as equal). With different sources, only fields both have. */
export function compareFacts(then: FactsSnapshot, now: FactsSnapshot): FactChange[] {
  const t = then as unknown as Record<string, unknown>, n = now as unknown as Record<string, unknown>;
  const both = then.source === now.source;
  const keys = [...new Set([...Object.keys(t), ...Object.keys(n)])].filter((k) => k !== "source" && (both || (k in t && k in n)));
  return keys.filter((k) => !same(t[k], n[k])).map((k) => ({ field: k, then: t[k] ?? null, now: n[k] ?? null }));
}
