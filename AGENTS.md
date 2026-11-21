# AGENTS.md

This file provides guidance to coding agents (Claude Code, Codex) working in this repository. CLAUDE.md imports it.

Infinite CAD is a 3D part canvas that LLMs build on over MCP: the agent writes a declarative JSON feature tree (mm), the viewer renders it live, and people point back at parts, features or single faces with links like `/m/<model>?v=12#base.top,mount-holes:2`. The agent calls `resolve` on that link and edits just those features. Sibling of Divs & Spans (`../divs-and-spans`), and built on the same bones. One Cloudflare Worker serves the MCP endpoint, the JSON/WebSocket API and the viewer. Not deployed under a custom domain yet (`workers_dev` only). Links are built from the request origin. SPEC.md is the v1 build reference; README.md has the feature and keyboard reference.

## Commands

```sh
npm run dev         # wrangler dev on :8787 (also runs build:web and watches src/ and web/)
npm run smoke       # in a second terminal: end-to-end MCP run against :8787 (pass a base URL to target another host)
npm run typecheck   # tsc for the worker (src/) and the viewer (web/), separate tsconfigs
npm run build:web   # esbuild web/viewer.ts, web/home.ts, web/kernel-worker.ts -> public/js (+ manifold.wasm; gitignored)
npm run deploy      # wrangler deploy
```

There is no unit test suite. Verification is `typecheck` plus `smoke` (scripts/smoke.mjs plays the agent through a real MCP client: create, claim, write, resolve links to faces/features, scoped edits, renames and removals, conflicts, history, REST, WebSocket, trash). It asserts the exact tool count, so update it when adding or removing an MCP tool. The kernel has its own script (scripts/kernel-test.ts), and exact STEP export has `npm run step-test` (rebuilds models with OpenCascade, checks volumes and bounding boxes against the mesh build, reads the STEP back).

## Architecture

- **src/index.ts** is the Worker entry and router. `/mcp` goes to src/mcp.ts; `/m/<model>` serves `public/model.html` (asset `/model`) with the viewer CSP; `/api/models[/<id>[/restore|/ws|/versions[/<n>]]]` is model state, rename, trash, the WebSocket and history. Everything else falls through to static assets. `run_worker_first` in wrangler.jsonc must list any new worker-handled path prefix.
- **src/mcp.ts** is a stateless Streamable HTTP MCP server (a fresh `McpServer` per request), 7 tools: `create_model`, `get_model`, `resolve`, `start_edit`, `write_model`, `edit_features`, `release_edit`. Tools are wrapped by `wrap()`, which records analytics and turns thrown errors into tool errors; `errorKind()` classifies errors by message text (no_lock, conflict, bad_link, invalid, too_large, not_found, deleted), so keep error wording consistent with it. `CONTRACT` is the server `instructions` plus `schemaDoc()`; it is deliberately structural (ids, refs, links, scoped edits), never taste. Geometry is built here, in the Worker isolate, with manifold (`loadManifold()` from src/manifold-worker.ts), cached per isolate by `<model>:<version>` (versions are immutable). If the kernel can't load, tools answer from the source alone (`facts_source: "none"`).
- **src/model-file.ts** is the `CadModel` Durable Object, one per model (`idFromName(modelId)`), SQLite-backed: `meta` (name, version, claim, deleted_at), `versions` (the last `HISTORY` = 50 canonical trees with summary, changed ids, author) and `aliases` (old id → new id, or NULL plus the removed JSON). It never builds geometry; it only runs pure TS (`validate`, `applyOps`, `diff`, `canonical`). The worker and MCP call its methods over DO RPC; only the WebSocket goes through `fetch`. Every mutation calls `broadcast()` (`tree`, `claim`, `model`, `model-deleted`, `model-restored`). It owns claims (`start_edit` takes a 10-minute lock on the whole model, writes need the lock while it's held, `base_version` rejects stale writes and lists what changed). The schema is created in `init()` with `CREATE TABLE IF NOT EXISTS` and there is no migration layer, so a new column needs an explicit `ALTER TABLE` path for existing models. Lookups must not write before `init()` (`ready` flag), or every probe becomes a stored object. Deletes are soft: the model gets a `deleted_at` meta key and `alarm()` erases it after `TRASH_MS` (30 days); `requireModel()` throws "was deleted" for a trashed model (410 on the API).
- **Kernel (src/schema.ts, src/tree.ts, src/geometry.ts, src/facts.ts)** is environment-neutral and shared with the viewer's Web Worker: tree types, ref grammar and `validate()`; `applyOps`/`diff`/`didYouMean`; `build()` (manifold, a ref per triangle); `resolve()` facts from the built mesh. No DOM, no node, no Worker globals in them. Imports between src files use `.ts` extensions.
- **src/ids.ts**: model ids are 14 random a-z0-9 chars and are the only access control (capability URLs, no auth yet); locks are 20. Feature and part ids are agent-chosen slugs. `parseLink()` accepts full links, bare ids, `?v=<n>` and `#ref,ref` fragments.
- **src/analytics.ts** writes Workers Analytics Engine events (`tool`, `connect`, `create`, `session`, `trash`). Model ids are hashed, and trees, feature ids and refs are never recorded; keep it that way.
- **web/** is the viewer client (plain TS + three.js, no framework), bundled to `public/js`; the kernel runs in a Web Worker (web/kernel-worker.ts) on the same src/geometry.ts.
- **Export** is client-side. web/export.ts writes STL, 3MF, GLB, OBJ and a faceted STEP fallback from the meshes. Exact STEP is src/brep.ts in web/step-worker.ts: OpenCascade (replicad, ~23 MB WASM served as a static asset, fetched only on the first STEP export) rebuilds each feature instance as an analytic solid using the matrices and hole depths the manifold build resolved, so any change to `primitive()` in src/geometry.ts needs the same change in src/brep.ts. Keep OpenCascade out of the Worker bundle.

## Conventions and constraints

- Writes are rejected on any `validate()` issue (nothing saved); build errors and empty parts are accepted and returned as `warnings`.
- Ids are addresses. Renames go through `edit_features` `rename` or `write_model` `renames` so aliases are recorded; never infer renames from a diff.
- The kernel needs real CPU (tens to hundreds of ms per build): production needs Workers Paid. `nodejs_compat` stays on; the manifold loader hides `globalThis.process` around `Module()` to cope with it.
- New viewer features get a keyboard shortcut and a visible `<kbd>` hint on their control, and the README's "Viewer keys" section is updated to match.
- Not built yet: auth, comments, notes, embeds, server-side export (all exports are client-side), a history UI, per-feature claims, cross-part booleans, fillets.
