import { CadModel, type CommentAuthor } from "./model-file.ts";
import { handleMcp } from "./mcp.ts";
import { newModelId } from "./ids.ts";
import { type AnalyticsEvent, countryOf, track } from "./analytics.ts";
import { anchorFacts } from "./built.ts";
import type { CadDoc } from "./schema.ts";

export { CadModel };

export interface Env {
  MODELS: DurableObjectNamespace<CadModel>;
  ASSETS: Fetcher;
  EVENTS?: AnalyticsEngineDataset;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** Errors are {error}; the status comes from the message, so keep wording in step with this (and mcp.ts errorKind). */
const errorStatus = (message: string) =>
  /version conflict|being edited by another session|already has notes/i.test(message) ? 409
  : /only its author/i.test(message) ? 403
  : /too large/i.test(message) ? 413
  : /not found/i.test(message) ? 404
  : /was deleted/i.test(message) ? 410
  : 400;

/** The viewer's anonymous analytics id, only ever used for track(). */
const viewerOf = (v: unknown) => (typeof v === "string" && /^[a-z0-9]{16}$/.test(v) ? v : "");

/** "person:<name>" for history, from what the viewer sends. */
const personBy = (by: unknown) => {
  const name = typeof by === "string" ? by.replace(/^person:?/, "").replace(/\s+/g, " ").trim().slice(0, 40) : "";
  return name ? `person:${name}` : "person";
};

const intOrUndefined = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const intParam = (v: string | null) => (v !== null && /^\d+$/.test(v) ? Number(v) : undefined);

/**
 * Model links are the only access control, so keep them out of search indexes
 * and out of Referer headers. The WebSocket upgrade (101) passes through as is.
 */
const PRIVATE_HEADERS = { "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

/** The viewer runs manifold (WASM) in a Web Worker; nothing user-authored is ever rendered as HTML. */
const VIEWER_CSP = "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'; base-uri 'none'";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await route(request, env, ctx);
    const path = new URL(request.url).pathname;
    if (res.status === 101 || !(path.startsWith("/m/") || path.startsWith("/api/"))) return res;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) out.headers.set(k, v);
    return out;
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/mcp" || path.startsWith("/mcp/")) return handleMcp(request, env, ctx);

  // Viewer page for /m/<model>; the #refs and ?v= are read client-side
  if (/^\/m\/[a-z0-9]+\/?$/.test(path)) {
    const page = await env.ASSETS.fetch(new Request(new URL("/model", url), request));
    const out = new Response(page.body, page);
    out.headers.set("Content-Security-Policy", VIEWER_CSP);
    out.headers.set("Cache-Control", "no-cache");
    return out;
  }

  const stub = (modelId: string) => env.MODELS.get(env.MODELS.idFromName(modelId));
  const note = (name: string, modelId: string) => ctx.waitUntil(track(env, { event: "trash", name, modelId, country: countryOf(request) }));
  const event = (e: Omit<AnalyticsEvent, "country">) => ctx.waitUntil(track(env, { ...e, country: countryOf(request) }));

