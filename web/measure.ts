// Measure mode: dimensions read off the built mesh (not the source), drawn as lines in the scene
// with HTML labels. Planar faces get their two in-plane extents (or Ø when round), cylindrical
// faces their Ø and length, anything else its X/Y/Z extents. Everything is in mm until formatted.
import * as THREE from "three";

export type Unit = "mm" | "in" | "m";
export const UNITS: Unit[] = ["mm", "in", "m"];

export function formatLength(mm: number, unit: Unit): string {
  const trim = (x: number, d: number) => String(Number(x.toFixed(d)));
  if (unit === "in") return `${trim(mm / 25.4, 3)} in`;
  if (unit === "m") return `${trim(mm / 1000, 4)} m`;
  return `${trim(mm, 2)} mm`;
}

export interface Dim {
  from: THREE.Vector3; // the dimension line
  to: THREE.Vector3;
  ext: [THREE.Vector3, THREE.Vector3][]; // extension lines from the measured points
  side: THREE.Vector3; // unit, perpendicular to the line: arrowheads open toward it
  value: number; // mm
  dia?: boolean;
  priority: number; // higher wins when labels overlap
}

const EPS = 0.01; // mm: shorter extents aren't dimensions
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

/** X, Y and Z extents of a box, on the edges nearest the default (front-right) camera. */
export function boxDims(box: THREE.Box3, gap: number, priority = 3): Dim[] {
  if (box.isEmpty()) return [];
  const { min, max } = box;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const out: Dim[] = [];
  if (max.x - min.x > EPS) out.push({
    from: v(min.x, min.y - gap, min.z), to: v(max.x, min.y - gap, min.z),
    ext: [[v(min.x, min.y, min.z), v(min.x, min.y - gap * 1.3, min.z)], [v(max.x, min.y, min.z), v(max.x, min.y - gap * 1.3, min.z)]],
    side: v(0, -1, 0), value: max.x - min.x, priority,
  });
  if (max.y - min.y > EPS) out.push({
    from: v(max.x + gap, min.y, min.z), to: v(max.x + gap, max.y, min.z),
    ext: [[v(max.x, min.y, min.z), v(max.x + gap * 1.3, min.y, min.z)], [v(max.x, max.y, min.z), v(max.x + gap * 1.3, max.y, min.z)]],
    side: v(1, 0, 0), value: max.y - min.y, priority,
  });
  if (max.z - min.z > EPS) {
    const d = gap * Math.SQRT1_2;
    out.push({
      from: v(max.x + d, min.y - d, min.z), to: v(max.x + d, min.y - d, max.z),
      ext: [[v(max.x, min.y, min.z), v(max.x + d * 1.3, min.y - d * 1.3, min.z)], [v(max.x, min.y, max.z), v(max.x + d * 1.3, min.y - d * 1.3, max.z)]],
      side: v(1, -1, 0).normalize(), value: max.z - min.z, priority,
    });
  }
  return out;
}

/** A unit vector perpendicular to n, as close to a world axis as possible (X, then Y, then Z). */
function perpendicular(n: THREE.Vector3): THREE.Vector3 {
  for (const a of AXES) {
    const p = a.clone().addScaledVector(n, -a.dot(n));
    if (p.lengthSq() > 0.25) return p.normalize();
  }
  return new THREE.Vector3(1, 0, 0);
}

export type FaceShape = "plane" | "disc" | "cylinder" | "other";

/**
 * Dimensions of one face: its triangles are `count` vertices from `start` in a non-indexed
 * position buffer. `gap` is how far dimension lines stand off the face.
 */
