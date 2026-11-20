// Client-side exports of the built bodies. Everything is a mesh: the kernel is manifold, so STEP is
// a faceted B-rep (one planar face per triangle), not analytic surfaces.
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { Body } from "./mesh";

export interface ExportFormat {
  id: "stl" | "3mf" | "step" | "glb" | "obj";
  label: string;
  ext: string;
  note: string;
}

export const FORMATS: ExportFormat[] = [
  { id: "stl", label: "STL", ext: "stl", note: "3D printing · mm" },
  { id: "3mf", label: "3MF", ext: "3mf", note: "Slicers · parts and mm kept" },
  { id: "step", label: "STEP", ext: "step", note: "CAD import · faceted solid, mm" },
  { id: "glb", label: "GLB", ext: "glb", note: "Web, AR, Blender · metres, Y up" },
  { id: "obj", label: "OBJ", ext: "obj", note: "Mesh tools · mm" },
];

export async function exportBodies(fmt: ExportFormat["id"], bodies: Body[], name: string): Promise<Blob> {
  switch (fmt) {
    case "stl": return toStl(bodies);
    case "3mf": return to3mf(bodies);
    case "step": return toStep(bodies, name);
    case "glb": return toGlb(bodies, name);
    case "obj": return toObj(bodies, name);
  }
}

/** Binary STL of the given bodies, in mm. */
function toStl(bodies: Body[]): Blob {
  const tris = bodies.reduce((n, b) => n + b.triRef.length, 0);
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  const header = "Infinite CAD binary STL, units mm";
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, tris, true);
  let o = 84;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  for (const body of bodies) {
    const p = body.mesh.geometry.attributes.position.array as Float32Array;
    for (let t = 0; t < body.triRef.length; t++) {
      a.fromArray(p, t * 9); b.fromArray(p, t * 9 + 3); c.fromArray(p, t * 9 + 6);
      n.subVectors(c, b).cross(e.subVectors(a, b)).normalize();
      for (const v of [n, a, b, c]) {
        dv.setFloat32(o, v.x, true); dv.setFloat32(o + 4, v.y, true); dv.setFloat32(o + 8, v.z, true);
        o += 12;
      }
      o += 2; // attribute byte count
    }
  }
  return new Blob([buf], { type: "model/stl" });
}

/** Wavefront OBJ, one object per part, shared vertices, mm. */
function toObj(bodies: Body[], name: string): Blob {
  const out: string[] = [`# ${ascii(name)} · Infinite CAD · units mm`];
  let base = 1;
  for (const { id, source: m } of bodies) {
    out.push(`o ${ascii(id) || "part"}`);
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) out.push(`v ${num(p[i])} ${num(p[i + 1])} ${num(p[i + 2])}`);
    const ix = m.triVerts;
    for (let t = 0; t < ix.length; t += 3) out.push(`f ${ix[t] + base} ${ix[t + 1] + base} ${ix[t + 2] + base}`);
    base += p.length / 3;
  }
  return new Blob([out.join("\n") + "\n"], { type: "model/obj" });
}

