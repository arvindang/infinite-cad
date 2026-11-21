// Infinite CAD feature tree: types, ref parsing, roles and validation.
// Environment-neutral: no DOM, no node APIs, no WASM.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Op = "union" | "subtract" | "intersect";

export interface CadDoc {
  units?: "mm";
  parts: Part[];
}

export interface Part {
  id: string;
  name?: string;
  features: Feature[];
}

export interface Pattern {
  linear?: { count: number; step: Vec3 };
  grid?: { count: [number, number]; step: Vec2 };
  circular?: { count: number; angle?: number; center?: Vec2 };
}

interface FeatureBase {
  id: string;
  op?: Op;
  /** Face ref ("base.top") whose frame position/rotation/pattern are expressed in. */
  at?: string;
  position?: Vec3;
  /** Degrees, applied X then Y then Z. */
  rotation?: Vec3;
  pattern?: Pattern;
  note?: string;
}

export interface BoxFeature extends FeatureBase { type: "box"; size: Vec3; center?: boolean }
export interface CylinderFeature extends FeatureBase {
  type: "cylinder"; height: number; diameter: number; diameterTop?: number; center?: boolean;
}
export interface SphereFeature extends FeatureBase { type: "sphere"; diameter: number }
export interface ExtrudeFeature extends FeatureBase {
  type: "extrude"; points: Vec2[]; height: number; edges?: (string | null)[]; arcs?: (number | null)[]; center?: boolean;
}
export interface RevolveFeature extends FeatureBase {
  type: "revolve"; points: Vec2[]; angle?: number; edges?: (string | null)[]; arcs?: (number | null)[];
}
export interface HoleFeature extends FeatureBase {
  type: "hole"; diameter: number; depth?: number;
}

export type Feature =
  | BoxFeature | CylinderFeature | SphereFeature | ExtrudeFeature | RevolveFeature | HoleFeature;
export type FeatureType = Feature["type"];

export const FEATURE_TYPES: FeatureType[] = ["box", "cylinder", "sphere", "extrude", "revolve", "hole"];

export function emptyDoc(): CadDoc {
  return { units: "mm", parts: [] };
}

/** The tree format in brief, for the MCP CONTRACT and create_model. Keep it under ~1.5 KB. */
export function schemaDoc(): string {
  return `Tree: {"units":"mm","parts":[{"id","name"?,"features":[...]}]}. Each part is one solid. Ids: lowercase slugs, unique in the file.
Features build in order. The first starts the part; later ones apply "op": "union" (default), "subtract" or "intersect" ("hole" always subtracts).
Types and face roles:
- box {size:[x,y,z]}: top bottom front(-Y) back(+Y) left(-X) right(+X)
- cylinder {diameter, height, diameterTop?}: top bottom side
- sphere {diameter}: surface
- extrude {points:[[x,y],...], height, edges?:[names]}: top bottom, edge i (points[i]->points[i+1]) is edges[i] or side-<i+1>
- revolve {points:[[r,z],...], angle?}: profile edge i is edges[i] or face-<i+1>; start end if angle<360
  arcs?:[r|null] (extrude, revolve): edge i is an arc of radius |r|, r>0 bulges out, r<0 curves in, |r| >= half its length
- hole {diameter, depth?} (no depth = through): wall floor
Placement: +Z up, mm. A primitive's origin is the center of its bottom face (sphere: center); center:true centers it on Z. position:[x,y,z], rotation:[x,y,z] degrees.
"at":"<feature>.<role>" puts position/rotation/pattern in that flat face's frame: origin at the face center, +Z out of the solid (into the void for a cut), X along the target feature's X for top/bottom. Only earlier features in the same part.
pattern (one of): {linear:{count, step:[x,y,z]}}, {grid:{count:[nx,ny], step:[dx,dy]}}, {circular:{count, angle?, center?:[x,y]}}. Instance n (from 1) is <id>:<n>.
Refs: part | feature | feature.role | feature:n.role, e.g. base.top, mount-holes:2.wall.`;
}

// ---------- refs ----------

