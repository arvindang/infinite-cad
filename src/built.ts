// Geometry in the Worker isolate: builds cached per <model>:<version>, facts for refs, comment anchors.
// Worker only (manifold WASM); the Durable Object never builds.

import type { FactsSnapshot } from "./collab.ts";
import { ToolError } from "./model-file.ts";
import { type CadDoc, parseRef, rolesOf } from "./schema.ts";
import { findFeature, refProblem } from "./tree.ts";
import { type BuildResult, build } from "./geometry.ts";
import { type FactIndex, dependencies, indexFacts, resolve as resolveRef, snapshotFacts, sourceSnapshot } from "./facts.ts";
import { loadManifold } from "./manifold-worker.ts";

export interface Built {
  res: BuildResult;
  facts: FactIndex;
}

/** Versions are immutable, so a build is cached by <model>:<version> with no invalidation. */
const builds = new Map<string, Built>();
const BUILD_CACHE = 16;

/** Build a version's geometry, or null if the kernel can't run here (resolve then answers from the source alone). */
export async function buildFor(modelId: string, version: number, doc: CadDoc): Promise<Built | null> {
  const key = `${modelId}:${version}`;
  const hit = builds.get(key);
  if (hit) {
    builds.delete(key);
    builds.set(key, hit);
    return hit;
  }
  try {
    const w = await loadManifold();
    const res = build(w, doc);
    const out = { res, facts: indexFacts(res) };
    builds.set(key, out);
    while (builds.size > BUILD_CACHE) builds.delete(builds.keys().next().value!);
    return out;
  } catch (e) {
    console.error("geometry unavailable", e);
    return null;
  }
}

export const buildWarnings = (b: Built | null) =>
  b ? [...b.res.issues.map((i) => `${i.path}: ${i.message}`), ...b.res.errors.map((e) => `${e.featureId}: ${e.message}`)] : [];

/** What a ref means when there's no kernel: the source, its roles and the dependency graph. */
export function sourceOnly(doc: CadDoc, refStr: string): Record<string, unknown> {
  const r = parseRef(refStr)!;
  const part = doc.parts.find((p) => p.id === r.id);
  if (part) return { kind: "part", features: part.features.map((f) => f.id) };
  const loc = findFeature(doc, r.id)!;
  const { dependsOn, dependents } = dependencies(doc, r.id);
  return {
    kind: r.role ? "face" : "feature",
    part: loc.part.id,
    feature: r.id,
    type: loc.feature.type,
    ...(r.role ? { role: r.role } : { roles: rolesOf(loc.feature) }),
    dependsOn,
    dependents,
    source: loc.feature,
  };
}

/** Kernel resolve, with its geometry status renamed to `presence` so `status` stays the link's status. */
export function factsFor(doc: CadDoc, b: Built | null, refStr: string): { ok: boolean; out: Record<string, unknown> } {
  if (!b) return { ok: true, out: sourceOnly(doc, refStr) };
  const { status: presence, ref: _ref, ...rest } = resolveRef(doc, b.res, b.facts, refStr) as Record<string, unknown>;
  if (rest.kind === "unknown") return { ok: false, out: rest };
  return { ok: true, out: { ...rest, ...(presence ? { presence } : {}) } };
}

/** The facts kept with a comment pinned to `ref` at `version`. Throws if the ref isn't in that tree. */
export async function anchorFacts(modelId: string, version: number, doc: CadDoc, ref: string): Promise<FactsSnapshot | null> {
  const problem = refProblem(doc, ref);
  if (problem) throw new ToolError(`Can't pin a comment to "${ref}": ${problem} in v${version}.`);
  return snapshotOf(modelId, version, doc, ref);
}

/** A ref's facts snapshot at a version, or null if it doesn't resolve there. */
export async function snapshotOf(modelId: string, version: number, doc: CadDoc, ref: string): Promise<FactsSnapshot | null> {
  if (refProblem(doc, ref)) return null;
  const b = await buildFor(modelId, version, doc);
  return b ? snapshotFacts(resolveRef(doc, b.res, b.facts, ref)) : sourceSnapshot(doc, ref);
}
