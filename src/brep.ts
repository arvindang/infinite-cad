// Exact B-rep of a built model, for STEP export (OpenCascade through replicad).
// The manifold build has already resolved every placement (`at` frames, patterns, through-hole
// depths), so this only rebuilds each instance as an analytic solid with the same matrix and
// replays the same booleans. Features the mesh build skipped are skipped here too.
import { Vector, basicFaceExtrusion, cast, exportSTEP, getOC, makeBox, makeCylinder, makePolygon, makeSphere, measureVolume, revolution, type Shape3D } from "replicad";
import { HOLE_LIP, zBase, type BuildResult } from "./geometry.ts";
import type { CadDoc, Feature, Vec2 } from "./schema.ts";

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

/** Profile in the XZ plane (x = radius, y = height), revolved about Z from +X, like Manifold.revolve. */
const revolve = (pts: Vec2[], angle: number) => revolution(makePolygon(dedupe(pts.map(([r, z]) => [r, 0, z] as Pt))), [0, 0, 0], [0, 0, 1], angle) as Shape3D;

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
      const face = makePolygon(dedupe(f.points.map(([x, y]) => [x, y, z0] as Pt)));
      return basicFaceExtrusion(face, new Vector([0, 0, f.height]));
    }
    case "revolve":
      return revolve(f.points, f.angle ?? 360);
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
