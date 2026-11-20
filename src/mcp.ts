import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./index.ts";
import { links, newModelId, parseLink } from "./ids.ts";
import { clientFromUserAgent, countryOf, track } from "./analytics.ts";
import { type Alias, type CommitResult, ToolError, checkTree } from "./model-file.ts";
import { type CadDoc, defaultOp, instanceCount, parseRef, formatRef, rolesOf, schemaDoc } from "./schema.ts";
import { type EditOp, allIds, didYouMean, findFeature } from "./tree.ts";
import { type BuildResult, build } from "./geometry.ts";
import { type FactIndex, dependencies, indexFacts, resolve as resolveRef } from "./facts.ts";
import { loadManifold } from "./manifold-worker.ts";

/**
 * The whole contract is structural. It says how models, ids and links work,
 * never what a part should look like.
 */
export const CONTRACT = `Infinite CAD is a 3D part canvas. You build parts by writing a declarative feature tree in JSON; the person inspects the model live in their browser and sends you links that point at the whole model, at parts, at features, or at single faces.

The contract (structural only, the design itself is yours):
1. A model is one feature tree: {"units":"mm","parts":[…]}. Each part is one solid built from an ordered list of features (primitives, holes, booleans, placement on earlier faces). Units are millimetres, angles degrees.
2. Every part and feature has an id you choose: a lowercase slug that says what it is (base, mount-holes, lid-lip). Not its type alone (cylinder-3) and not its history (new-base, base-v2). Ids are the addresses people link to, and they are unique across the model.
3. Ids are stable. Never renumber or rename to tidy up. When you rewrite the whole tree, keep the id of every part and feature that is still the same thing. Rename only when a feature's meaning changes, with edit_features op "rename" (or renames on write_model): old links then follow it. Don't give a removed id to something new.
4. A link like <origin>/m/<model>#base.top,mount-holes:2 points at things: base.top is one face of the feature base (<feature>.<role>), mount-holes:2 is the second instance of a patterned feature, a bare id is a whole feature or part. Refs are comma-separated. ?v=<n> is the version the person was looking at.
5. When a message has a link with #refs, call resolve on it before changing anything. It says what each ref is: the feature's JSON, measured geometry facts, what it depends on and what depends on it, and whether it changed since the person looked.
6. Edit only what's linked. Change the referenced features with edit_features, plus features that depend on them only when the change requires it, and leave everything else as it is. write_model replaces the whole tree: use it for a new model or when the person asks for a broad change.

Workflow: get_model first. To change a model: start_edit (claims it for 10 minutes; the viewer shows your task and highlights the refs you name) → edit_features or write_model with the lock and the base_version it returned. Pass the lock to every call while you hold the claim, and release_edit if you stop without saving. A write is rejected if the tree is invalid (the error lists every problem) or someone saved after your base_version; nothing is applied in either case. Geometry warnings (a cut that empties a part, a feature the kernel couldn't build) come back with each save: fix the ones you didn't intend.

Feature schema:
${schemaDoc()}`;

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** What a tool call reports to analytics. Handlers fill in what only they know. */
interface ToolEvent {
  modelId?: string;
  detail?: string;
  size?: number;
  warnings?: number;
}

/** Errors grouped by cause, so a report can tell conflicts from bad links. Keep error wording in step with this. */
export const errorKind = (message: string) =>
  /didn't pass its lock/i.test(message) ? "no_lock"
  : /being edited by another session|version conflict/i.test(message) ? "conflict"
  : /couldn't read|no refs in that link/i.test(message) ? "bad_link"
  : /^invalid (tree|edit)/i.test(message) ? "invalid"
  : /too large/i.test(message) ? "too_large"
  : /not found/i.test(message) ? "not_found"
  : /was deleted/i.test(message) ? "deleted"
  : "error";

// ---------- geometry, per isolate ----------

interface Built {
  res: BuildResult;
  facts: FactIndex;
}

/** Versions are immutable, so a build is cached by <model>:<version> with no invalidation. */
const builds = new Map<string, Built>();
const BUILD_CACHE = 16;

