import { CadModel } from "./model-file.ts";
import { handleMcp } from "./mcp.ts";
import { newModelId } from "./ids.ts";
import { countryOf, track } from "./analytics.ts";

export { CadModel };

export interface Env {
  MODELS: DurableObjectNamespace<CadModel>;
  ASSETS: Fetcher;
  EVENTS?: AnalyticsEngineDataset;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

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

    m = path.match(/^\/api\/models\/([a-z0-9]+)\/versions(?:\/(\d+))?$/);
    if (m) {
      const s = stub(m[1]);
      if (m[2] !== undefined) return json(await s.getTree(Number(m[2])));
      return json(await s.listVersions());
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(
      { error: message },
      /version conflict/i.test(message) ? 409 : /not found/i.test(message) ? 404 : /was deleted/i.test(message) ? 410 : 400,
    );
  }

  return env.ASSETS.fetch(request);
}
