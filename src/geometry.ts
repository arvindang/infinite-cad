// Builds a CadDoc into per-part triangle meshes where every triangle carries a ref
// ("base.top", "mount-holes:2.wall"). Environment-neutral: the caller passes an initialized
// manifold-3d toplevel (from node, a browser Web Worker or a Cloudflare Worker).
//
// Provenance: each primitive is tessellated by Manifold, every triangle is classified into a
// role, and the role's global ref index is written into MeshGL.faceID. Manifold carries faceID
// through booleans unchanged, so output faceID -> ref. runOriginalID (one per feature instance)
// and runFlags bit 0 (backside: triangle came from a subtracted tool) come along for free.

import type { Manifold, ManifoldToplevel, Mat4 } from "manifold-3d/manifold";
import {
  type CadDoc, type Feature, type Issue, type Pattern, type Vec2, type Vec3,
  defaultOp, formatRef, instanceCount, parseRef, profileAreaCentroid, profileEdgeIndex, profilePolyline, rolesOf, signedArea, validate,
} from "./schema.ts";

export interface BodyMesh {
  bodyId: string;
  positions: Float32Array; // xyz, mm
  triVerts: Uint32Array; // 3 per triangle (vertex indices, CCW from outside)
  indices: Uint32Array; // same array as triVerts (alias kept for early consumers)
  triRef: Uint32Array; // 1 per triangle, index into refs
  refs: string[]; // refs present in this body
  backside: Uint8Array; // 1 per triangle: 1 if it came from a subtracted tool (hole walls)
}

export interface PartStats {
  volume: number;
  surfaceArea: number;
  genus: number;
  components: number;
  bbox: { min: Vec3; max: Vec3 } | null;
  triangles: number;
}

export interface InstanceInfo {
  ref: string; // "base" or "mount-holes:2"
  matrix: Mat4; // local -> world, column-major
  originalID: number;
  holeDepth?: number; // resolved depth for holes (through holes get the computed depth)
}

export interface FeatureBuild {
  feature: Feature;
  partId: string;
  op: "union" | "subtract" | "intersect";
  instances: InstanceInfo[];
  error?: string;
}

export interface BuildResult {
  ok: boolean;
  issues: Issue[]; // validation issues (build is skipped when any exist)
  errors: { featureId: string; message: string }[]; // per-feature kernel errors; the build continues
  bodies: BodyMesh[];
  parts: Record<string, PartStats>;
  features: Record<string, FeatureBuild>;
  /** Every ref the design could produce, present or not (for "consumed" answers). */
  designedRefs: string[];
  ms: number;
}

export interface BuildOptions {
  /** Segments for a full circle. Fixed (not size-dependent) so triangle counts are stable. */
  circularSegments?: number;
}

// ---------- matrix helpers (column-major 4x4, like Manifold's Mat4) ----------