export function faceDims(pos: Float32Array, start: number, count: number, gap: number, priority = 5): { shape: FaceShape; dims: Dim[] } {
  const tris = count / 3;
  if (!tris) return { shape: "other", dims: [] };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const normals: THREE.Vector3[] = [];
  const areas: number[] = [];
  const sum = new THREE.Vector3();
  let area = 0;
  for (let t = 0; t < tris; t++) {
    const o = (start + t * 3) * 3;
    a.fromArray(pos, o); b.fromArray(pos, o + 3); c.fromArray(pos, o + 6);
    const n = c.clone().sub(b).cross(a.clone().sub(b));
    const ar = n.length() / 2;
    if (ar < 1e-9) continue;
    normals.push(n.normalize());
    areas.push(ar);
    sum.addScaledVector(n, ar);
    area += ar;
  }
  if (!normals.length) return { shape: "other", dims: [] };
  const verts: THREE.Vector3[] = [];
  for (let i = start; i < start + count; i++) verts.push(new THREE.Vector3().fromArray(pos, i * 3));

  // planar: every triangle faces the same way
  const N = sum.clone().normalize();
  if (sum.length() > 1e-9 && normals.every((n) => n.dot(N) > 0.999)) {
    const u = perpendicular(N);
    const v = N.clone().cross(u);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, w = 0;
    for (const p of verts) {
      const pu = p.dot(u), pv = p.dot(v);
      u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); v0 = Math.min(v0, pv); v1 = Math.max(v1, pv);
      w += p.dot(N);
    }
    w /= verts.length;
    const at = (pu: number, pv: number) => u.clone().multiplyScalar(pu).addScaledVector(v, pv).addScaledVector(N, w);
    const du = u1 - u0, dv = v1 - v0;
    // round (a disc or a ring): every vertex sits within the circle the extents describe
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, r = Math.max(du, dv) / 2;
    const round = du > EPS && Math.abs(du - dv) < 0.01 * Math.max(du, dv) &&
      verts.every((p) => Math.hypot(p.dot(u) - cu, p.dot(v) - cv) <= r * 1.005);
    if (round) {
      return { shape: "disc", dims: [{ from: at(cu - r, cv), to: at(cu + r, cv), ext: [], side: v.clone(), value: 2 * r, dia: true, priority }] };
    }
    const dims: Dim[] = [];
    if (du > EPS) dims.push({
      from: at(u0, v0 - gap), to: at(u1, v0 - gap),
      ext: [[at(u0, v0), at(u0, v0 - gap * 1.3)], [at(u1, v0), at(u1, v0 - gap * 1.3)]],
      side: v.clone().negate(), value: du, priority,
    });
    if (dv > EPS) dims.push({
      from: at(u1 + gap, v0), to: at(u1 + gap, v1),
      ext: [[at(u1, v0), at(u1 + gap * 1.3, v0)], [at(u1, v1), at(u1 + gap * 1.3, v1)]],
      side: u.clone(), value: dv, priority,
    });
    return { shape: "plane", dims };
  }

  // cylindrical: every normal is perpendicular to one axis, every vertex the same distance from it
  let big = 0;
  for (let i = 1; i < areas.length; i++) if (areas[i] > areas[big]) big = i;
  const n0 = normals[big];
  let axis: THREE.Vector3 | null = null, best = 0.1;
  for (const n of normals) {
    const x = n0.clone().cross(n);
    if (x.length() > best) (best = x.length()), (axis = x);
  }
  if (axis) {
    axis.normalize();
    if (normals.every((n) => Math.abs(n.dot(axis!)) < 0.03)) {
      const e1 = perpendicular(axis), e2 = axis.clone().cross(e1);
      const fit = fitCircle(verts.map((p) => [p.dot(e1), p.dot(e2)]));
      if (fit) {
        let h0 = Infinity, h1 = -Infinity;
        for (const p of verts) {
          const h = p.dot(axis);
          h0 = Math.min(h0, h); h1 = Math.max(h1, h);
        }
        const centre = (h: number) => e1.clone().multiplyScalar(fit.x).addScaledVector(e2, fit.y).addScaledVector(axis!, h);
        // the Ø goes across the end nearer the top (+Z) so it reads from above
        const top = centre(h1).z >= centre(h0).z ? h1 : h0, bottom = top === h1 ? h0 : h1;
        const d = perpendicular(axis);
        const dims: Dim[] = [{
          from: centre(top).addScaledVector(d, -fit.r), to: centre(top).addScaledVector(d, fit.r),
          ext: [], side: axis.clone().multiplyScalar(top === h1 ? 1 : -1), value: 2 * fit.r, dia: true, priority: priority + 1,
        }];
        if (h1 - h0 > EPS) {
          const off = fit.r + gap;
          dims.push({
            from: centre(bottom).addScaledVector(d, off), to: centre(top).addScaledVector(d, off),
            ext: [[centre(bottom).addScaledVector(d, fit.r), centre(bottom).addScaledVector(d, off + gap * 0.3)], [centre(top).addScaledVector(d, fit.r), centre(top).addScaledVector(d, off + gap * 0.3)]],
            side: d.clone(), value: h1 - h0, priority,
          });
        }
        return { shape: "cylinder", dims };
      }
    }
  }

  // anything else: its extents along X, Y, Z
  const box = new THREE.Box3().setFromPoints(verts);
  return { shape: "other", dims: boxDims(box, gap, priority) };
}

