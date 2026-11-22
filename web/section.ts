// Section view: one clipping plane through every body, with the cut filled in so solid reads as solid.
// The fill is the usual stencil trick: back faces behind the plane count up, front faces count down,
// and the hatched cap is drawn wherever the count isn't zero (inside some solid). Works for any
// number of closed bodies, and the cap is never pickable.
import * as THREE from "three";

export class Section {
  on = false;
  /** The removed half is on this side of the plane n·p = d. */
  readonly n = new THREE.Vector3(0, -1, 0);
  d = 0;
  readonly plane = new THREE.Plane(); // three keeps signed distance >= 0
  readonly group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private box = new THREE.Box3();
  private cap: THREE.Mesh;
  private capMat: THREE.MeshBasicMaterial;
  private stencilMats: THREE.MeshBasicMaterial[];
  private tex: THREE.CanvasTexture;
  private colors: [number, number] = [0xa9adb4, 0x2b2d31];

  constructor(scene: THREE.Scene, private clipped: THREE.Material[]) {
    const pass = (side: THREE.Side, op: THREE.StencilOp) => new THREE.MeshBasicMaterial({
      side, depthWrite: false, depthTest: false, colorWrite: false,
      stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op,
      clippingPlanes: [this.plane],
    });
    this.stencilMats = [pass(THREE.BackSide, THREE.IncrementWrapStencilOp), pass(THREE.FrontSide, THREE.DecrementWrapStencilOp)];
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    this.tex = new THREE.CanvasTexture(canvas);
    this.tex.wrapS = this.tex.wrapT = THREE.RepeatWrapping;
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.capMat = new THREE.MeshBasicMaterial({
      map: this.tex, side: THREE.DoubleSide,
      // draw where the count isn't zero, and reset it as we go
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
    });
    this.cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.capMat);
    this.cap.renderOrder = 2; // after the bodies and the counting passes
    this.group.add(this.cap);
    this.group.visible = false;
    scene.add(this.group);
    this.paint();
  }

  /** The bodies changed (a build). */
  attach(meshes: THREE.Mesh[]) {
    for (const m of this.group.children.filter((c) => c !== this.cap)) this.group.remove(m);
    this.meshes = meshes;
    this.box.makeEmpty();
    for (const m of meshes) {
      if (m.geometry.boundingBox) this.box.union(m.geometry.boundingBox);
      for (const mat of this.stencilMats) {
        const s = new THREE.Mesh(m.geometry, mat); // shares the body's geometry; not in the pick list
        s.renderOrder = 1;
        s.raycast = () => {};
        this.group.add(s);
      }
    }
    this.d = THREE.MathUtils.clamp(this.d, ...this.range());
    this.update();
  }

  /** Where the plane can go along n: just inside the model at both ends. */
  range(n = this.n): [number, number] {
    if (this.box.isEmpty()) return [-1, 1];
    let lo = Infinity, hi = -Infinity;
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? this.box.max.x : this.box.min.x, i & 2 ? this.box.max.y : this.box.min.y, i & 4 ? this.box.max.z : this.box.min.z);
      const t = p.dot(n);
      lo = Math.min(lo, t); hi = Math.max(hi, t);
    }
    const pad = Math.max((hi - lo) * 0.001, 1e-3);
    return [lo + pad, hi - pad];
  }

  center(n = this.n): number {
    const [lo, hi] = this.range(n);
    return (lo + hi) / 2;
  }

  set(on: boolean) {
    this.on = on;
    for (const m of this.clipped) {
      m.clippingPlanes = on ? [this.plane] : null;
      m.needsUpdate = true;
    }
    this.update();
  }

  aim(n: THREE.Vector3, d: number) {
    this.n.copy(n).normalize();
    this.d = d;
    this.update();
  }

  flip() {
    this.n.negate();
    this.d = -this.d;
    this.update();
  }

  /** On the kept side (or on the plane): what picking and pins may hit. */
  keeps(p: THREE.Vector3, eps = 1e-4) {
    return !this.on || p.dot(this.n) <= this.d + eps;
  }

  /** Body and edge colors: the cap is the body a shade darker, hatched in the edge color. */
  setColors(body: number, edge: number) {
    this.colors = [body, edge];
    this.paint();
  }

  update() {
    this.plane.normal.copy(this.n).negate();
    this.plane.constant = this.d;
    this.group.visible = this.on && this.meshes.length > 0;
    if (this.box.isEmpty()) return;
    const c = this.box.getCenter(new THREE.Vector3());
    const size = this.box.getSize(new THREE.Vector3()).length() * 1.5 + 1;
    this.cap.position.copy(c).addScaledVector(this.n, this.d - c.dot(this.n));
    this.cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.n);
    this.cap.scale.set(size, size, 1);
    const spacing = Math.max(size / 1.5 / 40, 0.4); // hatch lines in mm, a share of the model
    this.tex.repeat.set(size / spacing, size / spacing);
  }

  private paint() {
    const canvas = this.tex.image as HTMLCanvasElement;
    const g = canvas.getContext("2d")!;
    const base = new THREE.Color(this.colors[0]).multiplyScalar(0.82);
    g.fillStyle = `#${base.getHexString()}`;
    g.fillRect(0, 0, 32, 32);
    g.strokeStyle = `#${new THREE.Color(this.colors[1]).getHexString()}`;
    g.globalAlpha = 0.55;
    g.lineWidth = 3;
    g.beginPath();
    for (const o of [-32, 0, 32]) g.moveTo(o, 32), g.lineTo(o + 32, 0); // 45°, seamless when tiled
    g.stroke();
    this.tex.needsUpdate = true;
  }
}