type M4 = number[];
const I4 = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mul(a: M4, b: M4): M4 {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) r[c * 4 + row] += a[k * 4 + row] * b[c * 4 + k];
  return r;
}
const translate = (v: Vec3): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1];
function rotX(d: number): M4 { const c = Math.cos((d * Math.PI) / 180), s = Math.sin((d * Math.PI) / 180); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; }
function rotY(d: number): M4 { const c = Math.cos((d * Math.PI) / 180), s = Math.sin((d * Math.PI) / 180); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; }
function rotZ(d: number): M4 { const c = Math.cos((d * Math.PI) / 180), s = Math.sin((d * Math.PI) / 180); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
const rotXYZ = (r: Vec3): M4 => mul(rotZ(r[2]), mul(rotY(r[1]), rotX(r[0])));
export function apply(m: M4, p: Vec3, w = 1): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] * w,
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] * w,
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] * w,
  ];
}
/** Inverse of a rigid transform (rotation + translation). */
function rigidInverse(m: M4): M4 {
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  const t = apply(r, [m[12], m[13], m[14]]);
  r[12] = -t[0]; r[13] = -t[1]; r[14] = -t[2];
  return r;
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Frame matrix with columns u, v, n and origin o. */
function frame(o: Vec3, n: Vec3, xHint: Vec3 = [1, 0, 0]): M4 {
  n = norm(n);
  let u: Vec3, v: Vec3;
  if (Math.abs(n[2]) > 0.9) { u = norm(sub(xHint, n.map((c) => c * dot(xHint, n)) as Vec3)); v = cross(n, u); }
  else { v = norm(sub([0, 0, 1], n.map((c) => c * n[2]) as Vec3)); u = cross(v, n); }
  return [...u, 0, ...v, 0, ...n, 0, ...o, 1];
}

// ---------- local face frames (analytic, from params, not from the mesh) ----------

export function zBase(f: Feature): number {
  if (f.type === "box") return f.center ? -f.size[2] / 2 : 0;
  if (f.type === "cylinder" || f.type === "extrude") return f.center ? -f.height / 2 : 0;
  return 0;
}

/** Frame of a planar role in the feature's local space, or null if not planar. */
export function localFaceFrame(f: Feature, role: string, holeDepth?: number): M4 | null {
  const z0 = zBase(f);
  switch (f.type) {
    case "box": {
      const [sx, sy, sz] = f.size, zm = z0 + sz / 2;
      const table: Record<string, [Vec3, Vec3]> = {
        top: [[0, 0, z0 + sz], [0, 0, 1]], bottom: [[0, 0, z0], [0, 0, -1]],
        front: [[0, -sy / 2, zm], [0, -1, 0]], back: [[0, sy / 2, zm], [0, 1, 0]],
        left: [[-sx / 2, 0, zm], [-1, 0, 0]], right: [[sx / 2, 0, zm], [1, 0, 0]],
      };
      return table[role] ? frame(...table[role]) : null;
    }
    case "cylinder":
      if (role === "top") return frame([0, 0, z0 + f.height], [0, 0, 1]);
      if (role === "bottom") return frame([0, 0, z0], [0, 0, -1]);
      return null;
    case "extrude": {
      const c = profileAreaCentroid(f.points, f.arcs).centroid;
      if (role === "top") return frame([c[0], c[1], z0 + f.height], [0, 0, 1]);
      if (role === "bottom") return frame([c[0], c[1], z0], [0, 0, -1]);
      const i = profileEdgeIndex(f, role);
      if (i < 0 || f.arcs?.[i]) return null;
      const p0 = f.points[i], p1 = f.points[(i + 1) % f.points.length];
      const d = norm([p1[0] - p0[0], p1[1] - p0[1], 0]);
      const s = Math.sign(signedArea(f.points));
      return frame([(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, z0 + f.height / 2], [d[1] * s, -d[0] * s, 0]);
    }
    case "hole":
      if (role === "floor" && holeDepth != null) return frame([0, 0, -holeDepth], [0, 0, -1]);
      return null;
    default:
      return null;
  }
}

// ---------- tessellation + role tagging ----------

export const HOLE_LIP = 0.01; // hole cylinders start this far above their face to avoid coplanar slivers

function patternMatrices(p?: Pattern): M4[] {
  const n = instanceCount(p);
  const out: M4[] = [];
  for (let i = 0; i < n; i++) {
    if (p?.linear) out.push(translate(p.linear.step.map((s) => s * i) as Vec3));
    else if (p?.grid) {
      const nx = p.grid.count[0];
      out.push(translate([(i % nx) * p.grid.step[0], Math.floor(i / nx) * p.grid.step[1], 0]));
    } else if (p?.circular) {
      const total = p.circular.angle ?? 360;
      const step = total >= 360 ? 360 / n : n > 1 ? total / (n - 1) : 0;
      const c = p.circular.center ?? [0, 0];
      out.push(mul(translate([c[0], c[1], 0]), mul(rotZ(step * i), translate([-c[0], -c[1], 0]))));
    } else out.push(I4());
  }
  return out;
}

function distToSegment2(px: number, py: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}
/** Profile edge nearest to a point, over the profile's polyline (arcs split into chords). */
function nearestEdge(px: number, py: number, line: { points: Vec2[]; edgeOf: number[] }): number {
  const pts = line.points;
  let best = 0, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = distToSegment2(px, py, pts[i], pts[(i + 1) % pts.length]);
    if (d < bd) { bd = d; best = line.edgeOf[i]; }
  }
  return best;
}

/** Returns the untagged local solid and a classifier from (centroid, normal) to role. */
function primitive(w: ManifoldToplevel, f: Feature, seg: number, holeDepth: number): { m: Manifold; role: (c: Vec3, n: Vec3) => string } {
  const { Manifold, CrossSection } = w;
  const z0 = zBase(f);
  const caps = (side: string) => (_: Vec3, n: Vec3) => (n[2] > 0.999 ? "top" : n[2] < -0.999 ? "bottom" : side);
  switch (f.type) {
    case "box":
      return {
        m: Manifold.cube(f.size, true).translate([0, 0, z0 + f.size[2] / 2]),
        role: (_, n) => {
          const a = n.map(Math.abs);
          if (a[2] >= a[0] && a[2] >= a[1]) return n[2] > 0 ? "top" : "bottom";
          if (a[1] >= a[0]) return n[1] > 0 ? "back" : "front";
          return n[0] > 0 ? "right" : "left";
        },
      };
    case "cylinder":
      return {
        m: Manifold.cylinder(f.height, f.diameter / 2, (f.diameterTop ?? f.diameter) / 2, seg, false).translate([0, 0, z0]),
        role: caps("side"),
      };
    case "sphere":
      return { m: Manifold.sphere(f.diameter / 2, seg), role: () => "surface" };
    case "hole":
      return {
        m: Manifold.cylinder(holeDepth + HOLE_LIP, f.diameter / 2, f.diameter / 2, seg, false).translate([0, 0, -holeDepth]),
        role: (_, n) => (n[2] > 0.999 ? "cap" : n[2] < -0.999 ? "floor" : "wall"),
      };
    case "extrude": {
      const line = profilePolyline(f.points, f.arcs, seg);
      const pts = signedArea(line.points) < 0 ? [...line.points].reverse() : line.points;
      const cs = new CrossSection([pts]);
      const m = Manifold.extrude(cs, f.height).translate([0, 0, z0]);
      cs.delete();
      const roles = rolesOf(f);
      return { m, role: (c, n) => (Math.abs(n[2]) > 0.999 ? (n[2] > 0 ? "top" : "bottom") : roles[2 + nearestEdge(c[0], c[1], line)]) };
    }
    case "revolve": {
      const line = profilePolyline(f.points, f.arcs, seg);
      const pts = signedArea(line.points) < 0 ? [...line.points].reverse() : line.points;
      const angle = f.angle ?? 360;
      const cs = new CrossSection([pts]);
      const m = Manifold.revolve(cs, seg, angle);
      cs.delete();
      const roles = rolesOf(f);
      return {
        m,
        role: (c, n) => {
          if (angle < 360) {
            let th = Math.atan2(c[1], c[0]);
            if (th < -1e-6) th += 2 * Math.PI;
            const t: Vec3 = [-Math.sin(th), Math.cos(th), 0];
            if (Math.abs(dot(n, t)) > 0.95) return th < ((angle / 2) * Math.PI) / 180 ? "start" : "end";
          }
          return roles[nearestEdge(Math.hypot(c[0], c[1]), c[2], line)];
        },
      };
    }
  }
}

// ---------- build ----------

export function build(w: ManifoldToplevel, doc: CadDoc, opts: BuildOptions = {}): BuildResult {
  const t0 = Date.now();
  const result: BuildResult = { ok: false, issues: validate(doc), errors: [], bodies: [], parts: {}, features: {}, designedRefs: [], ms: 0 };
  if (result.issues.length) { result.ms = Date.now() - t0; return result; }

  const seg = opts.circularSegments ?? 48;
  const { Manifold, Mesh } = w;
  const refs: string[] = [];
  const refIndex = new Map<string, number>();
  const refId = (r: string) => {
    let i = refIndex.get(r);
    if (i == null) { i = refs.length; refs.push(r); refIndex.set(r, i); }
    return i;
  };
  const garbage: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T) => (garbage.push(x), x);

  try {
    for (const part of doc.parts) {
      let body: Manifold | null = null;
      part.features.forEach((f, index) => {
        const op = defaultOp(f, index);
        const fb: FeatureBuild = { feature: f, partId: part.id, op, instances: [] };
        result.features[f.id] = fb;
        try {
          // Frame from `at`: analytic face frame of an earlier feature instance.
          let base = I4();
          if (f.at) {
            const r = parseRef(f.at)!;
            const target = result.features[r.id];
            const inst = target.instances[(r.instance ?? 1) - 1];
            if (!inst) throw new Error(`at "${f.at}": that feature failed to build`);
            let lf = localFaceFrame(target.feature, r.role!, inst.holeDepth);
            if (!lf) throw new Error(`at "${f.at}": no frame for that face`);
            // A face of a subtracted tool faces the other way in the result (into the void).
            if (target.op === "subtract") lf = mul(lf, rotX(180));
            base = mul(inst.matrix as M4, lf);
          }
          const local = mul(translate(f.position ?? [0, 0, 0]), rotXYZ(f.rotation ?? [0, 0, 0]));
          const pats = patternMatrices(f.pattern);
          const multi = pats.length > 1;
          const tools: Manifold[] = [];
          pats.forEach((pm, i) => {
            const matrix = mul(base, mul(pm, local));
            const instRef = multi ? formatRef(f.id, i + 1) : f.id;
            // Through holes: deep enough to leave the current body, measured along the hole axis.
            let holeDepth = 0;
            if (f.type === "hole") {
              if (f.depth != null) holeDepth = f.depth;
              else if (body && !body.isEmpty()) {
                const bb = body.boundingBox(), inv = rigidInverse(matrix);
                let minZ = 0;
                for (const x of [bb.min[0], bb.max[0]]) for (const y of [bb.min[1], bb.max[1]]) for (const z of [bb.min[2], bb.max[2]])
                  minZ = Math.min(minZ, apply(inv, [x, y, z])[2]);
                holeDepth = -minZ + 1;
              } else holeDepth = 1;
            }
            const { m: raw, role } = primitive(w, f, seg, holeDepth);
            keep(raw);
            const g = raw.getMesh();
            const n = g.numTri;
            const faceID = new Uint32Array(n);
            const vp = g.vertProperties, np = g.numProp, tv = g.triVerts;
            for (let t = 0; t < n; t++) {
              const a = tv[3 * t] * np, b = tv[3 * t + 1] * np, c = tv[3 * t + 2] * np;
              const A: Vec3 = [vp[a], vp[a + 1], vp[a + 2]], B: Vec3 = [vp[b], vp[b + 1], vp[b + 2]], C: Vec3 = [vp[c], vp[c + 1], vp[c + 2]];
              const nrm = norm(cross(sub(B, A), sub(C, A)));
              const cen: Vec3 = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
              faceID[t] = refId(formatRef(f.id, multi ? i + 1 : undefined, role(cen, nrm)));
            }
            const originalID = Manifold.reserveIDs(1);
            const tagged = keep(new Manifold(new Mesh({
              numProp: np, vertProperties: vp, triVerts: tv, faceID,
              runIndex: new Uint32Array([0, n * 3]), runOriginalID: new Uint32Array([originalID]),
            })));
            tools.push(keep(tagged.transform(matrix as Mat4)));
            fb.instances.push({ ref: instRef, matrix: matrix as Mat4, originalID, holeDepth: f.type === "hole" ? holeDepth : undefined });
            for (const role of rolesOf(f)) result.designedRefs.push(formatRef(f.id, multi ? i + 1 : undefined, role));
          });
          const tool = tools.length === 1 ? tools[0] : keep(Manifold.union(tools));
          let next: Manifold;
          if (!body) next = tool;
          else if (op === "union") next = keep(body.add(tool));
          else if (op === "subtract") next = keep(body.subtract(tool));
          else next = keep(body.intersect(tool));
          const status = next.status();
          if (status !== "NoError") throw new Error(`kernel status ${status}`);
          body = next;
        } catch (e) {
          fb.error = e instanceof Error ? e.message : String(e);
          result.errors.push({ featureId: f.id, message: fb.error });
        }
      });

      if (!body || (body as Manifold).isEmpty()) {
        result.errors.push({ featureId: part.id, message: `part "${part.id}" is empty (check subtract/intersect operations)` });
        result.parts[part.id] = { volume: 0, surfaceArea: 0, genus: 0, components: 0, bbox: null, triangles: 0 };
        continue;
      }
      const b = body as Manifold;
      const comps = b.decompose();
      comps.forEach(keep);
      const bb = b.boundingBox();
      result.parts[part.id] = {
        volume: b.volume(), surfaceArea: b.surfaceArea(), genus: b.genus(), components: comps.length,
        bbox: { min: [...bb.min] as Vec3, max: [...bb.max] as Vec3 }, triangles: b.numTri(),
      };
      result.bodies.push(toBodyMesh(part.id, b, refs));
    }
    result.ok = result.errors.length === 0;
  } finally {
    for (const g of garbage) { try { g.delete(); } catch { /* already freed */ } }
  }
  result.ms = Date.now() - t0;
  return result;
}

function toBodyMesh(bodyId: string, m: Manifold, refs: string[]): BodyMesh {
  const g = m.getMesh();
  const n = g.numTri, np = g.numProp;
  const positions = new Float32Array(g.numVert * 3);
  for (let v = 0; v < g.numVert; v++) for (let k = 0; k < 3; k++) positions[v * 3 + k] = g.vertProperties[v * np + k];
  const local = new Map<number, number>();
  const bodyRefs: string[] = [];
  const triRef = new Uint32Array(n);
  for (let t = 0; t < n; t++) {
    const id = g.faceID[t];
    let li = local.get(id);
    if (li == null) { li = bodyRefs.length; local.set(id, li); bodyRefs.push(refs[id] ?? `?${id}`); }
    triRef[t] = li;
  }
  const backside = new Uint8Array(n);
  for (let r = 0; r < g.numRun; r++) {
    if (!g.runFlags || !(g.runFlags[r] & 1)) continue;
    for (let t = g.runIndex[r] / 3; t < g.runIndex[r + 1] / 3; t++) backside[t] = 1;
  }
  const triVerts = new Uint32Array(g.triVerts);
  return { bodyId, positions, triVerts, indices: triVerts, triRef, refs: bodyRefs, backside };
}