/** Build a version's geometry, or null if the kernel can't run here (resolve then answers from the source alone). */
async function buildFor(modelId: string, version: number, doc: CadDoc): Promise<Built | null> {
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

const buildWarnings = (b: Built | null) =>
  b ? [...b.res.issues.map((i) => `${i.path}: ${i.message}`), ...b.res.errors.map((e) => `${e.featureId}: ${e.message}`)] : [];

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Per-part stats in a few numbers: what the agent checks after every save. */
const partStats = (doc: CadDoc, b: Built | null) =>
  doc.parts.map((p) => {
    const s = b?.res.parts[p.id];
    return {
      id: p.id,
      ...(p.name ? { name: p.name } : {}),
      features: p.features.length,
      ...(s
        ? {
            volume_mm3: round(s.volume),
            size: s.bbox ? s.bbox.max.map((v, i) => round(v - s.bbox!.min[i])) : null,
            bbox: s.bbox ? { min: s.bbox.min.map(round), max: s.bbox.max.map(round) } : null,
            through_holes: s.genus,
            ...(s.components > 1 ? { components: s.components } : {}),
          }
        : {}),
    };
  });

/** The feature index get_model returns, for scoping edits. */
const featureIndex = (doc: CadDoc, b: Built | null) =>
  doc.parts.flatMap((p) =>
    p.features.map((f, i) => {
      const { dependsOn, dependents } = dependencies(doc, f.id);
      const err = b?.res.features[f.id]?.error;
      const n = instanceCount(f.pattern);
      return {
        id: f.id,
        type: f.type,
        part: p.id,
        op: defaultOp(f, i),
        ...(f.at ? { at: f.at } : {}),
        ...(n > 1 ? { instances: n } : {}),
        depends_on: dependsOn,
        dependents,
        ...(err ? { error: err } : {}),
      };
    }),
  );

/** What a ref means when there's no kernel: the source, its roles and the dependency graph. */
function sourceOnly(doc: CadDoc, refStr: string): Record<string, unknown> {
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
function factsFor(doc: CadDoc, b: Built | null, refStr: string): { ok: boolean; out: Record<string, unknown> } {
  if (!b) return { ok: true, out: sourceOnly(doc, refStr) };
  const { status: presence, ref: _ref, ...rest } = resolveRef(doc, b.res, b.facts, refStr) as Record<string, unknown>;
  if (rest.kind === "unknown") return { ok: false, out: rest };
  return { ok: true, out: { ...rest, ...(presence ? { presence } : {}) } };
}

/** A short line per changed feature or part after a write: did the change land where intended? */
function touched(doc: CadDoc, b: Built | null, ids: string[]) {
  if (!b) return undefined;
  return ids.slice(0, 20).map((id) => {
    const r = resolveRef(doc, b.res, b.facts, id) as Record<string, any>;
    if (r.kind === "part") return { ref: id, kind: "part", volume_mm3: r.volume, size: r.size, through_holes: r.genus };
    if (r.kind !== "feature") return { ref: id, kind: r.kind, message: r.message };
    return {
      ref: id,
      kind: "feature",
      presence: r.status,
      ...(r.error ? { error: r.error } : {}),
      bbox: r.bbox,
      faces_present: `${r.faces.filter((f: { present: boolean }) => f.present).length}/${r.faces.length}`,
      ...(r.touches?.length ? { touches: r.touches } : {}),
    };
  });
}

function buildServer(env: Env, request: Request, ctx: ExecutionContext) {
  const origin = new URL(request.url).origin;
  const client = clientFromUserAgent(request.headers.get("User-Agent"));
  const country = countryOf(request);
  const by = `agent:${client}`;
  const L = links(origin);
  const server = new McpServer({ name: "infinite-cad", version: "0.1.0" }, { instructions: CONTRACT });

  const stubFor = (modelId: string) => env.MODELS.get(env.MODELS.idFromName(modelId));
  const parse = (link: string) => {
    const p = parseLink(link);
    if (!p) throw new ToolError(`Couldn't read "${link}" as an Infinite CAD link. Expected ${origin}/m/<model>[#<feature>[.<face>],…].`);
    return p;
  };

  const wrap =
    <A,>(tool: string, fn: (args: A, ev: ToolEvent) => Promise<ReturnType<typeof text>>) =>
    async (args: A) => {
      const started = Date.now();
      const link = (args as { link?: unknown }).link;
      const ev: ToolEvent = { modelId: typeof link === "string" ? parseLink(link)?.modelId : undefined };
      const report = (detail: string) =>
        ctx.waitUntil(track(env, { event: "tool", name: tool, actor: client, country, ms: Date.now() - started, ...ev, detail }));
      try {
        const result = await fn(args, ev);
        report(ev.detail ?? "ok");
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        report(errorKind(message));
        return fail(message);
      }
    };

  /** What every write returns: the new version, what changed, warnings, and how the parts measure now. */
  const saved = async (modelId: string, res: unknown, ev: ToolEvent, extra: Record<string, unknown> = {}) => {
    const r = res as CommitResult;
    const b = await buildFor(modelId, r.version, r.tree);
    const warnings = [...r.warnings, ...buildWarnings(b)];
    ev.warnings = warnings.length;
    const ids = [...r.added, ...r.changed];
    return text({
      saved: {
        model_link: L.model(modelId),
        version: r.version,
        ...(r.added.length ? { added: r.added } : {}),
        ...(r.changed.length ? { changed: r.changed } : {}),
        ...(r.removed.length ? { removed: r.removed } : {}),
        ...(Object.keys(r.renames).length ? { renamed: r.renames } : {}),
      },
      warnings: warnings.length ? warnings : "none",
      ...(ids.length && b ? { touched: touched(r.tree, b, ids) } : {}),
      parts: partStats(r.tree, b),
      facts_source: b ? "kernel" : "none",
      ...extra,
    });
  };

  // ---------- shared input shapes ----------

  const Link = z.string().describe("Any Infinite CAD link for the model, e.g. <origin>/m/<model>#base.top");
  // Light on purpose: validate() gives exact errors, and a full schema in every tool listing costs tokens.
  const FeatureIn = z.looseObject({ id: z.string(), type: z.string() }).describe("A feature, e.g. {\"id\":\"base\",\"type\":\"box\",\"size\":[80,40,6]}");
  const PartIn = z.looseObject({ id: z.string(), name: z.string().optional(), features: z.array(FeatureIn) });
  const TreeIn = z.looseObject({ units: z.literal("mm").optional(), parts: z.array(PartIn) }).describe('The whole tree: {"units":"mm","parts":[{"id","features":[…]}]}');
  const Lock = z.string().optional().describe("Lock from start_edit. Required while the model is claimed");
  const BaseVersion = z.number().int().min(0).optional().describe("Model version you edited; rejects the write if someone saved since");
  const Summary = z.string().max(200).optional().describe("What changed, in a few words. Shown in the viewer's history");
  const KeepClaim = z.boolean().optional().describe("Keep your claim after saving (e.g. to fix warnings in another call). Default false");
  const Id = z.string().describe("Feature or part id");

  server.registerTool(
    "create_model",
    {
      title: "Create model",
      description:
        "Create a new model and return its link. Share the link with the person so they can watch the viewer. Pass tree to build the first version in the same call; it's rejected (and nothing is created) if it's invalid.",
      inputSchema: {
        name: z.string().min(1).max(120).describe("Human name for the model, e.g. 'Pi 5 wall bracket'"),
        tree: TreeIn.optional(),
      },
    },
    wrap("create_model", async (args: { name: string; tree?: unknown }, ev) => {
      const a = args as { name: string; tree?: CadDoc };
      if (a.tree) checkTree(a.tree);
      const id = newModelId();
      ev.modelId = id;
      ev.detail = a.tree ? "with_tree" : "empty";
      const state = await stubFor(id).init(id, a.name, a.tree, by);
      if (!a.tree) {
        return text({
          model_link: L.model(id),
          name: a.name,
          version: state.version,
          schema: schemaDoc(),
          next: "Share model_link with the person. Build the first tree with write_model.",
        });
      }
      const tree = state.tree as CadDoc;
      const b = await buildFor(id, state.version, tree);
      const warnings = buildWarnings(b);
      ev.warnings = warnings.length;
      return text({
        model_link: L.model(id),
        name: a.name,
        version: state.version,
        warnings: warnings.length ? warnings : "none",
        parts: partStats(tree, b),
        next: "Share model_link with the person.",
      });
    }),
  );

  server.registerTool(
    "get_model",
    {
      title: "Get model",
      description:
        "Read a model: its tree, a feature index (part, op, what each depends on and what depends on it), part measurements, build warnings and recent history. Call this before editing. Pass version to read an older tree (the last 50 are kept).",
      inputSchema: {
        link: Link,
        version: z.number().int().min(0).optional().describe("Read this older version instead of the current one"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("get_model", async (a: { link: string; version?: number }, ev) => {
      const { modelId, refs } = parse(a.link);
      const stub = stubFor(modelId);
      const state = await stub.getState();
      const t = (await stub.getTree(a.version)) as { version: number; tree: CadDoc };
      if (a.version !== undefined) ev.detail = "old_version";
      const b = await buildFor(modelId, t.version, t.tree);
      const warnings = buildWarnings(b);
      const history = await stub.listVersions(10);
      const empty = t.tree.parts.length === 0;
      return text({
        model: {
          name: state.name,
          link: L.model(modelId),
          version: t.version,
          ...(t.version !== state.version ? { current_version: state.version } : {}),
          status: state.status,
          ...(state.task ? { working_on: state.task } : {}),
          units: "mm",
        },
        parts: partStats(t.tree, b),
        features: featureIndex(t.tree, b),
        warnings: warnings.length ? warnings : "none",
        history: history.map((h) => ({ version: h.version, summary: h.summary, by: h.by, at: new Date(h.at).toISOString() })),
        ...(refs.length ? { refs_in_link: `This link points at ${refs.join(", ")}: call resolve with it.` } : {}),
        ...(empty ? { schema: schemaDoc(), next: "The model is empty. Build the first tree with write_model." } : {}),
        tree: t.tree,
        facts_source: b ? "kernel" : "none",
      });
    }),
  );

  server.registerTool(
    "resolve",
    {
      title: "Resolve refs",
      description:
        "Say exactly what a link's #refs point at. For each ref: whether it's live, renamed (and what it is now) or removed; the feature's JSON; measured facts from the built geometry (a face's area, normal, plane, bbox, which faces it meets; a feature's surviving faces and what it cuts into; a part's volume and size); what it depends on and what depends on it; and, with ?v=<n> in the link, whether it changed since the person looked. Call this before editing anything a person linked.",
      inputSchema: {
        link: z.string().describe("Model link with #<ref>,<ref>…, e.g. <origin>/m/<model>?v=12#base.top,mount-holes:2"),
        refs: z.array(z.string()).max(50).optional().describe("Refs to resolve as well as (or instead of) the link's #fragment"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("resolve", async (a: { link: string; refs?: string[] }, ev) => {
      const p = parse(a.link);
      const refs = [...new Set([...p.refs, ...(a.refs ?? [])])];
      if (!refs.length) {
        throw new ToolError("No refs in that link. Pass a link ending in #<feature> or #<feature>.<face> (comma-separate several), or pass refs.");
      }
      const stub = stubFor(p.modelId);
      const state = await stub.getState();
      const doc = state.tree as CadDoc;
      const b = await buildFor(p.modelId, state.version, doc);
      const live = new Set(allIds(doc));
      const parsed = refs.map((r) => ({ raw: r, ref: parseRef(r) }));
      const aliases: Record<string, Alias> = await stub.lookupAliases(parsed.filter((x) => x.ref && !live.has(x.ref.id)).map((x) => x.ref!.id));
      const changed = p.version !== undefined ? await stub.changedSince(p.version) : undefined;
      const changedSince = (id: string) =>
        changed === undefined ? {} : { changed_since_seen: changed === null ? `unknown (v${p.version} is older than the kept history)` : changed.includes(id) };

      const scope = new Set<string>();
      let misses = 0;
      const out = parsed.map(({ raw, ref }) => {
        if (!ref) {
          misses++;
          return { ref: raw, status: "unknown", message: `"${raw}" is not a ref (expected part, feature, feature:n, feature.role or feature:n.role)` };
        }
        let id = ref.id;
        let now: string | undefined;
        let renamedIn: number | undefined;
        if (!live.has(id)) {
          const al = aliases[id];
          if (al && al.newId === null) {
            misses++;
            return { ref: raw, status: "removed", removed_in: al.version, was: al.was, ...changedSince(id) };
          }
          if (!al) {
            misses++;
            return { ref: raw, status: "unknown", message: `No part or feature "${id}" in this model.`, did_you_mean: didYouMean(doc, id) };
          }
          id = al.newId!;
          now = formatRef(id, ref.instance, ref.role);
          renamedIn = al.version;
        }
        const target = now ?? raw;
        const f = findFeature(doc, id)?.feature;
        if (ref.role && f && !rolesOf(f).includes(ref.role)) {
          misses++;
          return { ref: raw, status: "unknown_role", message: `${f.type} "${id}" has no face "${ref.role}".`, roles: rolesOf(f) };
        }
        if (ref.role && !f) {
          misses++;
          return { ref: raw, status: "unknown_role", message: `"${id}" is a part; faces belong to features (<feature>.<role>).` };
        }
        const { ok, out: facts } = factsFor(doc, b, target);
        if (!ok) {
          misses++;
          return { ref: raw, status: "unknown", ...(now ? { now } : {}), message: facts.message };
        }
        scope.add(id);
        return {
          ref: raw,
          status: now ? "renamed" : "ok",
          ...(now ? { now, renamed_in: renamedIn } : {}),
          ...facts,
          ...changedSince(id),
        };
      });
      ev.size = refs.length;
      ev.warnings = misses;
      ev.detail = misses ? "unknown_ref" : refs.some((r) => r.includes(".")) ? "face" : "feature";
      return text({
        model: { name: state.name, link: L.model(p.modelId), version: state.version, status: state.status, ...(state.task ? { working_on: state.task } : {}) },
        ...(p.version !== undefined ? { seen_version: p.version } : {}),
        refs: out,
        edit_scope: [...scope],
        facts_source: b ? "kernel" : "none",
        next: scope.size
          ? "Change only the edit_scope features with edit_features (after start_edit). dependents move with them; edit those only if the change requires it."
          : "None of these refs are live. Check did_you_mean, or ask the person for a fresh link.",
      });
    }),
  );

  server.registerTool(
    "start_edit",
    {
      title: "Start edit",
      description:
        "Claim the model before changing it. The viewer shows your task and highlights the refs you name until you save with edit_features or write_model (with the returned lock) or call release_edit. Claims expire after 10 minutes. To renew a claim you hold (more time, new task), pass its lock; without it the model reads as taken.",
      inputSchema: {
        link: Link,
        task: z.string().min(1).max(200).describe("Short description of what you're doing, shown in the viewer"),
        refs: z.array(z.string()).max(50).optional().describe("Features or faces you'll change; the viewer highlights them. Defaults to the link's #refs"),
        lock: z.string().optional().describe("Your lock, to renew a claim you already hold"),
      },
    },
    wrap("start_edit", async (a: { link: string; task: string; refs?: string[]; lock?: string }, ev) => {
      const p = parse(a.link);
      ev.detail = a.lock ? "renew" : "claim";
      const r = await stubFor(p.modelId).startEdit({ task: a.task, scope: a.refs ?? p.refs, lock: a.lock });
      return text({
        model_link: L.model(p.modelId),
        lock: r.lock,
        base_version: r.baseVersion,
        expires_at: new Date(r.lockExpiresAt).toISOString(),
        next: "edit_features or write_model with this lock and base_version. Calls without the lock fail while you hold the claim.",
      });
    }),
  );

  server.registerTool(
    "write_model",
    {
      title: "Write model",
      description:
        "Replace the whole tree; the viewer rebuilds live. Use it for a new model or a broad change; for changes to linked features use edit_features. Keep every id that's still the same thing. Ids you drop become 'removed' for old links; pass renames for ids you renamed. Rejected (nothing saved) if the tree is invalid. Returns build warnings and part measurements.",
      inputSchema: {
        link: Link,
        tree: TreeIn,
        lock: Lock,
        base_version: BaseVersion,
        summary: Summary,
        renames: z.record(z.string(), z.string()).optional().describe("old id → new id for parts or features you renamed in this rewrite, so old links follow them"),
        keep_claim: KeepClaim,
      },
    },
    wrap(
      "write_model",
      async (
        args: { link: string; tree: unknown; lock?: string; base_version?: number; summary?: string; renames?: Record<string, string>; keep_claim?: boolean },
        ev,
      ) => {
        const a = args as Omit<typeof args, "tree"> & { tree: CadDoc };
        const p = parse(a.link);
        ev.size = JSON.stringify(a.tree).length;
        const r = await stubFor(p.modelId).writeTree({
          tree: a.tree,
          lock: a.lock,
          baseVersion: a.base_version,
          summary: a.summary,
          renames: a.renames,
          keepClaim: a.keep_claim,
          by,
        });
        ev.detail = r.unchanged ? "unchanged" : r.version === 1 ? "first" : "rewrite";
        return saved(p.modelId, r, ev);
      },
    ),
  );

  const Op = z.discriminatedUnion("op", [
    z.object({
      op: z.literal("update"),
      id: z.string().describe("Feature to change"),
      set: z.record(z.string(), z.unknown()).describe("Fields to change, as a JSON merge patch (null deletes a field). Can't change id or type"),
    }),
    z.object({ op: z.literal("replace"), id: z.string(), feature: FeatureIn.describe("The whole new feature; its id must equal id (use to change type)") }),
    z.object({
      op: z.literal("add"),
      feature: FeatureIn,
      part: z.string().optional().describe("Part to add to. Required when the model has several parts"),
      after: z.string().optional().describe("Insert after this feature; default the end of the part"),
    }),
    z.object({ op: z.literal("add_part"), part: PartIn }),
    z.object({ op: z.literal("remove"), id: Id }),
    z.object({ op: z.literal("rename"), id: Id, to: z.string().describe("New id. Every `at` that refers to it is rewritten, and old links follow it") }),
  ]);

  server.registerTool(
    "edit_features",
    {
      title: "Edit features",
      description:
        "The scoped edit: change, add, remove or rename specific features (or parts) by id and leave the rest of the tree untouched. Ops apply in order and the result is validated once, so you can remove a feature and re-place what sat on it in the same call. All or nothing: any problem rejects the whole call. Returns what changed, build warnings, and fresh facts for the touched features.",
      inputSchema: {
        link: Link,
        ops: z.array(Op).min(1).max(100),
        lock: Lock,
        base_version: BaseVersion,
        summary: Summary,
        keep_claim: KeepClaim,
      },
    },
    wrap(
      "edit_features",
      async (args: { link: string; ops: unknown[]; lock?: string; base_version?: number; summary?: string; keep_claim?: boolean }, ev) => {
        const a = args as Omit<typeof args, "ops"> & { ops: EditOp[] };
        const p = parse(a.link);
        ev.size = a.ops.length;
        ev.detail = [...new Set(a.ops.map((o) => o.op))].sort().join("+");
        const r = await stubFor(p.modelId).applyEdit({
          ops: a.ops,
          lock: a.lock,
          baseVersion: a.base_version,
          summary: a.summary,
          keepClaim: a.keep_claim,
          by,
        });
        return saved(p.modelId, r, ev);
      },
    ),
  );

  server.registerTool(
    "release_edit",
    {
      title: "Release edit",
      description: "Give up a claim from start_edit without saving.",
      inputSchema: { link: Link, lock: z.string() },
    },
    wrap("release_edit", async (a: { link: string; lock: string }) => {
      const p = parse(a.link);
      await stubFor(p.modelId).releaseEdit(a.lock);
      return text("Released.");
    }),
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request. State lives in the Durable Objects. */
export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    // no server-initiated stream in stateless mode
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  // clientInfo only arrives on initialize, so that's where we learn which client connected
  ctx.waitUntil(
    request
      .clone()
      .json()
      .then((body: any) => {
        const init = (Array.isArray(body) ? body : [body]).find((m) => m?.method === "initialize");
        if (!init) return;
        const info = init.params?.clientInfo ?? {};
        return track(env, {
          event: "connect",
          name: String(info.name ?? "unknown").slice(0, 64),
          actor: clientFromUserAgent(request.headers.get("User-Agent")),
          detail: String(info.version ?? "").slice(0, 32),
          country: countryOf(request),
        });
      })
      .catch(() => {}),
  );
  const server = buildServer(env, request, ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
