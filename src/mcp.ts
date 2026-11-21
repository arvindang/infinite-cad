import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./index.ts";
import { links, newModelId, parseLink } from "./ids.ts";
import { clientFromUserAgent, countryOf, track } from "./analytics.ts";
import { type Alias, type CommentAuthor, type CommitResult, ToolError, checkTree } from "./model-file.ts";
import type { FactsSnapshot, ModelNotes, Thread, VersionDiff } from "./collab.ts";
import { type CadDoc, type Vec3, defaultOp, instanceCount, parseRef, formatRef, rolesOf, schemaDoc } from "./schema.ts";
import { type EditOp, allIds, didYouMean, findFeature, refProblem } from "./tree.ts";
import { compareFacts, dependencies, resolve as resolveRef } from "./facts.ts";
import { type Built, buildFor, buildWarnings, factsFor, snapshotOf } from "./built.ts";

/**
 * The whole contract is structural. It says how models, ids and links work,
 * never what a part should look like.
 */
export const CONTRACT = `Infinite CAD is a 3D part canvas. You build parts by writing a declarative feature tree in JSON; the person inspects the model live in their browser and sends you links that point at the whole model, at parts, at features, or at single faces.

The contract (structural only, the design itself is yours):
1. A model is one feature tree: {"units":"mm","parts":[…]}. Each part is one solid built from an ordered list of features (primitives, holes, booleans, placement on earlier faces). Units are millimetres, angles degrees.
2. Every part and feature has an id you choose: a lowercase slug that says what it is (base, mount-holes, lid-lip). Not its type alone (cylinder-3) and not its history (new-base, base-v2). Ids are the addresses people link to, and they are unique across the model.
3. Ids are stable. Never renumber or rename to tidy up. When you rewrite the whole tree, keep the id of every part and feature that is still the same thing. Rename only when a feature's meaning changes, with edit_features op "rename" (or renames on write_model): old links then follow it. Don't give a removed id to something new.
4. A link like <origin>/m/<model>#base.top,mount-holes:2 points at things: base.top is one face of the feature base (<feature>.<role>), mount-holes:2 is the second instance of a patterned feature, a bare id is a whole feature or part. Refs are comma-separated. ?v=<n> is the version the person was looking at. A link with ?c=<id> points at a comment thread.
5. When a message has a link with #refs, call resolve on it before changing anything. It says what each ref is: the feature's JSON, measured geometry facts, what it depends on and what depends on it, and whether it changed since the person looked.
6. Edit only what's linked. Change the referenced features with edit_features, plus features that depend on them only when the change requires it, and leave everything else as it is. write_model replaces the whole tree: use it for a new model or when the person asks for a broad change.

Workflow: get_model first. To change a model: start_edit (claims it for 10 minutes; the viewer shows your task and highlights the refs you name) → edit_features or write_model with the lock and the base_version it returned. Pass the lock to every call while you hold the claim, and release_edit if you stop without saving. A write is rejected if the tree is invalid (the error lists every problem) or someone saved after your base_version; nothing is applied in either case. Geometry warnings (a cut that empties a part, a feature the kernel couldn't build) come back with each save: fix the ones you didn't intend.

Comments: people pin comment threads to parts, features or faces, or to the whole model, in the viewer. get_model lists the open ones. Call resolve on a comment link (…?c=<id>): it returns the thread, what it's pinned to now (renames are followed), and the pinned ref's measured facts when the comment was made and now. When you've addressed one, reply with what you changed and resolve it with comment; if it needs the person's call, reply and leave it open. A write that removes something with an open comment warns you.

Notes: each model has one markdown notes doc that people and agents both edit. It holds what the geometry can't show: requirements, mating parts and clearances, material and process, decisions and open questions. Never a description of the tree; the tree already says that. get_model returns the notes; write_notes replaces them (send the whole doc with the base_version you read). Read them before changing a model, keep what people wrote, and point at things with [text](#<ref>), e.g. [mounting face](#base.top).

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
  : /being edited by another session|version conflict|already has notes/i.test(message) ? "conflict"
  : /couldn't read|no refs in that link|pass a comment link/i.test(message) ? "bad_link"
  : /^invalid (tree|edit)/i.test(message) ? "invalid"
  : /too large/i.test(message) ? "too_large"
  : /not found/i.test(message) ? "not_found"
  : /was deleted/i.test(message) ? "deleted"
  : /only its author/i.test(message) ? "forbidden"
  : "error";

/** A short label for who's commenting, from the client's User-Agent. */
const agentName = (client: string) =>
  /claude/.test(client) ? "Claude" : /cursor/.test(client) ? "Cursor" : /codex|openai/.test(client) ? "Codex" : /gemini/.test(client) ? "Gemini" : "Agent";

const excerpt = (text: string, n = 160) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const iso = (ms: number | null) => new Date(ms ?? 0).toISOString();

/** Refs the notes point at with [text](#ref) or [text](#a,b), in order, once each. */
const noteRefs = (markdown: string) => [
  ...new Set([...markdown.matchAll(/\]\(#([^)\s]+)\)/g)].flatMap((m) => m[1].split(",").map((r) => r.trim()).filter(Boolean))),
];

interface StaleRef {
  ref: string;
  now?: string;
  renamed_in?: number;
  removed_in?: number;
  unknown?: true;
  message?: string;
  did_you_mean?: string[];
}

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
    const orphans = r.orphaned.map(
      (o) =>
        `This write removed ${o.ref}, which has an open comment (${L.comment(modelId, o.threadId)}): "${o.excerpt}". If that was the fix, reply and resolve it with comment; otherwise put it back (or rename instead of removing) so the comment stays pinned.`,
    );
    const warnings = [...orphans, ...r.warnings, ...buildWarnings(b)];
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
      ...(r.openComments
        ? { open_comments: `${r.openComments} open on this model. Reply to and resolve the ones this change addresses (resolve the comment link, then comment).` }
        : {}),
      ...extra,
    });
  };

  const agent: CommentAuthor = { id: `agent-${client.replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "unknown"}`, name: agentName(client), kind: "agent" };

  /** Which of `refs` don't resolve as written in the current tree: renamed, removed or unknown. */
  const staleRefs = async (stub: ReturnType<typeof stubFor>, doc: CadDoc, refs: string[]): Promise<StaleRef[]> => {
    const live = new Set(allIds(doc));
    const parsed = refs.map((raw) => ({ raw, ref: parseRef(raw) }));
    const aliases: Record<string, Alias> = await stub.lookupAliases(parsed.filter((x) => x.ref && !live.has(x.ref.id)).map((x) => x.ref!.id));
    const out: StaleRef[] = [];
    for (const { raw, ref } of parsed) {
      if (!ref) out.push({ ref: raw, unknown: true, message: `"${raw}" is not a ref` });
      else if (live.has(ref.id)) {
        const problem = refProblem(doc, raw);
        if (problem) out.push({ ref: raw, unknown: true, message: problem });
      } else if (aliases[ref.id]?.newId) out.push({ ref: raw, now: formatRef(aliases[ref.id].newId!, ref.instance, ref.role), renamed_in: aliases[ref.id].version });
      else if (aliases[ref.id]) out.push({ ref: raw, removed_in: aliases[ref.id].version });
      else out.push({ ref: raw, unknown: true, did_you_mean: didYouMean(doc, ref.id) });
    }
    return out;
  };
  const staleWarning = (s: StaleRef) =>
    s.now ? `#${s.ref} was renamed to ${s.now} in v${s.renamed_in}`
    : s.removed_in !== undefined ? `#${s.ref} was removed in v${s.removed_in}`
    : s.message ? `#${s.ref}: ${s.message}`
    : `#${s.ref} isn't a part or feature in this model${s.did_you_mean?.length ? ` (did you mean ${s.did_you_mean.join(", ")}?)` : ""}`;

  /** get_model's notes block. */
  const notesOut = async (stub: ReturnType<typeof stubFor>, doc: CadDoc, n: ModelNotes) => {
    if (!n.version) return { markdown: "", version: 0, note: "No notes yet. write_notes with base_version 0 to start them." };
    const stale = (await staleRefs(stub, doc, noteRefs(n.body))).map(({ ref, now, removed_in, unknown }) => ({
      ref,
      ...(now ? { now } : {}),
      ...(removed_in !== undefined ? { removed_in } : {}),
      ...(unknown ? { unknown } : {}),
    }));
    return {
      markdown: n.body,
      version: n.version,
      updated_by: n.updatedBy,
      updated_at: iso(n.updatedAt),
      ...(stale.length ? { stale_refs: stale } : {}),
    };
  };

  /** A thread as the agent reads it: what it's pinned to now, where the person was looking, the conversation, and facts then vs now. */
  const commentOut = async (modelId: string, t: Thread, version: number, doc: CadDoc) => {
    const cam = t.anchor.camera;
    let looking: Vec3 | undefined;
    if (cam) {
      const d = cam.target.map((v, i) => v - cam.position[i]);
      const l = Math.hypot(...d);
      if (l > 1e-9) looking = d.map((v) => Math.round((v / l) * 1000) / 1000) as Vec3;
    }
    const comment = {
      id: t.id,
      link: L.comment(modelId, t.id),
      status: t.status,
      pinned_to: t.anchor.ref
        ? {
            ref: t.anchor.ref,
            status: t.target.status,
            ...(t.target.ref && t.target.ref !== t.anchor.ref ? { now: t.target.ref } : {}),
            ...(t.target.since !== undefined ? { since: t.target.since } : {}),
            ...(t.target.message ? { message: t.target.message } : {}),
          }
        : { whole_model: true },
      ...(t.anchor.point ? { point: t.anchor.point } : {}),
      ...(t.anchor.normal ? { normal: t.anchor.normal } : {}),
      ...(looking ? { looking_along: looking } : {}),
      seen_version: t.anchor.version,
      comments: t.comments.map((c) => ({
        by: c.authorName,
        ...(c.authorKind === "agent" ? { agent: true } : {}),
        at: iso(c.createdAt),
        text: c.body,
        ...(c.editedAt ? { edited: true } : {}),
      })),
      ...(t.status === "resolved" ? { resolved_by: t.resolvedBy, resolved_at: iso(t.resolvedAt) } : {}),
    };
    // did what it's pinned to change since the person looked?
    let changedSince: boolean | string = false;
    if (t.anchor.version !== version) {
      try {
        const d = (await stubFor(modelId).diffVersions(t.anchor.version)) as VersionDiff;
        const ids = new Set([t.anchor.ref, t.target.ref].filter((r): r is string => !!r).map((r) => parseRef(r)?.id));
        changedSince = t.anchor.ref
          ? d.changes.some((c) => (ids.has(c.id) || (c.was !== undefined && ids.has(c.was))) && (c.change === "removed" || c.props.length > 0))
          : d.changes.length > 0;
      } catch {
        changedSince = `unknown (v${t.anchor.version} is older than the kept history)`;
      }
    }
    if (!t.anchor.ref) return { comment, changed_since_seen: changedSince };
    const then = t.anchor.facts;
    const now = t.target.ref && (t.target.status === "ok" || t.target.status === "renamed") ? await snapshotOf(modelId, version, doc, t.target.ref) : null;
    return {
      comment,
      facts: { then, now, changes: then && now ? compareFacts(then as FactsSnapshot, now) : [], changed_since_seen: changedSince },
    };
  };

  /** One line per open thread, for get_model. */
  const threadBrief = (modelId: string, t: Thread) => ({
    link: L.comment(modelId, t.id),
    pinned_to: t.anchor.ref ?? "whole model",
    ...(t.target.status === "renamed" ? { now: t.target.ref } : {}),
    ...(t.target.status === "removed" ? { removed: true } : {}),
    ...(t.target.status === "unknown" ? { detached: t.target.message } : {}),
    by: t.comments[0]?.authorName,
    text: excerpt(t.comments[0]?.body ?? ""),
    ...(t.comments.length > 1 ? { replies: t.comments.length - 1 } : {}),
  });

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
        "Read a model: its tree, a feature index (part, op, what each depends on and what depends on it), part measurements, build warnings, recent history, open comments and the model's notes. Call this before editing. Pass version to read an older tree (every version is kept).",
      inputSchema: {
        link: Link,
        version: z.number().int().min(0).optional().describe("Read this older version instead of the current one"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("get_model", async (a: { link: string; version?: number }, ev) => {
      const { modelId, refs, commentId } = parse(a.link);
      const stub = stubFor(modelId);
      const state = await stub.getState();
      const t = (await stub.getTree(a.version)) as { version: number; tree: CadDoc };
      if (a.version !== undefined) ev.detail = "old_version";
      const b = await buildFor(modelId, t.version, t.tree);
      const warnings = buildWarnings(b);
      const [page, open, notes] = await Promise.all([stub.listVersions({ limit: 10 }), stub.listThreads({ status: "open" }), stub.getNotes()]);
      const history = page.versions;
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
        history: history.map((h) => ({ version: h.version, summary: h.summary, by: h.by, at: iso(h.at) })),
        ...(open.length
          ? {
              open_comments: {
                count: open.length,
                threads: (open as Thread[]).slice(0, 20).map((th) => threadBrief(modelId, th)),
                next: "resolve a comment link for the full thread and its facts then vs now; when you've addressed one, reply and resolve it with comment.",
              },
            }
          : {}),
        notes: await notesOut(stub, state.tree as CadDoc, notes),
        ...(refs.length ? { refs_in_link: `This link points at ${refs.join(", ")}: call resolve with it.` } : {}),
        ...(commentId ? { comment_in_link: "This link points at a comment: call resolve with it." } : {}),
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
        "Say exactly what a link's #refs point at. For each ref: whether it's live, renamed (and what it is now) or removed; the feature's JSON; measured facts from the built geometry (a face's area, normal, plane, bbox, which faces it meets; a feature's surviving faces and what it cuts into; a part's volume and size); what it depends on and what depends on it; and, with ?v=<n> in the link, whether it changed since the person looked. Call this before editing anything a person linked. A comment link returns the whole thread: what it's pinned to now (following renames), every reply, and the pinned ref's facts when the comment was made vs now.",
      inputSchema: {
        link: z.string().describe("Model link with #<ref>,<ref>…, or a comment link (…?c=<id>), e.g. <origin>/m/<model>?v=12#base.top,mount-holes:2"),
        refs: z.array(z.string()).max(50).optional().describe("Refs to resolve as well as (or instead of) the link's #fragment"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap("resolve", async (a: { link: string; refs?: string[] }, ev) => {
      const p = parse(a.link);
      const stub = stubFor(p.modelId);
      const thread = p.commentId ? ((await stub.getThread(p.commentId)) as Thread) : null;
      const refs = [...new Set([...(thread?.anchor.ref ? [thread.anchor.ref] : []), ...p.refs, ...(a.refs ?? [])])];
      if (!refs.length && !thread) {
        throw new ToolError("No refs in that link. Pass a link ending in #<feature> or #<feature>.<face> (comma-separate several), or pass refs.");
      }
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
      ev.detail = thread ? "comment" : misses ? "unknown_ref" : refs.some((r) => r.includes(".")) ? "face" : "feature";
      const extra = thread ? await commentOut(p.modelId, thread, state.version, doc) : {};
      return text({
        model: { name: state.name, link: L.model(p.modelId), version: state.version, status: state.status, ...(state.task ? { working_on: state.task } : {}) },
        ...(p.version !== undefined ? { seen_version: p.version } : {}),
        ...extra,
        refs: out,
        edit_scope: [...scope],
        facts_source: b ? "kernel" : "none",
        next: thread
          ? "Address the comment by changing edit_scope (start_edit → edit_features), then reply with what you changed and resolve it with comment. If it needs the person's call, reply and leave it open."
          : scope.size
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

  server.registerTool(
    "comment",
    {
      title: "Comment",
      description:
        "Reply to, resolve or reopen a comment thread people started in the viewer; it updates live there. Pass a comment link (…?c=<id>). text replies (a reply reopens a resolved thread); resolve: true resolves it, false reopens it; pass both to say what you changed and close it.",
      inputSchema: {
        link: z.string().describe("Comment link, <origin>/m/<model>?c=<id>"),
        text: z.string().max(4000).optional().describe("Your reply. Plain text"),
        resolve: z.boolean().optional().describe("true resolves the thread, false reopens it"),
      },
    },
    wrap("comment", async ({ link, text: body, resolve }: { link: string; text?: string; resolve?: boolean }, ev) => {
      const p = parse(link);
      if (!p.commentId) throw new ToolError("Pass a comment link (…?c=<id>): comment replies to, resolves or reopens a thread people started in the viewer.");
      const reply = !!body?.trim();
      if (!reply && resolve === undefined) throw new ToolError("Pass text to reply, resolve to resolve or reopen, or both.");
      const stub = stubFor(p.modelId);
      let thread = (reply ? await stub.reply(p.commentId, body!, agent) : await stub.getThread(p.commentId)) as Thread;
      if (resolve !== undefined) thread = (await stub.setThreadStatus(p.commentId, resolve ? "resolved" : "open", agent.name)) as Thread;
      ev.detail = reply ? (resolve ? "reply_resolve" : "reply") : resolve ? "resolve" : "reopen";
      return text({ comment_link: L.comment(p.modelId, thread.id), status: thread.status, replies: thread.comments.length - 1 });
    }),
  );

  server.registerTool(
    "write_notes",
    {
      title: "Write notes",
      description:
        "Replace the model's notes: the markdown doc beside the model that people and agents both edit. Send the whole document, not a diff. People edit notes in the viewer too, so read them with get_model first, keep what they wrote, and pass base_version (0 for a model without notes); the write is rejected if someone saved since. No claim needed. Empty markdown clears them.",
      inputSchema: {
        link: Link,
        markdown: z.string().max(20000).describe("The full notes, in markdown. Point at parts, features or faces with [text](#<ref>)"),
        base_version: z.number().int().min(0).optional().describe("The notes version you read from get_model. Required once a model has notes"),
      },
    },
    wrap("write_notes", async ({ link, markdown, base_version }: { link: string; markdown: string; base_version?: number }, ev) => {
      const p = parse(link);
      const stub = stubFor(p.modelId);
      ev.size = markdown.length;
      if (base_version === undefined) {
        const cur = await stub.getNotes();
        if (cur.version) {
          throw new ToolError(
            `This model already has notes (v${cur.version}, last edited by ${cur.updatedBy}). Read them with get_model, keep what's there, and call again with base_version: ${cur.version}.`,
          );
        }
      }
      ev.detail = base_version ? "edit" : "new";
      const notes = await stub.writeNotes({ body: markdown, baseVersion: base_version, by: { name: agent.name, kind: "agent" } });
      const state = await stub.getState();
      const warnings = (await staleRefs(stub, state.tree as CadDoc, noteRefs(notes.body))).map(staleWarning);
      ev.warnings = warnings.length;
      return text({ model_link: L.model(p.modelId), notes_version: notes.version, ...(warnings.length ? { warnings } : {}) });
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
