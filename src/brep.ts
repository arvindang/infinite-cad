// Exact B-rep of a built model, for STEP export (OpenCascade through replicad).
// The manifold build has already resolved every placement (`at` frames, patterns, through-hole
// depths), so this only rebuilds each instance as an analytic solid with the same matrix and
// replays the same booleans. Features the mesh build skipped are skipped here too.
import {
  Vector, assembleWire, basicFaceExtrusion, cast, exportSTEP, getOC, makeBox, makeCylinder, makeFace, makeLine, makePolygon,
  makeSphere, makeThreePointArc, measureArea, measureVolume, revolution, type Edge, type Face, type Shape3D, type Vector as Vec,
} from "replicad";
import type { DxfEntity, P2 } from "./dxf.ts";
import { HOLE_LIP, zBase, type BuildResult } from "./geometry.ts";
import { indexFacts, resolve } from "./facts.ts";
import { arcOf, signedArea, type CadDoc, type Feature, type Vec2 } from "./schema.ts";

export interface BrepPart {
  id: string;
  name: string;
  shape: Shape3D;
  volume: number; // exact, mm³
  meshVolume: number; // what the mesh build measured (curves are faceted there)
}

type Pt = [number, number, number];

/** Consecutive duplicates (a cone's apex, a profile closing on itself) break wire building. */
function dedupe(pts: Pt[]): Pt[] {
  const out = pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-9;
  });
  return out;
}

/**
 * A planar face from a profile whose edges may be arcs (true circular edges, so STEP gets
 * cylinders, tori and spheres instead of facets). `to3` lifts a profile point into 3D.
 */
function profileFace(pts: Vec2[], arcs: (number | null)[] | undefined, to3: (p: Vec2) => Pt): Face {
  if (!arcs?.some((r) => r)) return makePolygon(dedupe(pts.map(to3)));
  const inside = Math.sign(signedArea(pts)) || 1;
  const edges: Edge[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], r = arcs[i];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) continue;
    edges.push(r ? makeThreePointArc(to3(a), to3(arcOf(a, b, r, inside).mid), to3(b)) : makeLine(to3(a), to3(b)));
  }
  return makeFace(assembleWire(edges));
}

/** Profile in the XZ plane (x = radius, y = height), revolved about Z from +X, like Manifold.revolve. */
const revolve = (pts: Vec2[], angle: number, arcs?: (number | null)[]) =>
  revolution(profileFace(pts, arcs, ([r, z]) => [r, 0, z]), [0, 0, 0], [0, 0, 1], angle) as Shape3D;

/** The feature's solid in its local frame, matching src/geometry.ts primitive(). */
function primitive(f: Feature, holeDepth: number): Shape3D {
  const z0 = zBase(f);
  switch (f.type) {
    case "box": {
      const [sx, sy, sz] = f.size;
      return makeBox([-sx / 2, -sy / 2, z0], [sx / 2, sy / 2, z0 + sz]);
    }
    case "cylinder": {
      const r = f.diameter / 2, rt = (f.diameterTop ?? f.diameter) / 2;
      if (Math.abs(r - rt) < 1e-12) return makeCylinder(r, f.height, [0, 0, z0], [0, 0, 1]);
      return revolve([[0, z0], [r, z0], [rt, z0 + f.height], [0, z0 + f.height]], 360);
    }
    case "sphere":
      return makeSphere(f.diameter / 2);
    case "hole":
      return makeCylinder(f.diameter / 2, holeDepth + HOLE_LIP, [0, 0, -holeDepth], [0, 0, 1]);
    case "extrude": {
      const face = profileFace(f.points, f.arcs, ([x, y]) => [x, y, z0]);
      return basicFaceExtrusion(face, new Vector([0, 0, f.height]));
    }
    case "revolve":
      return revolve(f.points, f.angle ?? 360, f.arcs);
  }
}

/** Moves a shape by a column-major rigid 4x4 (the mesh build's instance matrix). */
function place(s: Shape3D, m: readonly number[]): Shape3D {
  const oc = getOC();
  const t = new oc.gp_Trsf();
  t.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
  const b = new oc.BRepBuilderAPI_Transform(s.wrapped, t, true, false);
  const out = cast(b.Shape()) as Shape3D;
  t.delete();
  b.delete();
  return out;
}

