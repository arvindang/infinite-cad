// Pure tree operations: canonical JSON, lookup, diff, scoped edits (applyOps), did-you-mean.
// Runs in the Durable Object, the Worker and the browser: no DOM, no node, no WASM.

import { type CadDoc, type Feature, type Issue, type Part, ID_RE, parseRef, validate } from "./schema.ts";

// ---------- canonical JSON ----------

const KEY_ORDER = [
  "units", "parts", "id", "name", "type", "op", "at", "position", "rotation",
  "size", "diameter", "diameterTop", "height", "depth", "points", "edges", "angle", "center",
  "pattern", "linear", "grid", "circular", "count", "step", "note", "features",
];
const rank = (k: string) => { const i = KEY_ORDER.indexOf(k); return i < 0 ? KEY_ORDER.length : i; };

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

/** Compact JSON with a stable key order (id/type/op/at first, then params). Works on any value. */
export function canonical(doc: unknown): string {
  return JSON.stringify(sortKeys(doc));
}

// ---------- lookup ----------

export interface FeatureLocation {
  feature: Feature;
  part: Part;
  partIndex: number;
  index: number;
}

export function findFeature(doc: CadDoc, id: string): FeatureLocation | undefined {
  const parts = doc.parts ?? [];
  for (let pi = 0; pi < parts.length; pi++) {
    const i = (parts[pi].features ?? []).findIndex((f) => f.id === id);
    if (i >= 0) return { feature: parts[pi].features[i], part: parts[pi], partIndex: pi, index: i };
  }
  return undefined;
}

/** Part ids then feature ids, in document order. */
export function allIds(doc: CadDoc): string[] {
  const parts = doc.parts ?? [];
  return [...parts.map((p) => p.id), ...parts.flatMap((p) => (p.features ?? []).map((f) => f.id))];
}

// ---------- diff ----------

export interface TreeDiff { added: string[]; changed: string[]; removed: string[] }

/**
 * By id. A feature is "changed" when its canonical JSON or its part differs; a part when its name
 * does (feature membership shows up as added/removed features). Reordering alone isn't reported.
 */
export function diff(prev: CadDoc, next: CadDoc): TreeDiff {
  const key = (d: CadDoc) => {
    const m = new Map<string, string>();
    for (const p of d.parts ?? []) {
      m.set(p.id, canonical({ part: true, name: p.name }));
      for (const f of p.features ?? []) m.set(f.id, canonical({ part: p.id, f }));
    }
    return m;
  };
  const a = key(prev), b = key(next);
  const out: TreeDiff = { added: [], changed: [], removed: [] };
  for (const [id, v] of b) {
    if (!a.has(id)) out.added.push(id);
    else if (a.get(id) !== v) out.changed.push(id);
  }
  for (const id of a.keys()) if (!b.has(id)) out.removed.push(id);
  return out;
}

// ---------- applyOps ----------

export type EditOp =
  | { op: "update"; id: string; set: Record<string, unknown> }
  | { op: "replace"; id: string; feature: Feature }
  | { op: "add"; feature: Feature; part?: string; after?: string }
  | { op: "add_part"; part: Part }
  | { op: "remove"; id: string }
  | { op: "rename"; id: string; to: string };

export type ApplyResult =
  | {
      ok: true;
      doc: CadDoc;
      /** Added or modified ids (features and parts), including features whose `at` a rename rewrote. */
      changed: string[];
      /** old id -> final id, chains collapsed (a->b, b->c gives a->c). */
      renames: Record<string, string>;
      /** Ids that are gone and weren't renamed. */
      removed: string[];
    }
  | { ok: false; issues: Issue[] };

/** RFC 7396 JSON merge patch: null deletes, objects merge, everything else (arrays too) replaces. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> =
    target && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

function opLabel(op: EditOp, i: number): string {
  const id = "id" in op ? op.id : op.op === "add" ? op.feature?.id : op.op === "add_part" ? op.part?.id : undefined;
  return `op ${i} (${op?.op ?? "?"}${id ? ` "${id}"` : ""})`;
}

/**
 * Applies ops in order to a copy of doc, then validates the result once. All or nothing: any
 * failure returns every issue (each prefixed with the op it came from) and leaves doc untouched.
 */
