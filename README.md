# Infinite CAD

Links to faces, for parts an LLM builds. The agent writes a declarative feature tree over MCP, the viewer renders it live, and you point at things with links: a part, a feature, or a single face.

```
https://<host>/m/<model>?v=12#base.top,mount-holes:2
```

The agent calls `resolve` on that link and gets exactly what you meant (the feature's JSON, the face's measured area, normal and plane, what it depends on and what depends on it, and whether it changed since you looked), then edits just those features.

No sketcher, no constraint solver, no mouse modelling on purpose. The viewer renders and links; the model designs.

## Run it

```sh
npm install
npm run dev          # http://localhost:8787  ·  MCP at http://localhost:8787/mcp
npm run smoke        # in a second terminal: drives the MCP server end to end
```

Deploy to Cloudflare (Workers Paid: the kernel needs more than the free plan's 10 ms CPU):

```sh
npx wrangler login
npm run deploy       # prints https://infinite-cad.<you>.workers.dev
```

Then in Claude: **Settings → Connectors → Add custom connector** → `https://infinite-cad.<you>.workers.dev/mcp`. Claude Code can use localhost directly:

```sh
claude mcp add --transport http infinite-cad http://localhost:8787/mcp
```

## How it fits together

```
MCP client ──► /mcp (stateless Streamable HTTP, src/mcp.ts) ── builds with manifold (WASM) in the Worker
                   │
Viewer (web/) ──► /api/models/:id/...  ──►  CadModel Durable Object (src/model-file.ts)
  three.js +           ▲                      one per model · SQLite · serializes writes · no geometry
  manifold in a        └──── WebSocket broadcast ◄──┘
  Web Worker
```

- **The tree.** `{"units":"mm","parts":[{"id","features":[…]}]}`. Each part is one solid built from an ordered list of features: `box`, `cylinder`, `sphere`, `extrude`, `revolve`, `hole`, combined with `op` (union, subtract, intersect), placed with `position`/`rotation` or `at` an earlier flat face (`"at": "base.top"`), and repeated with `pattern`. Full schema in `schemaDoc()` (src/schema.ts), which is also what the agent reads.
- **Refs.** `part`, `feature`, `feature:n` (pattern instance), `feature.role` (a face), `feature:n.role`. Roles come from the primitive (`top`, `front`, `wall`, `side-3`, …) and survive booleans: every triangle carries its ref through manifold.
- **One Durable Object per model** holds the tree, the last 50 versions, aliases and the claim. `start_edit` claims the model for 10 minutes and the viewer shows the task and highlights the refs being changed. `edit_features` / `write_model` with the lock finish it. `base_version` rejects stale writes and says what changed.
- **Scoped edits.** `edit_features` takes ops (`update` as a JSON merge patch, `replace`, `add`, `add_part`, `remove`, `rename`), applies them to the current tree, validates the result once, and saves all or nothing. Everything not named stays byte-identical.
- **Ids are addresses.** Renames record an alias, so old links resolve as `renamed` with the new ref; removed ids resolve as `removed` with what they were. Reusing a removed id warns.
- **Facts.** The Worker builds each version once (LRU per isolate) and `resolve` reads area, centroid, normal, plane offset, bbox, adjacency and patches from the mesh, plus the exact designed frame from the parameters. Part stats: volume, size, through-hole count, components.
- **Validation is structural.** A write is rejected on schema problems (bad ids, refs to later features, unknown roles, …) with every problem listed. Build problems (a cut that empties a part) come back as warnings.
- **Trash.** No auth, so anyone with a link can delete, and anyone with it can restore for 30 days; then a Durable Object alarm erases the model.

## MCP tools

| Tool | What |
|---|---|
| `create_model` | New model (optionally with its first tree); returns the link |
| `get_model` | Tree, feature index (part, op, depends_on, dependents), part stats, warnings, history; `version` reads an old tree |
| `resolve` | What a link's `#refs` mean now: status (ok / renamed / removed / unknown / unknown_role), facts, dependencies, `changed_since_seen`, `edit_scope` |
| `start_edit` | Claim the model for 10 min with a task and the refs you'll touch |
| `write_model` | Replace the whole tree (`renames` keeps links) |
| `edit_features` | The scoped edit |
| `release_edit` | Give up a claim |

## Viewer keys

| Key | Does |
|---|---|
| Click / Shift-click / Option-click | Pick a face / add or remove / its instance or feature (whole features and parts: the Features panel) |
| ⌘C | Copy the link to the selection |
| Esc | Step back: clear hover, then the selection |
| Tab / Shift+Tab | Step through features |
| B / Shift+B | Features panel / expand or collapse every feature's faces |
| F / Shift+1 | Fit the selection / the whole model (also the View menu) |
| 1–7 | Front, back, left, right, top, bottom, iso (also the View menu) |
| X | X-ray |
| M | Measure: every part's X/Y/Z and hole Ø; with a selection, only its dimensions |
| U | Units for measurements: mm, inches, metres |
| T | Light / dark |
| E | Export menu, then 1–5: STL, 3MF, STEP (exact solids), GLB, OBJ |
| Shift+⌫ | Delete the model (restorable for 30 days) |
| + / − | Zoom |

## Analytics

Events go to Workers Analytics Engine (dataset `infinite_cad_events`, layout in `src/analytics.ts`): MCP tool calls (outcome, latency, sizes, warning counts), MCP client connects, models created from the web, trash actions, and one event per viewer connection with an anonymous viewer id and time open. Model ids are hashed before they're written; trees, feature ids and refs are never recorded.