/** Least-squares circle through 2D points (Kåsa); null unless the points really are on one. */
function fitCircle(pts: number[][]): { x: number; y: number; r: number } | null {
  if (pts.length < 3) return null;
  // minimise Σ (x² + y² + Dx + Ey + F)²: normal equations, 3×3
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0], rhs = [0, 0, 0];
  for (const [x, y] of pts) {
    const row = [x, y, 1], z = -(x * x + y * y);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) m[i * 3 + j] += row[i] * row[j];
      rhs[i] += row[i] * z;
    }
  }
  const s = new THREE.Matrix3().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
  if (Math.abs(s.determinant()) < 1e-12) return null;
  const sol = new THREE.Vector3(...rhs).applyMatrix3(s.invert());
  const x = -sol.x / 2, y = -sol.y / 2;
  const r = Math.sqrt(x * x + y * y - sol.z);
  if (!Number.isFinite(r) || r <= EPS) return null;
  // vertices of a tessellated circle sit on it: the largest miss should be tiny
  if (pts.some(([px, py]) => Math.abs(Math.hypot(px - x, py - y) - r) > Math.max(0.01, r * 0.01))) return null;
  return { x, y, r: Math.max(...pts.map(([px, py]) => Math.hypot(px - x, py - y))) };
}

/** Lines in the scene and labels over the canvas. Labels that would overlap a higher-priority one hide. */
export class DimLayer {
  readonly group = new THREE.Group();
  private lineMat = new THREE.LineBasicMaterial({ depthTest: false, transparent: true });
  private extMat = new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.45 });
  private dims: Dim[] = [];
  private labels: HTMLElement[] = [];
  private sizes: [number, number][] = [];
  private v = new THREE.Vector3();

  constructor(private root: HTMLElement) {
    this.group.renderOrder = 10;
  }

  setColor(hex: number) {
    this.lineMat.color.setHex(hex);
    this.extMat.color.setHex(hex);
  }

  set(dims: Dim[], unit: Unit, arrow: number) {
    this.clear();
    this.dims = [...dims].sort((a, b) => b.priority - a.priority);
    const main: number[] = [], ext: number[] = [];
    const push = (arr: number[], p: THREE.Vector3, q: THREE.Vector3) => arr.push(p.x, p.y, p.z, q.x, q.y, q.z);
    for (const d of this.dims) {
      push(main, d.from, d.to);
      for (const [p, q] of d.ext) push(ext, p, q);
      const dir = d.to.clone().sub(d.from);
      const len = dir.length();
      if (len < 1e-9) continue;
      dir.divideScalar(len);
      const s = Math.min(arrow, len * 0.25);
      for (const [tip, sign] of [[d.to, -1], [d.from, 1]] as const) {
        const back = tip.clone().addScaledVector(dir, sign * s);
        push(main, tip, back.clone().addScaledVector(d.side, s * 0.35));
        push(main, tip, back.clone().addScaledVector(d.side, -s * 0.35));
      }
    }
    for (const [arr, mat] of [[main, this.lineMat], [ext, this.extMat]] as const) {
      if (!arr.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      const l = new THREE.LineSegments(g, mat);
      l.renderOrder = 10;
      this.group.add(l);
    }
    this.labels = this.dims.map((d) => {
      const el = document.createElement("div");
      el.className = "dim";
      el.textContent = `${d.dia ? "Ø " : ""}${formatLength(d.value, unit)}`;
      this.root.append(el);
      return el;
    });
    // measured once, while visible: a hidden label has no size
    this.sizes = this.labels.map((el) => [el.offsetWidth, el.offsetHeight]);
  }

  clear() {
    for (const c of this.group.children) (c as THREE.LineSegments).geometry.dispose();
    this.group.clear();
    for (const el of this.labels) el.remove();
    this.labels = [];
    this.dims = [];
  }

  /** Put every label at its line's midpoint on screen; call after the camera moves. */
  place(camera: THREE.Camera, width: number, height: number) {
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    this.dims.forEach((d, i) => {
      const el = this.labels[i];
      this.v.addVectors(d.from, d.to).multiplyScalar(0.5).project(camera);
      if (this.v.z > 1 || Math.abs(this.v.x) > 1.2 || Math.abs(this.v.y) > 1.2) return void (el.hidden = true);
      const x = ((this.v.x + 1) / 2) * width, y = ((1 - this.v.y) / 2) * height;
      const [w, h] = this.sizes[i];
      // on its line, else just above or below it (concentric Ø labels), else hidden
      for (const dy of [0, -(h + 6), h + 6]) {
        const r = { x0: x - w / 2 - 2, y0: y + dy - h / 2 - 2, x1: x + w / 2 + 2, y1: y + dy + h / 2 + 2 };
        if (placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0)) continue;
        placed.push(r);
        el.hidden = false;
        el.style.transform = `translate(${Math.round(x - w / 2)}px, ${Math.round(y + dy - h / 2)}px)`;
        return;
      }
      el.hidden = true;
    });
  }
}
