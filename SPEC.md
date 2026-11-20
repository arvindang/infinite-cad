# Infinite CAD v1 spec (build reference)

Sibling of Divs & Spans (../divs-and-spans): same bones (one Worker, authless capability URLs, MCP-only authoring, one SQLite Durable Object per model, claims + base_version, WebSocket broadcast, soft delete). Payload is a declarative JSON feature tree instead of HTML; addresses are semantic refs instead of data-ds ids.

Planner write-ups with full detail (read the one for your area):
- Kernel: /private/tmp/claude-501/-Users-arvindang--claude-spares-spare-EoXPe3/41f0e09a-ac46-4e46-84b4-857a4da9d42d/scratchpad/kernel/PLAN.md
- Backend: …/scratchpad/backend/PLAN.md
- Viewer: …/scratchpad/viewer/PLAN.md (+ prototype viewer.ts, app.css, index.html)

Where this file and a PLAN.md disagree, this file wins.

## Decisions that override the plans

1. **Tree shape is the kernel's**: `{ "units": "mm", "parts": [{ "id", "name"?, "features": [...] }] }`. Empty model = `{ "units": "mm", "parts": [] }`. Feature types/roles/`at`/patterns exactly as kernel PLAN §2. Ids are unique across parts and features in a file (so a bare id is unambiguous).
2. **Refs**: `part` | `feature` | `feature:n` | `feature.role` | `feature:n.role`. Grammar in `src/schema.ts` (`parseRef`). Link: `<origin>/m/<14-char model id>[?v=<n>][#<ref>,<ref>…]`. Fragment chars: `[a-z0-9:.,-]`.
3. **Geometry runs in the Worker isolate, never in the DO.** The DO only uses pure TS (`validate`, `applyOps`, diff, aliases). MCP builds with manifold after reads/writes, cached per isolate in a small LRU keyed `<modelId>:<version>` (versions are immutable). The browser builds in a Web Worker for rendering. Same `src/geometry.ts` + `src/facts.ts` in both.
4. **Writes**: reject on `validate()` issues (nothing saved). Accept build errors/empty parts and return them as `warnings`.
5. `nodejs_compat` stays on; the Worker manifold loader hides `globalThis.process` around `Module()` (kernel PLAN §4).
6. No `limits.cpu_ms` in wrangler.jsonc for now (dev doesn't need it; note in AGENTS.md that prod needs Workers Paid).
7. History: last 50 versions in the DO. Aliases table for renames/removals (feature and part ids). No role-level aliases in v1.
8. v1 ships: 7 MCP tools, DO, REST + WS, viewer, homepage, soft delete + restore, trimmed analytics, client-side STL export, smoke test. Cuts: comments, notes, embeds, server export, weekly report, history UI.

## Module contract (file ownership in brackets)

**[kernel]** `src/schema.ts`, `src/geometry.ts`, `src/facts.ts`, `src/tree.ts`, `src/manifold-worker.ts`, `src/wasm.d.ts`, `scripts/kernel-test.ts`
- `schema.ts`: types (`CadDoc`, `Part`, `Feature`, …), `parseRef`, `formatRef`, `rolesOf`, `validate(doc): Issue[]` (`{path, code, message}`), `LIMITS`, `schemaDoc(): string` (≤ ~1.5 KB, for CONTRACT + `create_model`), `emptyDoc()`.
- `tree.ts` (pure): `canonical(doc): string` (stable key order), `findFeature(doc, id)`, `allIds(doc)`, `diff(prev, next): { added, changed, removed }` (ids, by canonical feature JSON), `applyOps(doc, ops): { ok: true, doc, changed, renames, removed } | { ok: false, issues }`, `didYouMean(doc, id): string[]`.
  - Ops: `update {id, set}` (JSON merge patch on the feature, not `id`/`type`), `replace {id, feature}`, `add {feature, part?, after?}` (`part` defaults to the only part, required when several), `add_part {part}`, `remove {id}` (feature or part), `rename {id, to}` (feature or part; rewrites every `at` ref). Result validated once; issues reference op index: `op 2 (update "boss"): …`.
- `geometry.ts`: `build(manifold, doc) → BuildResult` (bodies with `positions`, `triVerts`, `triRef` index into `refs[]`, `backside`; per-feature errors).
- `facts.ts`: `indexFacts(res)`, `resolve(doc, res, facts, ref)`, `dependencies(doc, id)`.
- `manifold-worker.ts`: `loadManifold(): Promise<ManifoldToplevel>` for workerd (imports `manifold-3d/manifold.wasm` as a compiled module).
- Imports between src files use `.ts` extensions (`allowImportingTsExtensions` is on). No DOM, no node, no Worker globals in schema/tree/geometry/facts.

**[backend]** `src/index.ts`, `src/mcp.ts`, `src/model-file.ts` (DO `CadModel`, binding `MODELS`), `src/ids.ts`, `src/analytics.ts`, `wrangler.jsonc`, `scripts/smoke.mjs`
- Routes, tables, WS messages, tool names/inputs, error wording, CONTRACT: backend PLAN §1–5, adapted to decision 1 (tree has `parts`; `get_model.features` index includes `part`; `edit_features` ops as above).
- 7 tools: `create_model`, `get_model`, `resolve`, `start_edit`, `write_model`, `edit_features`, `release_edit`.
- `resolve` facts come from `facts.ts` `resolve()` (kernel mode). Each ref result also carries backend fields: `status` (ok/renamed/removed/unknown/unknown_role), `changed_since_seen`, `edit_scope`.
- Smoke test: backend PLAN §5, with the fixture rewritten in the kernel schema (bracket part: base box, mount-holes pattern hole on base.top, boss, boss-bore; plus a `lid` part). Asserts exactly 7 tools.

**[viewer]** `web/viewer.ts`, `web/kernel-worker.ts`, `web/home.ts`, other `web/*.ts`, `public/model.html`, `public/index.html`, `public/app.css`, `public/favicon.svg`
- Viewer PLAN, wired to the real kernel (Web Worker imports `../src/geometry.ts`, loads `/js/manifold.wasm`) and the real REST/WS (backend PLAN §1 WS messages, §2 routes).
- Viewer page served at `/m/<id>` from `public/model.html` (worker fetches asset `/model`). CSP `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'`.
- Copied links include `?v=<version>`. Claim: show task, pulse `scope` refs. After a `tree` message: rebuild, keep camera + selection, flash `changed`. Delete + restore card (DELETE / POST restore). STL export on E (client-side, from the built meshes).
- Homepage: what it is, the MCP URL to add (`<origin>/mcp`), recent models (localStorage), "New model" (POST /api/models).

`package.json` `build:web` (already set) bundles `web/viewer.ts web/home.ts web/kernel-worker.ts` and copies `manifold.wasm` into `public/js`.