export const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const REF_RE = /^([a-z][a-z0-9-]{0,47})(?::([1-9][0-9]{0,3}))?(?:\.([a-z][a-z0-9-]{0,47}))?$/;

export interface Ref {
  id: string;
  /** 1-based pattern instance, when given. */
  instance?: number;
  role?: string;
}

export function parseRef(s: string): Ref | null {
  const m = REF_RE.exec(s.trim());
  if (!m) return null;
  return { id: m[1], instance: m[2] ? Number(m[2]) : undefined, role: m[3] };
}

export function formatRef(id: string, instance?: number, role?: string): string {
  return id + (instance ? `:${instance}` : "") + (role ? `.${role}` : "");
}

/** Accepts a full link (https://host/m/<file>#a,b), a bare fragment (#a,b) or "a, b". */
export function parseLink(link: string): { fileId?: string; refs: string[] } {
  let fileId: string | undefined;
  let frag = link.trim();
  const url = /\/m\/([a-z0-9]+)(?:#(.*))?$/.exec(frag);
  if (url) { fileId = url[1]; frag = url[2] ?? ""; }
  frag = decodeURIComponent(frag.replace(/^#/, ""));
  return { fileId, refs: frag.split(",").map((s) => s.trim()).filter(Boolean) };
}

// ---------- roles ----------

export const BOX_ROLES = ["top", "bottom", "front", "back", "left", "right"];

function profileRoles(f: ExtrudeFeature | RevolveFeature, prefix: string): string[] {
  return f.points.map((_, i) => f.edges?.[i] || `${prefix}-${i + 1}`);
}

/** Every role a feature type can produce. Some may be absent in the result (consumed). */
export function rolesOf(f: Feature): string[] {
  switch (f.type) {
    case "box": return BOX_ROLES;
    case "cylinder": return f.diameterTop === 0 ? ["bottom", "side"] : ["top", "bottom", "side"];
    case "sphere": return ["surface"];
    case "extrude": return ["top", "bottom", ...profileRoles(f, "side")];
    case "revolve": {
      const r = profileRoles(f, "face");
      return (f.angle ?? 360) < 360 ? [...r, "start", "end"] : r;
    }
    case "hole": return f.depth == null ? ["wall"] : ["wall", "floor"];
  }
}

/** Index of the profile edge a role names, or -1 for caps and non-profile roles. */
export function profileEdgeIndex(f: Feature, role: string): number {
  if (f.type !== "extrude" && f.type !== "revolve") return -1;
  return profileRoles(f, f.type === "extrude" ? "side" : "face").indexOf(role);
}

/** Roles that are flat and have a placement frame (usable in `at`). */
export function planarRoles(f: Feature): string[] {
  switch (f.type) {
    case "box": return BOX_ROLES;
    case "cylinder": return rolesOf(f).filter((r) => r !== "side");
    case "sphere": return [];
    case "extrude": return rolesOf(f).filter((r) => !f.arcs?.[profileEdgeIndex(f, r)]);
    case "revolve": return [];
    case "hole": return f.depth == null ? [] : ["floor"];
  }
}

export function instanceCount(p?: Pattern): number {
  if (!p) return 1;
  if (p.linear) return p.linear.count;
  if (p.grid) return p.grid.count[0] * p.grid.count[1];
  if (p.circular) return p.circular.count;
  return 1;
}

export function defaultOp(f: Feature, index: number): Op {
  if (f.op) return f.op;
  if (index === 0) return "union";
  return f.type === "hole" ? "subtract" : "union";
}

// ---------- validation ----------

export interface Issue {
  path: string;
  code:
    | "bad_doc" | "bad_id" | "duplicate_id" | "unknown_type" | "bad_param" | "bad_ref"
    | "unknown_ref" | "forward_ref" | "unknown_role" | "not_planar" | "ambiguous_ref"
    | "bad_op" | "too_big" | "empty_result" | "kernel_error";
  message: string;
}

export const LIMITS = { features: 400, instancesPerFeature: 256, totalInstances: 2000, points: 512 };

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isVec = (x: unknown, n: number) => Array.isArray(x) && x.length === n && x.every(isNum);

export interface FeatureIndex {
  feature: Feature;
  partId: string;
  partIndex: number;
  index: number; // position within the part
  order: number; // global build order
}

export function indexDoc(doc: CadDoc): Map<string, FeatureIndex> {
  const map = new Map<string, FeatureIndex>();
  let order = 0;
  doc.parts?.forEach((p, pi) =>
    p.features?.forEach((f, i) => {
      if (!map.has(f?.id)) map.set(f.id, { feature: f, partId: p.id, partIndex: pi, index: i, order });
      order++;
    }),
  );
  return map;
}

/**
 * Structural checks before any geometry runs. Refs must point to earlier features, which makes
 * cycles impossible by construction (the tree is an ordered list, like a CAD history).
 */
export function validate(doc: CadDoc): Issue[] {
  const issues: Issue[] = [];
  const add = (path: string, code: Issue["code"], message: string) => issues.push({ path, code, message });
  if (!doc || !Array.isArray(doc.parts)) {
    add("", "bad_doc", 'expected {"parts": [...]}');
    return issues;
  }
  if (doc.units && doc.units !== "mm") add("units", "bad_param", 'units must be "mm"');

  const seen = new Map<string, string>();
  const claim = (id: unknown, path: string) => {
    if (typeof id !== "string" || !ID_RE.test(id)) {
      add(path, "bad_id", `id ${JSON.stringify(id)} must be a lowercase slug (a-z, 0-9, -), starting with a letter`);
      return;
    }
    const prev = seen.get(id);
    if (prev) add(path, "duplicate_id", `id "${id}" is already used at ${prev}`);
    else seen.set(id, path);
  };

  let total = 0;
  let featureCount = 0;
  const built = new Map<string, { f: Feature; partId: string }>(); // features declared so far
  doc.parts.forEach((part, pi) => {
    const pp = `parts[${pi}]`;
    claim(part?.id, `${pp}.id`);
    if (!Array.isArray(part?.features) || part.features.length === 0) {
      add(`${pp}.features`, "bad_param", `part "${part?.id}" needs at least one feature`);
      return;
    }
    part.features.forEach((f, i) => {
      const fp = `${pp}.features[${i}]`;
      const label = `${f?.type ?? "feature"} "${f?.id}"`;
      featureCount++;
      claim(f?.id, `${fp}.id`);
      if (!FEATURE_TYPES.includes(f?.type)) {
        add(`${fp}.type`, "unknown_type", `unknown type ${JSON.stringify(f?.type)} (expected ${FEATURE_TYPES.join(", ")})`);
        return;
      }
      const pos = (k: string, v: unknown) => {
        if (!isNum(v) || v <= 0) add(`${fp}.${k}`, "bad_param", `${label}: ${k} must be a number > 0 (got ${JSON.stringify(v)})`);
      };
      switch (f.type) {
        case "box":
          if (!isVec(f.size, 3) || f.size.some((v) => v <= 0)) add(`${fp}.size`, "bad_param", `${label}: size must be [x, y, z] with every value > 0`);
          break;
        case "cylinder":
          pos("height", f.height); pos("diameter", f.diameter);
          if (f.diameterTop != null && (!isNum(f.diameterTop) || f.diameterTop < 0)) add(`${fp}.diameterTop`, "bad_param", `${label}: diameterTop must be >= 0`);
          break;
        case "sphere": pos("diameter", f.diameter); break;
        case "hole":
          pos("diameter", f.diameter);
          if (f.depth != null) pos("depth", f.depth);
          if (f.op && f.op !== "subtract") add(`${fp}.op`, "bad_op", `${label}: a hole always subtracts; drop op or use a cylinder`);
          break;
        case "extrude":
        case "revolve": {
          if (!Array.isArray(f.points) || f.points.length < 3 || !f.points.every((p) => isVec(p, 2))) {
            add(`${fp}.points`, "bad_param", `${label}: points must be at least 3 [x, y] pairs`);
            break;
          }
          if (f.points.length > LIMITS.points) add(`${fp}.points`, "too_big", `${label}: at most ${LIMITS.points} points`);
          if (f.type === "extrude") pos("height", f.height);
          const a = signedArea(f.points);
          if (Math.abs(a) < 1e-9) add(`${fp}.points`, "bad_param", `${label}: polygon has zero area`);
          if (f.type === "revolve") {
            if (f.points.some((p) => p[0] < 0)) add(`${fp}.points`, "bad_param", `${label}: revolve profile must have x >= 0 (x is the radius, y the height)`);
            if (f.angle != null && (!isNum(f.angle) || f.angle <= 0 || f.angle > 360)) add(`${fp}.angle`, "bad_param", `${label}: angle must be in (0, 360]`);
          }
          if (f.arcs != null) {
            if (!Array.isArray(f.arcs) || f.arcs.length > f.points.length) {
              add(`${fp}.arcs`, "bad_param", `${label}: arcs gives edge i (points[i] -> points[i+1]) a radius; at most ${f.points.length} entries`);
            } else {
              f.arcs.forEach((r, k) => {
                if (r == null) return;
                const a = f.points[k], b = f.points[(k + 1) % f.points.length];
                const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
                if (!isNum(r) || r === 0) add(`${fp}.arcs[${k}]`, "bad_param", `${label}: arcs[${k}] must be a radius (> 0 bulges out, < 0 curves in) or null for a straight edge`);
                else if (chord < 1e-9) add(`${fp}.arcs[${k}]`, "bad_param", `${label}: arcs[${k}]: edge ${k} has zero length`);
                else if (Math.abs(r) < chord / 2 - 1e-6) add(`${fp}.arcs[${k}]`, "bad_param", `${label}: arcs[${k}]: radius ${Math.abs(r)} is too small for an edge ${+chord.toFixed(4)} long (at least ${+(chord / 2).toFixed(4)}, a half circle)`);
              });
              if (f.type === "revolve" && !issues.some((x) => x.path.startsWith(`${fp}.arcs`))
                && profilePolyline(f.points, f.arcs, 96).points.some((p) => p[0] < -1e-6)) {
                add(`${fp}.arcs`, "bad_param", `${label}: an arc crosses the axis (x < 0); revolve profiles must stay at x >= 0`);
              }
            }
          }
          if (f.edges != null) {
            if (!Array.isArray(f.edges) || f.edges.length > f.points.length) {
              add(`${fp}.edges`, "bad_param", `${label}: edges names edge i (points[i] -> points[i+1]); at most ${f.points.length} entries`);
            } else {
              const names = new Set<string>();
              f.edges.forEach((e, k) => {
                if (e == null) return;
                if (!ID_RE.test(e)) add(`${fp}.edges[${k}]`, "bad_id", `${label}: edge name ${JSON.stringify(e)} must be a lowercase slug`);
                else if (names.has(e) || ["top", "bottom", "start", "end"].includes(e)) add(`${fp}.edges[${k}]`, "duplicate_id", `${label}: edge name "${e}" is used twice or clashes with a cap role`);
                names.add(e);
              });
            }
          }
          break;
        }
      }
      if (f.position != null && !isVec(f.position, 3)) add(`${fp}.position`, "bad_param", `${label}: position must be [x, y, z]`);
      if (f.rotation != null && !isVec(f.rotation, 3)) add(`${fp}.rotation`, "bad_param", `${label}: rotation must be [x, y, z] degrees`);
      if (f.op != null && !["union", "subtract", "intersect"].includes(f.op)) add(`${fp}.op`, "bad_op", `${label}: op must be union, subtract or intersect`);
      if (i === 0 && f.op && f.op !== "union") add(`${fp}.op`, "bad_op", `${label}: the first feature of part "${part.id}" starts the body; it can't ${f.op}`);
      if (i === 0 && f.type === "hole") add(`${fp}.type`, "bad_op", `${label}: a part can't start with a hole`);

      const n = validatePattern(f.pattern, `${fp}.pattern`, label, add);
      total += n;
      if (n > LIMITS.instancesPerFeature) add(`${fp}.pattern`, "too_big", `${label}: at most ${LIMITS.instancesPerFeature} instances`);

      if (f.at != null) validateAt(f, fp, label, part.id, built, add);
      if (!built.has(f.id)) built.set(f.id, { f, partId: part.id });
    });
  });
  // Pattern ids live in the same namespace; also check that edge names don't matter globally (they're per feature).
  if (featureCount > LIMITS.features) add("parts", "too_big", `at most ${LIMITS.features} features per file`);
  if (total > LIMITS.totalInstances) add("parts", "too_big", `at most ${LIMITS.totalInstances} feature instances per file (patterns included)`);
  return issues;
}

function validatePattern(p: Pattern | undefined, path: string, label: string, add: (p: string, c: Issue["code"], m: string) => void): number {
  if (p == null) return 1;
  const kinds = (["linear", "grid", "circular"] as const).filter((k) => p[k] != null);
  if (kinds.length !== 1) {
    add(path, "bad_param", `${label}: pattern needs exactly one of linear, grid, circular`);
    return 1;
  }
  const count = (c: unknown) => Number.isInteger(c) && (c as number) >= 1;
  if (p.linear && (!count(p.linear.count) || !isVec(p.linear.step, 3))) add(`${path}.linear`, "bad_param", `${label}: linear needs {count: integer >= 1, step: [x, y, z]}`);
  if (p.grid && (!Array.isArray(p.grid.count) || !p.grid.count.every(count) || !isVec(p.grid.step, 2))) add(`${path}.grid`, "bad_param", `${label}: grid needs {count: [nx, ny], step: [dx, dy]}`);
  if (p.circular && (!count(p.circular.count) || (p.circular.center != null && !isVec(p.circular.center, 2)) || (p.circular.angle != null && !isNum(p.circular.angle)))) add(`${path}.circular`, "bad_param", `${label}: circular needs {count: integer >= 1, angle?: degrees, center?: [x, y]}`);
  return instanceCount(p);
}

function validateAt(
  f: Feature, fp: string, label: string, partId: string,
  built: Map<string, { f: Feature; partId: string }>,
  add: (p: string, c: Issue["code"], m: string) => void,
) {
  const r = typeof f.at === "string" ? parseRef(f.at) : null;
  if (!r || !r.role) {
    add(`${fp}.at`, "bad_ref", `${label}: at must be a face ref like "base.top" (got ${JSON.stringify(f.at)})`);
    return;
  }
  const target = built.get(r.id);
  if (!target) {
    add(`${fp}.at`, r.id === f.id ? "forward_ref" : "unknown_ref",
      r.id === f.id ? `${label}: at can't refer to itself` : `${label}: at "${f.at}": no earlier feature "${r.id}" (refs must point to features above this one)`);
    return;
  }
  if (target.partId !== partId) {
    add(`${fp}.at`, "bad_ref", `${label}: at "${f.at}" is in part "${target.partId}"; v1 only places on faces of the same part`);
    return;
  }
  const roles = rolesOf(target.f);
  if (!roles.includes(r.role)) {
    add(`${fp}.at`, "unknown_role", `${label}: at "${f.at}": ${target.f.type} "${r.id}" has no role "${r.role}" (roles: ${roles.join(", ")})`);
    return;
  }
  if (!planarRoles(target.f).includes(r.role)) {
    add(`${fp}.at`, "not_planar", `${label}: at "${f.at}" is not a flat face; place on one of: ${planarRoles(target.f).join(", ") || "(none)"}`);
    return;
  }
  const n = instanceCount(target.f.pattern);
  if (n > 1 && r.instance == null) add(`${fp}.at`, "ambiguous_ref", `${label}: "${r.id}" has ${n} instances; use "${r.id}:1.${r.role}" … "${r.id}:${n}.${r.role}"`);
  if (r.instance != null && r.instance > n) add(`${fp}.at`, "unknown_ref", `${label}: "${r.id}" has ${n} instance(s), not ${r.instance}`);
}

// ---------- profiles with arcs ----------

export interface ArcInfo {
  center: Vec2;
  mid: Vec2; // point halfway along the arc
  radius: number;
  sweep: number; // radians, (0, π]
  dir: 1 | -1; // 1 = counter-clockwise from a to b
}

/**
 * Edge a -> b as an arc of signed radius r: r > 0 bulges away from the profile's inside, r < 0
 * curves into it. Always the shorter arc (at most a half circle). `inside` is the sign of the
 * straight-edge profile's signed area (1 = counter-clockwise).
 */
export function arcOf(a: Vec2, b: Vec2, r: number, inside: number): ArcInfo {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const c = Math.hypot(dx, dy), R = Math.abs(r);
  const h = Math.sqrt(Math.max(0, R * R - (c * c) / 4));
  const k = (inside >= 0 ? 1 : -1) * (r > 0 ? 1 : -1); // +1: center toward the inside
  const nx = (-dy / c) * k, ny = (dx / c) * k; // unit normal toward the center
  const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const center: Vec2 = [m[0] + nx * h, m[1] + ny * h];
  const mid: Vec2 = [m[0] - nx * (R - h), m[1] - ny * (R - h)];
  const sweep = 2 * Math.asin(Math.min(1, c / (2 * R)));
  const cr = (a[0] - center[0]) * (mid[1] - center[1]) - (a[1] - center[1]) * (mid[0] - center[0]);
  return { center, mid, radius: R, sweep, dir: cr >= 0 ? 1 : -1 };
}

/** The profile as a polyline (arcs split into chords) and, per polyline segment, its edge index. */
export function profilePolyline(points: Vec2[], arcs: (number | null)[] | undefined, circleSegments: number): { points: Vec2[]; edgeOf: number[] } {
  const out: Vec2[] = [], edgeOf: number[] = [];
  const inside = Math.sign(signedArea(points)) || 1;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], r = arcs?.[i];
    out.push(a); edgeOf.push(i);
    if (!r) continue;
    const arc = arcOf(a, b, r, inside);
    const n = Math.max(2, Math.ceil((circleSegments * arc.sweep) / (2 * Math.PI)));
    const a0 = Math.atan2(a[1] - arc.center[1], a[0] - arc.center[0]);
    for (let j = 1; j < n; j++) {
      const t = a0 + arc.dir * arc.sweep * (j / n);
      out.push([arc.center[0] + arc.radius * Math.cos(t), arc.center[1] + arc.radius * Math.sin(t)]);
      edgeOf.push(i);
    }
  }
  return { points: out, edgeOf };
}

/** Exact area and centroid of a profile with arcs (straight polygon plus or minus circular segments). */
export function profileAreaCentroid(points: Vec2[], arcs?: (number | null)[]): { area: number; centroid: Vec2 } {
  const a = signedArea(points), s = Math.sign(a) || 1;
  let A = Math.abs(a), cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[(i + 1) % points.length];
    const k = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * k; cy += (y0 + y1) * k;
  }
  cx /= 6 * a; cy /= 6 * a;
  let mx = cx * A, my = cy * A;
  arcs?.forEach((r, i) => {
    if (!r) return;
    const p = points[i], q = points[(i + 1) % points.length];
    const arc = arcOf(p, q, r, s);
    const th = arc.sweep, R = arc.radius;
    const segA = ((R * R) / 2) * (th - Math.sin(th));
    if (segA <= 0) return;
    const d = (4 * R * Math.sin(th / 2) ** 3) / (3 * (th - Math.sin(th)));
    const ux = arc.mid[0] - arc.center[0], uy = arc.mid[1] - arc.center[1];
    const ul = Math.hypot(ux, uy) || 1;
    const gx = arc.center[0] + (ux / ul) * d, gy = arc.center[1] + (uy / ul) * d;
    const sign = r > 0 ? 1 : -1;
    A += sign * segA; mx += sign * segA * gx; my += sign * segA * gy;
  });
  return { area: A, centroid: [mx / A, my / A] };
}

export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}
