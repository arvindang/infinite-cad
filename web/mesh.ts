// Kernel meshes -> three.js bodies laid out for fast highlighting.
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import type { BodyMesh } from "../src/geometry.ts";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface Body {
  id: string; // part id
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  triRef: Uint32Array; // per sorted triangle: index into refs
  refs: string[];
  range: { start: number; count: number }[]; // per ref: vertex range in the sorted, non-indexed buffer
  color: THREE.BufferAttribute;
  source: BodyMesh; // the welded kernel mesh, for exports that want shared vertices
}

const CREASE = THREE.MathUtils.degToRad(30); // normals: smooth across shallower angles
const FEATURE_EDGE = Math.cos(THREE.MathUtils.degToRad(20)); // lines: sharper than this, or where refs meet

/**
 * Sorts triangles by ref so every ref is one contiguous vertex range (a highlight is one
 * range write), de-indexes, makes creased normals, feature lines and a BVH for picking.
 */
export function toBody(m: BodyMesh, material: THREE.Material, edgeMaterial: THREE.LineBasicMaterial): Body {
  const tris = m.indices.length / 3;
  const counts = new Uint32Array(m.refs.length);
  for (let t = 0; t < tris; t++) counts[m.triRef[t]]++;
  const range: Body["range"] = [];
  let acc = 0;
  for (let r = 0; r < m.refs.length; r++) {
    range.push({ start: acc * 3, count: counts[r] * 3 });
    acc += counts[r];
  }
  const cursor = range.map((r) => r.start / 3);
  const pos = new Float32Array(tris * 9);
  const triRef = new Uint32Array(tris);
  for (let t = 0; t < tris; t++) {
    const r = m.triRef[t];
    const o = cursor[r]++;
    triRef[o] = r;
    for (let k = 0; k < 3; k++) {
      const v = m.indices[t * 3 + k];
      pos[o * 9 + k * 3] = m.positions[v * 3];
      pos[o * 9 + k * 3 + 1] = m.positions[v * 3 + 1];
      pos[o * 9 + k * 3 + 2] = m.positions[v * 3 + 2];
    }
  }
  let geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo = toCreasedNormals(geo, CREASE);
  const color = new THREE.BufferAttribute(new Uint8Array(tris * 9), 3, true);
  color.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("color", color);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.computeBoundsTree();
  const mesh = new THREE.Mesh(geo, material);
  const edges = new THREE.LineSegments(featureEdges(m), edgeMaterial);
  return { id: m.bodyId, mesh, edges, triRef, refs: m.refs, range, color, source: m };
}

/** Lines where faces fold by more than 20°, or where two refs meet (even flush). Manifold meshes are welded, so each edge has exactly two triangles. */
function featureEdges(m: BodyMesh): THREE.BufferGeometry {
  const { positions: p, indices: ix, triRef } = m;
  const tris = ix.length / 3;
  const normals = new Float32Array(tris * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    a.fromArray(p, ix[t * 3] * 3);
    b.fromArray(p, ix[t * 3 + 1] * 3);
    c.fromArray(p, ix[t * 3 + 2] * 3);
    c.sub(b).cross(a.sub(b)).normalize();
    normals[t * 3] = c.x; normals[t * 3 + 1] = c.y; normals[t * 3 + 2] = c.z;
  }
  const first = new Map<number, number>(); // edge key -> triangle
  const nv = p.length / 3;
  const out: number[] = [];
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const v0 = ix[t * 3 + k], v1 = ix[t * 3 + ((k + 1) % 3)];
      const key = v0 < v1 ? v0 * nv + v1 : v1 * nv + v0;
      const o = first.get(key);
      if (o === undefined) {
        first.set(key, t);
        continue;
      }
      first.delete(key);
      const dot = normals[t * 3] * normals[o * 3] + normals[t * 3 + 1] * normals[o * 3 + 1] + normals[t * 3 + 2] * normals[o * 3 + 2];
      if (dot < FEATURE_EDGE || triRef[t] !== triRef[o]) out.push(p[v0 * 3], p[v0 * 3 + 1], p[v0 * 3 + 2], p[v1 * 3], p[v1 * 3 + 1], p[v1 * 3 + 2]);
    }
  }
  // unpaired edges (shouldn't happen on a manifold) still get drawn
  for (const key of first.keys()) {
    const v0 = Math.floor(key / nv), v1 = key % nv;
    out.push(p[v0 * 3], p[v0 * 3 + 1], p[v0 * 3 + 2], p[v1 * 3], p[v1 * 3 + 1], p[v1 * 3 + 2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  return g;
}

export function disposeBody(b: Body) {
  b.mesh.geometry.disposeBoundsTree?.();
  b.mesh.geometry.dispose();
  b.edges.geometry.dispose();
}