  try {
    if (path === "/api/models" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { name?: string };
      const id = newModelId();
      const state = await stub(id).init(id, String(body.name || "Untitled").slice(0, 120), undefined, "person");
      ctx.waitUntil(track(env, { event: "create", name: "web", modelId: id, country: countryOf(request) }));
      return json({ ...state, link: `${url.origin}/m/${id}` }, 201);
    }

    let m = path.match(/^\/api\/models\/([a-z0-9]+)$/);
    if (m) {
      const s = stub(m[1]);
      if (request.method === "PATCH") {
        const body = (await request.json().catch(() => ({}))) as { name?: string };
        if (body.name) await s.renameModel(String(body.name).slice(0, 120));
      }
      if (request.method === "DELETE") {
        const trashed = await s.deleteModel();
        note("model-delete", m[1]);
        return json({ deleted: true, ...trashed });
      }
      if (!(await s.exists())) return json({ error: "not_found" }, 404);
      const trashed = await s.trashInfo();
      if (trashed) return json({ deleted: true, ...trashed }, 410);
      return json(await s.getState());
    }

    // the trash: anyone with the link can delete, so anyone with the link can restore
    m = path.match(/^\/api\/models\/([a-z0-9]+)\/restore$/);
    if (m && request.method === "POST") {
      const state = await stub(m[1]).restoreModel();
      note("model-restore", m[1]);
      return json(state);
    }

    m = path.match(/^\/api\/models\/([a-z0-9]+)\/ws$/);
    if (m) {
      const s = stub(m[1]);
      if (!(await s.exists())) return json({ error: "not_found" }, 404);
      const forward = new Request(request);
      forward.headers.set("x-ic-country", countryOf(request));
      return s.fetch(forward);
    }

    // history: every version is kept. Restoring makes an old tree current again as a new version.
    m = path.match(/^\/api\/models\/([a-z0-9]+)\/versions(?:\/(\d+)(\/restore)?)?$/);
    if (m) {
      const [, modelId, n, restore] = m;
      const s = stub(modelId);
      if (restore) {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const body = (await request.json().catch(() => ({}))) as { baseVersion?: number; by?: string; viewer?: string };
        const r = await s.restoreVersion({ version: Number(n), baseVersion: intOrUndefined(body.baseVersion), by: personBy(body.by), who: "person" });
        event({ event: "history", name: "restore", modelId, actor: viewerOf(body.viewer), detail: r.unchanged ? "unchanged" : "person" });
        return json(r);
      }
      if (n !== undefined) return json(await s.getTree(Number(n)));
      return json(await s.listVersions({ before: intParam(url.searchParams.get("before")), limit: intParam(url.searchParams.get("limit")) }));
    }

    m = path.match(/^\/api\/models\/([a-z0-9]+)\/diff$/);
    if (m) {
      const from = intParam(url.searchParams.get("from"));
      if (from === undefined) return json({ error: "Pass from=<version> (and optionally to=<version>; it defaults to the current one)." }, 400);
      return json(await stub(m[1]).diffVersions(from, intParam(url.searchParams.get("to"))));
    }

    // which old ids were renamed or removed, and when
    m = path.match(/^\/api\/models\/([a-z0-9]+)\/aliases$/);
    if (m) {
      const ids = (url.searchParams.get("ids") ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 200);
      return json({ aliases: await stub(m[1]).lookupAliases(ids) });
    }

    // comments: people in the viewer. The agent's side is get_model, resolve and the comment MCP tool.
    m = path.match(/^\/api\/models\/([a-z0-9]+)\/comments(?:\/([a-z0-9]+))?(?:\/([a-z0-9]+))?$/);
    if (m) {
      const [, modelId, threadId, commentId] = m;
      const s = stub(modelId);
      if (request.method === "GET" && !commentId) {
        if (threadId) return json(await s.getThread(threadId));
        const status = url.searchParams.get("status");
        return json({ threads: await s.listThreads(status === "open" || status === "resolved" ? { status } : {}) });
      }
      const body = (await request.json().catch(() => ({}))) as {
        ref?: string | null; point?: unknown; normal?: unknown; camera?: unknown; version?: number;
        body?: string; author?: { id?: string; name?: string; secret?: string }; status?: string; by?: string; secret?: string; viewer?: string;
      };
      const author: CommentAuthor = { id: String(body.author?.id ?? ""), name: String(body.author?.name ?? ""), secret: body.author?.secret, kind: "person" };
      const comment = (name: string) => event({ event: "comment", name, modelId, actor: viewerOf(body.viewer), detail: "person" });
      if (request.method === "POST" && !threadId) {
        const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : null;
        const t = await s.getTree(intOrUndefined(body.version));
        const facts = ref ? await anchorFacts(modelId, t.version, t.tree as CadDoc, ref) : null;
        const thread = await s.createThread({ ref, point: body.point, normal: body.normal, camera: body.camera, version: t.version, facts, body: String(body.body ?? ""), author });
        comment("create");
        return json(thread, 201);
      }
      if (request.method === "POST" && !commentId) {
        const thread = await s.reply(threadId, String(body.body ?? ""), author);
        comment("reply");
        return json(thread, 201);
      }
      if (request.method === "PATCH" && !commentId) {
        const status = body.status === "resolved" ? "resolved" : "open";
        const thread = await s.setThreadStatus(threadId, status, String(body.by ?? ""));
        comment(status === "resolved" ? "resolve" : "reopen");
        return json(thread);
      }
      if (request.method === "PATCH" && commentId) {
        const thread = await s.editComment(threadId, commentId, String(body.body ?? ""), body.secret);
        comment("edit");
        return json(thread);
      }
      if (request.method === "DELETE" && commentId) {
        const thread = await s.deleteComment(threadId, commentId, body.secret);
        comment("delete");
        return json({ thread });
      }
      return json({ error: "Method not allowed" }, 405);
    }

    // the model's notes: people in the viewer. The agent's side is get_model and write_notes.
    m = path.match(/^\/api\/models\/([a-z0-9]+)\/notes$/);
    if (m) {
      const s = stub(m[1]);
      if (request.method === "GET") return json(await s.getNotes());
      if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
      const body = (await request.json().catch(() => ({}))) as { body?: string; baseVersion?: number; by?: string; viewer?: string };
      const notes = await s.writeNotes({ body: String(body.body ?? ""), baseVersion: intOrUndefined(body.baseVersion), by: { name: String(body.by ?? ""), kind: "person" } });
      event({ event: "notes", name: "edit", modelId: m[1], actor: viewerOf(body.viewer), detail: "person", size: notes.body.length });
      return json(notes);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, errorStatus(message));
  }

  return env.ASSETS.fetch(request);
}
