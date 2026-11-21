// Where a comment pin sits in 3D: the thread's stored point, snapped back onto its ref's faces when the
// model changed under it, then projected to the screen with an occlusion check. Built on ViewerHost.
import * as THREE from "three";
import type { Thread } from "../src/collab.ts";
import type { ViewerHost } from "./host";

export interface Spot {
  key: string;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}
export interface Screen {
  x: number;
  y: number;
  /** Outside the frustum or under a side panel: don't draw it. */
  off: boolean;
  /** Something on the model is between the camera and the pin. */
  behind: boolean;
}

/** Where a thread points now: the current ref (follows renames), or the pinned one, or its nearest existing ancestor. null = detached. */
export function threadKey(host: ViewerHost, t: Thread): string | null {
  if (!t.anchor.ref) return null;
  if (t.target.status === "removed" || t.target.status === "unknown") return null;
  return host.resolveKey(t.target.ref ?? t.anchor.ref);
}

const tri = new THREE.Triangle();
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), q = new THREE.Vector3();

/** The closest point on a key's faces to `near` (or to the faces' area-weighted centroid), with that triangle's normal. */
export function spotOn(host: ViewerHost, key: string, near?: THREE.Vector3 | null): Spot | null {
  const ranges = host.expand(key).map((r) => host.refRange(r)).filter((r) => r !== null);
  if (!ranges.length) return null;
  let target = near ?? null;
  if (!target) {
    const sum = new THREE.Vector3();
    let area = 0;
    for (const { positions: p, start, count } of ranges)
      for (let i = start; i < start + count; i += 3) {
        tri.set(a.fromArray(p, i * 3), b.fromArray(p, i * 3 + 3), c.fromArray(p, i * 3 + 6));
        const ar = tri.getArea();
        sum.addScaledVector(tri.getMidpoint(q), ar);
        area += ar;
      }
    if (!area) return null;
    target = sum.divideScalar(area);
  }
  let best = Infinity;
  const point = new THREE.Vector3(), normal = new THREE.Vector3();
  for (const { positions: p, start, count } of ranges)
    for (let i = start; i < start + count; i += 3) {
      tri.set(a.fromArray(p, i * 3), b.fromArray(p, i * 3 + 3), c.fromArray(p, i * 3 + 6));
      tri.closestPointToPoint(target, q);
      const d = q.distanceToSquared(target);
      if (d < best) {
        best = d;
        point.copy(q);
        tri.getNormal(normal);
      }
    }
  return { key, point, normal };
}

/** Snapped spots per thread, cached per shown version (versions are immutable). */
export class PinPlacer {
  private cache = new Map<string, Spot | null>();
  private version = -1;
  private size = 0;
  private ray = new THREE.Raycaster();
  private v = new THREE.Vector3();

  constructor(private host: ViewerHost) {
    this.ray.firstHitOnly = true;
  }

  /** The model changed (a build) or a thread's target did. */
  invalidate(id?: string) {
    if (!id) return this.cache.clear(), void (this.size = 0);
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${id}:`)) this.cache.delete(k);
  }

  modelSize() {
    if (!this.size) {
      const box = new THREE.Box3();
      for (const m of this.host.meshes()) box.union(new THREE.Box3().setFromObject(m));
      this.size = box.isEmpty() ? 100 : box.getSize(this.v).length();
    }
    return this.size;
  }

  spot(t: Thread): Spot | null {
    const v = this.host.shownVersion();
    if (v !== this.version) this.invalidate(), (this.version = v);
    const ck = `${t.id}:${t.target.status}:${t.target.ref ?? ""}`;
    if (this.cache.has(ck)) return this.cache.get(ck)!;
    const key = threadKey(this.host, t);
    let s: Spot | null = null;
    if (key) {
      const stored = t.anchor.point ? new THREE.Vector3(...t.anchor.point) : null;
      s = spotOn(this.host, key, stored);
      // still on the face (within ~1e-3 of the model): keep the exact spot and normal it was made at
      if (s && stored && t.anchor.normal && s.point.distanceTo(stored) <= 1e-3 * this.modelSize()) {
        s.point.copy(stored);
        s.normal.set(...t.anchor.normal);
      }
    }
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${t.id}:`)) this.cache.delete(k);
    this.cache.set(ck, s);
    return s;
  }

  /** CSS px on the page, plus whether it's hidden behind the model. */
  project(p: THREE.Vector3, occlusion = true): Screen {
    const { camera, canvas } = this.host.three;
    const r = canvas.getBoundingClientRect();
    const n = this.v.copy(p).project(camera);
    const x = r.left + ((n.x + 1) / 2) * r.width;
    const y = r.top + ((1 - n.y) / 2) * r.height;
    const { left, right } = this.host.insets();
    const off = n.z > 1 || n.z < -1 || x < r.left + left || x > r.right - right || y < r.top || y > r.bottom;
    let behind = false;
    if (occlusion && !off) {
      const dir = this.v.copy(p).sub(camera.position);
      const dist = dir.length();
      this.ray.set(camera.position, dir.divideScalar(dist));
      this.ray.far = dist;
      const hit = this.ray.intersectObjects(this.host.meshes().filter((m) => m.visible), false)[0];
      behind = !!hit && hit.distance < dist - Math.max(1e-3 * this.modelSize(), 0.05);
    }
    return { x, y, off, behind };
  }
}
