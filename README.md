# Infinite CAD

Links to faces, for parts an LLM builds. The agent writes a declarative feature tree over MCP, the viewer renders it live, and you point at things with links: a part, a feature, or a single face.

```
https://<host>/m/<model>?v=12#base.top,mount-holes:2
```

The agent calls `resolve` on that link and gets exactly what you meant (the feature's JSON, the face's measured area, normal and plane, what it depends on and what depends on it, and whether it changed since you looked), then edits just those features.

No sketcher, no constraint solver, no mouse modelling on purpose. The viewer renders and links; the model designs.

Live: https://infinitecad.app · MCP at `https://infinitecad.app/mcp` (the original `infinite-cad.arvindang.workers.dev` still works; `www` redirects to the apex)

## Try it

1. In Claude: **Settings → Connectors → Add custom connector** → `https://infinitecad.app/mcp`. In Claude Code: `claude mcp add --transport http infinite-cad https://infinitecad.app/mcp`.
2. Ask for a part: "Make an 80×40×6 mm wall bracket with two M4 mounting holes and a 16 mm boss." The agent returns a link; open it and watch the model build.
3. Click a face, press ⌘C, and paste the link back with what to change: "…#base.top put two more holes here, 20 mm apart." The agent resolves the link and edits just that feature.
4. Export STL or 3MF to print, or STEP (exact solids) to keep going in your CAD tool.

## Run it

```sh
npm install
npm run dev          # http://localhost:8787  ·  MCP at http://localhost:8787/mcp
npm run smoke        # in a second terminal: drives the MCP server end to end
```

Deploy to Cloudflare (Workers Paid: the kernel needs more than the free plan's 10 ms CPU):

```sh
npx wrangler login
npm run deploy       # serves https://infinitecad.app (and the workers.dev URL)
```

Then in Claude: **Settings → Connectors → Add custom connector** → `https://infinitecad.app/mcp`. Claude Code can use localhost directly:

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
- **One Durable Object per model** holds the tree, every version, aliases, the claim, comment threads and the notes. `start_edit` claims the model for 10 minutes and the viewer shows the task and highlights the refs being changed. `edit_features` / `write_model` with the lock finish it. `base_version` rejects stale writes and says what changed.
- **Scoped edits.** `edit_features` takes ops (`update` as a JSON merge patch, `replace`, `add`, `add_part`, `remove`, `rename`), applies them to the current tree, validates the result once, and saves all or nothing. Everything not named stays byte-identical.
- **Ids are addresses.** Renames record an alias, so old links resolve as `renamed` with the new ref; removed ids resolve as `removed` with what they were. Reusing a removed id warns.
- **Facts.** The Worker builds each version once (LRU per isolate) and `resolve` reads area, centroid, normal, plane offset, bbox, adjacency and patches from the mesh, plus the exact designed frame from the parameters. Part stats: volume, size, through-hole count, components.
- **Validation is structural.** A write is rejected on schema problems (bad ids, refs to later features, unknown roles, …) with every problem listed. Build problems (a cut that empties a part) come back as warnings.
- **History.** Every version is kept with what it added, changed, removed and renamed. The API pages through them, diffs any two per property (following renames), and restores an old version as a new one, undoing renames made since so links keep working.
- **Comments.** People pin threads to a part, feature or face (or the whole model) at the version they're looking at, with the camera they used and the ref's measured facts. A thread follows renames and detaches when its ref is removed; the agent sees open threads in `get_model`, gets the thread plus facts then vs now from `resolve` on a `?c=<thread>` link, and replies or resolves with `comment`.
- **Notes.** One markdown doc per model for what the geometry can't show (requirements, mating parts, material, decisions), edited by people and agents with `base_version` so neither overwrites the other. `[text](#ref)` points at things; `get_model` flags refs that were renamed or removed.
- **Trash.** No auth, so anyone with a link can delete, and anyone with it can restore for 30 days; then a Durable Object alarm erases the model.

## MCP tools

| Tool | What |
|---|---|
| `create_model` | New model (optionally with its first tree); returns the link |
| `get_model` | Tree, feature index (part, op, depends_on, dependents), part stats, warnings, history, open comments, notes; `version` reads an old tree (every version is kept) |
| `resolve` | What a link's `#refs` mean now: status (ok / renamed / removed / unknown / unknown_role), facts, dependencies, `changed_since_seen`, `edit_scope`. A comment link (`?c=<thread>`) also returns the thread, what it's pinned to now, and facts then vs now |
| `start_edit` | Claim the model for 10 min with a task and the refs you'll touch |
| `write_model` | Replace the whole tree (`renames` keeps links) |
| `edit_features` | The scoped edit |
| `release_edit` | Give up a claim |
| `comment` | Reply to, resolve or reopen a thread people started (`?c=<thread>` link) |
| `write_notes` | Replace the model's notes (whole markdown doc, with `base_version`) |

## Viewer keys

| Key | Does |
|---|---|
| Click / Shift-click / Option-click | Pick a face / add or remove / its instance or feature (whole features and parts: the Features panel) |
| ⌘C | Copy the link to the selection |
| Esc | Step back: close the popover, compare, comment mode, the side panel, a past version; then clear hover and the selection |
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
| C | Comment mode; with a selection, comment on it; again to leave comment mode |
| Shift+C | Show resolved comments |
| [ / ] | With a thread open: previous / next thread on this face |
| Enter / ⌘↵ / Esc | In a comment: send / send and resolve / close |
| H | History panel; ↑ / ↓ move through versions, Enter views one |
| Esc | Viewing a past version: back to latest |
| Shift+R | Restore the viewed version (press twice) |
| D | Compare the viewed or focused version with the latest |
| G | Ghost overlay (in compare) |
| [ / ], Shift+[ / Shift+] | In compare: step the older / newer side |
| N | Notes panel; Enter edits, ⌘↵ saves, Esc saves and closes |

## Analytics

Events go to Workers Analytics Engine (dataset `infinite_cad_events`, layout in `src/analytics.ts`): MCP tool calls (outcome, latency, sizes, warning counts), MCP client connects, models created from the web, trash actions, comment actions (create, reply, resolve, reopen, edit, delete), notes edits (with their length), version restores, and one event per viewer connection with an anonymous viewer id and time open. Model ids are hashed before they're written; trees, feature ids, refs, comment text and notes are never recorded.

## Not built yet

Auth (model ids are unguessable capability URLs for now; anyone with a link can edit, comment or delete) · per-feature claims · cross-part booleans · fillets and chamfers · server-side export (every export runs in the browser).

## License

[FSL-1.1-ALv2](LICENSE.md). Use, modify and self-host it for anything except a competing hosted service; each version becomes Apache 2.0 two years after it's released.