/**
 * Rebuilds every part that the mesh build produced. Throws if a feature can't be built exactly,
 * so a caller never ships a STEP that silently drops geometry. Call dispose() when done.
 */
export function buildBrep(doc: CadDoc, built: BuildResult): { parts: BrepPart[]; dispose: () => void } {
  const trash: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(x: T) => (trash.push(x), x);
  const dispose = () => {
    for (const x of trash) try { x.delete(); } catch { /* already freed */ }
  };
  try {
    const parts: BrepPart[] = [];
    for (const part of doc.parts) {
      if (!built.bodies.some((b) => b.bodyId === part.id)) continue; // empty or failed in the mesh build
      let body: Shape3D | null = null;
      for (const f of part.features) {
        const fb = built.features[f.id];
        if (!fb || fb.error) continue;
        try {
          let tool: Shape3D | null = null;
          for (const inst of fb.instances) {
            const s = own(place(own(primitive(f, inst.holeDepth ?? 0)), inst.matrix as number[]));
            tool = tool ? own(tool.fuse(s)) : s;
          }
          if (!tool) continue;
          if (!body) body = tool;
          else if (fb.op === "union") body = own(body.fuse(tool));
          else if (fb.op === "subtract") body = own(body.cut(tool));
          else body = own(body.intersect(tool) as Shape3D);
        } catch (e) {
          throw new Error(`"${f.id}" couldn't be built exactly: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!body) continue;
      parts.push({ id: part.id, name: part.name || part.id, shape: body, volume: measureVolume(body), meshVolume: built.parts[part.id]?.volume ?? 0 });
    }
    return { parts, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}

/** AP242 STEP in mm, one named solid per part. */
export function stepOf(parts: BrepPart[]): Blob {
  return exportSTEP(parts.map((p) => ({ shape: p.shape, name: p.name, color: "#c4c7cc" })), { unit: "MM", modelUnit: "MM" });
}

// ---------- flat outlines (for DXF) ----------

export interface FacePlane {
  normal: Pt; // outward, unit
  offset: number; // normal · point on the plane
}

export interface Outline {
  part: string;
  name: string;
  plane: FacePlane;
  area: number; // mm², all faces on the plane
  /** In the face's own frame, looking at it from outside (u, v, normal right-handed), mm. */
  entities: DxfEntity[];
}

const tup = (v: Vec): Pt => {
  const t: Pt = [v.x, v.y, v.z];
  v.delete();
  return t;
};
const dot3 = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Pt, b: Pt): Pt => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a: Pt): Pt => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** u, v axes for a face with outward normal n: X stays X on top and bottom faces, Z stays up on side faces. */
function faceAxes(n: Pt): [Pt, Pt] {
  if (Math.abs(n[2]) > 0.9) {
    const u = unit3([1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]]);
    return [u, cross3(n, u)];
  }
  const v = unit3([-n[2] * n[0], -n[2] * n[1], 1 - n[2] * n[2]]);
  return [cross3(v, n), v];
}

function circleThrough(a: P2, b: P2, c: P2): { c: P2; r: number } {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const s = (p: P2) => p[0] * p[0] + p[1] * p[1];
  const x = (s(a) * (b[1] - c[1]) + s(b) * (c[1] - a[1]) + s(c) * (a[1] - b[1])) / d;
  const y = (s(a) * (c[0] - b[0]) + s(b) * (a[0] - c[0]) + s(c) * (b[0] - a[0])) / d;
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) };
}

/** One edge of a flat face as DXF: lines, circles and arcs stay exact; any other curve becomes a polyline. */
function edgeEntity(e: Edge, to2: (p: Pt) => P2): DxfEntity {
  const curve = e.curve;
  try {
    const at = (t: number) => to2(tup(curve.pointAt(t)));
    const type = curve.curveType, closed = curve.isClosed;
    if (type === "LINE") return { kind: "line", a: at(0), b: at(1) };
    if (type === "CIRCLE") {
      const a = at(0), m = at(0.5), b = at(1);
      const { c, r } = circleThrough(a, at(0.25), m);
      if (closed) return { kind: "circle", c, r };
      const deg = (p: P2) => (Math.atan2(p[1] - c[1], p[0] - c[0]) * 180) / Math.PI;
      const ccw = (a[0] - c[0]) * (m[1] - c[1]) - (a[1] - c[1]) * (m[0] - c[0]) > 0;
      return ccw ? { kind: "arc", c, r, start: deg(a), end: deg(b) } : { kind: "arc", c, r, start: deg(b), end: deg(a) };
    }
    const n = 64;
    return { kind: "poly", pts: Array.from({ length: closed ? n : n + 1 }, (_, i) => at(i / n)), closed };
  } finally {
    curve.delete();
  }
}

/**
 * The outline of a part's flat face: every face of the part on `plane`, or by default on the plane
 * of its largest flat face (ties go to the one facing most upward). Null if nothing lies on the plane.
 */
export function outlineOf(p: BrepPart, plane?: FacePlane): Outline | null {
  const faces = p.shape.faces;
  try {
    const flat = faces.filter((f) => f.geomType === "PLANE").map((f) => {
      const n = unit3(tup(f.normalAt()));
      return { f, n, d: dot3(n, tup(f.center)), area: measureArea(f) };
    });
    if (!flat.length) return null;
    if (!plane) {
      const best = flat.reduce((a, b) => (Math.abs(b.area - a.area) > 1e-6 * a.area ? (b.area > a.area ? b : a) : b.n[2] > a.n[2] ? b : a));
      plane = { normal: best.n, offset: best.d };
    } else {
      // A requested plane comes from rounded facts: snap it to the nearest exact face first.
      const want = plane;
      const near = flat.filter((x) => dot3(x.n, want.normal) > 0.999 && Math.abs(x.d - want.offset) < 0.5)
        .sort((a, b) => Math.abs(a.d - want.offset) - Math.abs(b.d - want.offset))[0];
      if (!near) return null;
      plane = { normal: near.n, offset: near.d };
    }
    const on = flat.filter((x) => dot3(x.n, plane!.normal) > 0.9999 && Math.abs(x.d - plane!.offset) < 1e-3);
    if (!on.length) return null;
    const [u, v] = faceAxes(plane.normal);
    const to2 = (q: Pt): P2 => [dot3(q, u), dot3(q, v)];
    const entities: DxfEntity[] = [];
    for (const x of on) {
      const edges = x.f.edges;
      try {
        for (const e of edges) entities.push(edgeEntity(e, to2));
      } finally {
        edges.forEach((e) => e.delete());
      }
    }
    return { part: p.id, name: p.name, plane, area: on.reduce((s, x) => s + x.area, 0), entities };
  } finally {
    faces.forEach((f) => f.delete());
  }
}

/**
 * Outlines to export as DXF. Selected flat faces export their own plane; a selected part (or any
 * ref inside one) exports that part's largest flat face; with nothing usable selected, every part does.
 * `faceOf` resolves a ref to its part and, for a flat face, its plane.
 */
export function outlinesFor(parts: BrepPart[], select: string[], faceOf: (ref: string) => { part: string; plane?: FacePlane } | null): Outline[] {
  const picks: { part: BrepPart; plane?: FacePlane }[] = [];
  const seen = new Set<string>();
  for (const ref of select) {
    const r = faceOf(ref);
    const part = r && parts.find((p) => p.id === r.part);
    if (!part) continue;
    const key = r.plane ? `${part.id}|${r.plane.normal.map((x) => x.toFixed(4))}|${r.plane.offset.toFixed(3)}` : part.id;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push({ part, plane: r.plane });
  }
  if (!picks.length) picks.push(...parts.map((part) => ({ part })));
  return picks.map((x) => outlineOf(x.part, x.plane)).filter((o): o is Outline => !!o);
}

/** For outlinesFor: a ref's part and, when it is a flat face, its plane (from the mesh build's facts). */
export function refPlanes(doc: CadDoc, built: BuildResult): (ref: string) => { part: string; plane?: FacePlane } | null {
  const facts = indexFacts(built);
  return (ref) => {
    const r = resolve(doc, built, facts, ref) as Record<string, any>;
    if (r.kind === "part") return { part: ref };
    if (!r.part) return null;
    const flat = r.kind === "face" && r.surface === "plane" && r.normal && r.flatness > 0.999;
    return { part: r.part as string, plane: flat ? { normal: r.normal as Pt, offset: r.planeOffset as number } : undefined };
  };
}