/** 3MF: one object per part, millimetres. A stored (uncompressed) zip. */
function to3mf(bodies: Body[]): Blob {
  const objects: string[] = [];
  const items: string[] = [];
  bodies.forEach(({ id, source: m }, k) => {
    const p = m.positions, ix = m.triVerts;
    const verts: string[] = [], tris: string[] = [];
    for (let i = 0; i < p.length; i += 3) verts.push(`<vertex x="${num(p[i])}" y="${num(p[i + 1])}" z="${num(p[i + 2])}"/>`);
    for (let t = 0; t < ix.length; t += 3) tris.push(`<triangle v1="${ix[t]}" v2="${ix[t + 1]}" v3="${ix[t + 2]}"/>`);
    objects.push(`<object id="${k + 1}" name="${xml(id)}" type="model"><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`);
    items.push(`<item objectid="${k + 1}"/>`);
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">Infinite CAD</metadata>
<resources>${objects.join("\n")}</resources>
<build>${items.join("")}</build>
</model>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return zip([["[Content_Types].xml", types], ["_rels/.rels", rels], ["3D/3dmodel.model", model]], "model/3mf");
}

/** GLB in glTF's conventions (metres, Y up), one node per part. */
async function toGlb(bodies: Body[], name: string): Promise<Blob> {
  const root = new THREE.Group();
  root.name = name;
  root.rotation.x = -Math.PI / 2; // Z up -> Y up
  root.scale.setScalar(0.001); // mm -> m
  const material = new THREE.MeshStandardMaterial({ color: 0xc4c7cc, roughness: 0.85, metalness: 0 });
  material.name = "part";
  const geos: THREE.BufferGeometry[] = [];
  for (const b of bodies) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", b.mesh.geometry.attributes.position);
    g.setAttribute("normal", b.mesh.geometry.attributes.normal);
    geos.push(g);
    const mesh = new THREE.Mesh(g, material);
    mesh.name = b.id;
    root.add(mesh);
  }
  try {
    const glb = (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
    return new Blob([glb], { type: "model/gltf-binary" });
  } finally {
    for (const g of geos) g.dispose();
    material.dispose();
  }
}

/**
 * STEP AP203 faceted B-rep: per part a FACETED_BREP whose faces are planar FACE_SURFACEs bounded by
 * POLY_LOOPs, in mm. CAD tools import it as a solid, but every triangle is its own face.
 */
function toStep(bodies: Body[], name: string): Blob {
  const lines: string[] = [];
  let n = 0;
  const add = (s: string) => (lines.push(`#${++n}=${s};`), n);
  const title = str(name || "model");

  const appCtx = add(`APPLICATION_CONTEXT('configuration controlled 3D designs of mechanical parts and assemblies')`);
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','config_control_design',1994,#${appCtx})`);
  const mechCtx = add(`MECHANICAL_CONTEXT('',#${appCtx},'mechanical')`);
  const product = add(`PRODUCT(${title},${title},'',(#${mechCtx}))`);
  const formation = add(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${product},.NOT_KNOWN.)`);
  const designCtx = add(`DESIGN_CONTEXT('',#${appCtx},'design')`);
  const def = add(`PRODUCT_DEFINITION('design','',#${formation},#${designCtx})`);
  const defShape = add(`PRODUCT_DEFINITION_SHAPE('','',#${def})`);
  const mm = add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const rad = add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const sr = add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const tol = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-04),#${mm},'distance_accuracy_value','')`);
  const geoCtx = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${tol}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${mm},#${rad},#${sr}))REPRESENTATION_CONTEXT('',''))`);
  const origin = add(`CARTESIAN_POINT('',(0.,0.,0.))`);
  const placement = add(`AXIS2_PLACEMENT_3D('',#${origin},$,$)`);

  const breps: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3(), ref = new THREE.Vector3();
  for (const { id, source: m } of bodies) {
    const p = m.positions, ix = m.triVerts;
    const pts = new Int32Array(p.length / 3);
    for (let v = 0; v < pts.length; v++) pts[v] = add(`CARTESIAN_POINT('',(${real(p[v * 3])},${real(p[v * 3 + 1])},${real(p[v * 3 + 2])}))`);
    const faces: number[] = [];
    for (let t = 0; t < ix.length; t += 3) {
      a.fromArray(p, ix[t] * 3); b.fromArray(p, ix[t + 1] * 3); c.fromArray(p, ix[t + 2] * 3);
      ref.subVectors(b, a);
      nrm.crossVectors(ref, c.sub(a));
      if (nrm.lengthSq() < 1e-18 || ref.lengthSq() < 1e-18) continue; // sliver: no plane to put it on
      nrm.normalize(); ref.normalize();
      const dn = add(`DIRECTION('',(${real(nrm.x)},${real(nrm.y)},${real(nrm.z)}))`);
      const dr = add(`DIRECTION('',(${real(ref.x)},${real(ref.y)},${real(ref.z)}))`);
      const ax = add(`AXIS2_PLACEMENT_3D('',#${pts[ix[t]]},#${dn},#${dr})`);
      const plane = add(`PLANE('',#${ax})`);
      const loop = add(`POLY_LOOP('',(#${pts[ix[t]]},#${pts[ix[t + 1]]},#${pts[ix[t + 2]]}))`);
      const bound = add(`FACE_OUTER_BOUND('',#${loop},.T.)`);
      faces.push(add(`FACE_SURFACE('',(#${bound}),#${plane},.T.)`));
    }
    const shell = add(`CLOSED_SHELL('',(${faces.map((f) => `#${f}`).join(",")}))`);
    breps.push(add(`FACETED_BREP(${str(id)},#${shell})`));
  }
  const rep = add(`FACETED_BREP_SHAPE_REPRESENTATION(${title},(#${placement},${breps.map((x) => `#${x}`).join(",")}),#${geoCtx})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${defShape},#${rep})`);

  const stamp = new Date().toISOString().slice(0, 19);
  const head = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('Infinite CAD faceted model, units mm'),'2;1');",
    `FILE_NAME(${title},'${stamp}',(''),(''),'Infinite CAD','Infinite CAD','');`,
    "FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));",
    "ENDSEC;",
    "DATA;",
  ];
  return new Blob([[...head, ...lines, "ENDSEC;", "END-ISO-10303-21;", ""].join("\n")], { type: "model/step" });
}

// ---------- helpers ----------
const num = (x: number) => String(Math.abs(x) < 1e-9 ? 0 : +x.toPrecision(9));
/** A STEP REAL: always has a decimal point in the mantissa. */
function real(x: number): string {
  const s = num(x).replace("e", "E");
  if (s.includes(".")) return s;
  const e = s.indexOf("E");
  return e < 0 ? `${s}.` : `${s.slice(0, e)}.${s.slice(e)}`;
}
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "_");
const str = (s: string) => `'${ascii(s).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(d: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip with every entry stored, no compression. */
function zip(files: [string, string][], type: string): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of files) {
    const name = enc.encode(path), data = enc.encode(text), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // utf-8 names
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type });
}