export function applyOps(doc: CadDoc, ops: EditOp[]): ApplyResult {
  const next: CadDoc = structuredClone(doc);
  next.parts ??= [];
  const issues: Issue[] = [];
  const touched = new Map<string, number>(); // id -> last op index that touched it
  const removedBy = new Map<string, number>();
  const renames: Record<string, string> = {};
  const fail = (i: number, message: string) => issues.push({ path: `ops[${i}]`, code: "bad_op", message: `${opLabel(ops[i], i)}: ${message}` });
  const exists = (id: string) => allIds(next).includes(id);
  const hint = (id: string) => { const s = didYouMean(next, id); return s.length ? ` (did you mean ${s.map((x) => `"${x}"`).join(", ")}?)` : ""; };

  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, issues: [{ path: "ops", code: "bad_op", message: "ops must be a non-empty array" }] };

  ops.forEach((op, i) => {
    switch (op?.op) {
      case "update": {
        const loc = findFeature(next, op.id);
        if (!loc) return fail(i, `no feature "${op.id}"${hint(op.id)}`);
        if (!op.set || typeof op.set !== "object" || Array.isArray(op.set)) return fail(i, "set must be an object of fields to change");
        if ("id" in op.set || "type" in op.set) return fail(i, `set can't change id or type; use rename for the id, replace for the type`);
        loc.part.features[loc.index] = mergePatch(loc.feature, op.set) as Feature;
        touched.set(op.id, i);
        return;
      }
      case "replace": {
        const loc = findFeature(next, op.id);
        if (!loc) return fail(i, `no feature "${op.id}"${hint(op.id)}`);
        if (!op.feature || typeof op.feature !== "object") return fail(i, "feature must be the whole new feature object");
        if (op.feature.id != null && op.feature.id !== op.id) return fail(i, `feature.id "${op.feature.id}" must equal id "${op.id}" (use rename to change ids)`);
        loc.part.features[loc.index] = { ...op.feature, id: op.id };
        touched.set(op.id, i);
        return;
      }
      case "add": {
        const f = op.feature;
        if (!f || typeof f !== "object") return fail(i, "feature is required");
        if (typeof f.id === "string" && exists(f.id)) return fail(i, `id "${f.id}" is already used`);
        let part: Part | undefined;
        let at = -1;
        if (op.after != null) {
          const loc = findFeature(next, op.after);
          if (!loc) return fail(i, `after: no feature "${op.after}"${hint(op.after)}`);
          if (op.part != null && op.part !== loc.part.id) return fail(i, `after "${op.after}" is in part "${loc.part.id}", not "${op.part}"`);
          part = loc.part;
          at = loc.index + 1;
        } else if (op.part != null) {
          part = next.parts.find((p) => p.id === op.part);
          if (!part) return fail(i, `no part "${op.part}"${hint(op.part)}`);
        } else if (next.parts.length === 1) part = next.parts[0];
        else if (next.parts.length === 0) return fail(i, `the model has no parts yet; add one with {"op": "add_part", "part": {"id": …, "features": [...]}}`);
        else return fail(i, `the model has ${next.parts.length} parts; say which with part (${next.parts.map((p) => p.id).join(", ")})`);
        part.features ??= [];
        if (at < 0) part.features.push(f); else part.features.splice(at, 0, f);
        touched.set(f.id, i);
        return;
      }
      case "add_part": {
        const p = op.part;
        if (!p || typeof p !== "object") return fail(i, "part is required: {id, name?, features: [...]}");
        if (typeof p.id === "string" && exists(p.id)) return fail(i, `id "${p.id}" is already used`);
        next.parts.push(p);
        touched.set(p.id, i);
        for (const f of p.features ?? []) touched.set(f?.id, i);
        return;
      }
      case "remove": {
        const pi = next.parts.findIndex((p) => p.id === op.id);
        if (pi >= 0) {
          for (const f of next.parts[pi].features ?? []) removedBy.set(f.id, i);
          next.parts.splice(pi, 1);
          removedBy.set(op.id, i);
          return;
        }
        const loc = findFeature(next, op.id);
        if (!loc) return fail(i, `no feature or part "${op.id}"${hint(op.id)}`);
        loc.part.features.splice(loc.index, 1);
        removedBy.set(op.id, i);
        return;
      }
      case "rename": {
        if (typeof op.to !== "string" || !ID_RE.test(op.to)) return fail(i, `to ${JSON.stringify(op.to)} must be a lowercase slug (a-z, 0-9, -), starting with a letter`);
        if (op.to === op.id) return fail(i, "to is the same as id");
        if (exists(op.to)) return fail(i, `id "${op.to}" is already used`);
        const part = next.parts.find((p) => p.id === op.id);
        const loc = part ? undefined : findFeature(next, op.id);
        if (!part && !loc) return fail(i, `no feature or part "${op.id}"${hint(op.id)}`);
        if (part) part.id = op.to;
        else {
          loc!.feature.id = op.to;
          // Rewrite every `at` that points at it, keeping instance and role.
          for (const p of next.parts) for (const f of p.features ?? []) {
            const r = typeof f.at === "string" ? parseRef(f.at) : null;
            if (r?.id === op.id) {
              f.at = `${op.to}${r.instance ? `:${r.instance}` : ""}${r.role ? `.${r.role}` : ""}`;
              touched.set(f.id, i);
            }
          }
        }
        // Collapse chains: anything that was renamed to op.id now points at op.to.
        let origin = op.id;
        for (const [from, to] of Object.entries(renames)) if (to === op.id) origin = from;
        if (origin !== op.id) delete renames[origin];
        renames[origin] = op.to;
        touched.set(op.to, i);
        return;
      }
      default:
        return fail(i, `unknown op ${JSON.stringify((op as { op?: unknown })?.op)} (expected update, replace, add, add_part, remove, rename)`);
    }
  });
  if (issues.length) return { ok: false, issues };

  // Validate once, then attribute each issue to the op that caused it.
  for (const iss of validate(next)) {
    const id = idAtPath(next, iss.path);
    const atId = iss.path.endsWith(".at") && id ? parseRef(String(findFeature(next, id)?.feature.at ?? ""))?.id : undefined;
    if (atId != null && removedBy.has(atId) && !exists(atId)) {
      const i = removedBy.get(atId)!;
      issues.push({ ...iss, message: `${opLabel(ops[i], i)}: "${id}" is placed on ${findFeature(next, id!)?.feature.at} (at); remove or re-place it in the same edit. ${iss.message}` });
    } else if (id != null && touched.has(id)) {
      const i = touched.get(id)!;
      issues.push({ ...iss, message: `${opLabel(ops[i], i)}: ${iss.message}` });
    } else issues.push(iss);
  }
  if (issues.length) return { ok: false, issues };

  const d = diff(doc, next);
  const renamedFrom = new Set(Object.keys(renames));
  return { ok: true, doc: next, changed: [...d.added, ...d.changed], renames, removed: d.removed.filter((id) => !renamedFrom.has(id)) };
}

/** The part or feature id an issue path like "parts[1].features[3].at" points into. */
function idAtPath(doc: CadDoc, path: string): string | undefined {
  const m = /^parts\[(\d+)\](?:\.features\[(\d+)\])?/.exec(path);
  if (!m) return undefined;
  const p = doc.parts?.[Number(m[1])];
  return m[2] != null ? p?.features?.[Number(m[2])]?.id : p?.id;
}

// ---------- did you mean ----------

function lev(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

/** Up to 3 existing ids close to `id` (edit distance, prefix or substring). */
export function didYouMean(doc: CadDoc, id: string): string[] {
  const q = String(id ?? "").toLowerCase();
  if (!q) return [];
  return allIds(doc)
    .map((c) => ({ c, d: lev(q, c) - (c.startsWith(q) || q.startsWith(c) ? 1.5 : c.includes(q) || q.includes(c) ? 1 : 0) }))
    .filter((x) => x.c !== q && x.d <= Math.max(2, Math.floor(q.length / 3)))
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))
    .slice(0, 3)
    .map((x) => x.c);
}
