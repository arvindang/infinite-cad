// End-to-end check through a real MCP client: node scripts/smoke.mjs [baseUrl]
// Plays the agent: creates a model, claims and writes it, follows links to faces and
// features, makes scoped edits, renames and removes features, and checks locks,
// version conflicts, history, the REST API, the WebSocket and the trash.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] || "http://localhost:8787";
const client = new Client({ name: "smoke", version: "0" });
// "ic-test" marks our own traffic so reports can leave it out (also `curl -A ic-test` for manual checks)
const UA = { "User-Agent": "ic-test/smoke" };
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: UA } }));

const call = async (name, args, expectError = false) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  if (!!res.isError !== expectError) throw new Error(`${name} ${expectError ? "should have failed" : "failed"}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
let passed = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error(`✗ ${msg}`);
  passed++;
  console.log(`✓ ${msg}`);
};
const rest = (path, method = "GET", body) =>
  fetch(`${base}${path}`, { method, headers: { ...UA, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const featuresOf = (tree) => Object.fromEntries(tree.parts.flatMap((p) => p.features.map((f) => [f.id, JSON.stringify(f)])));

// ---------- the contract ----------

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort().join(",");
ok(tools.length === 7 && names === "create_model,edit_features,get_model,release_edit,resolve,start_edit,write_model", `lists ${tools.length} tools: ${names}`);
const instructions = client.getInstructions() || "";
ok(instructions.includes("Edit only what's linked") && instructions.includes("call resolve") && instructions.includes("Refs:"), "server instructions carry the contract and the schema");

// ---------- a new model ----------

const created = await call("create_model", { name: "Wall bracket" });
const link = created.model_link;
const id = link.split("/").pop();
ok(/\/m\/[a-z0-9]{14}$/.test(link) && created.version === 0 && created.schema?.includes("hole"), `created ${link} with the schema`);

const empty = await call("get_model", { link });
ok(empty.features.length === 0 && empty.model.version === 0 && empty.schema && empty.tree.parts.length === 0, "an empty model reads back with the schema");
ok((await call("get_model", { link: "not a link" }, true)).startsWith("Couldn't read"), "a bad link gets a clear error");

// a viewer watching over the WebSocket
const messages = [];
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/models/${id}/ws`);
ws.onmessage = (e) => messages.push(JSON.parse(e.data));
await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
ok(true, "a viewer connects over the WebSocket");

// 1. claim, then the first tree
const claim = await call("start_edit", { link, task: "Building the bracket", refs: ["base"] });
ok(claim.lock && claim.base_version === 0, "start_edit returns a lock and base_version 0");
let st = await (await rest(`/api/models/${id}`)).json();
ok(st.status === "working" && st.task === "Building the bracket" && st.scope.join() === "base", "the viewer sees the claim, its task and its scope");
await sleep(150);
ok(messages.some((m) => m.type === "claim" && m.status === "working" && m.scope.includes("base")), "the WebSocket announces the claim");

const bracket = {
  id: "bracket",
  name: "Wall bracket",
  features: [
    { id: "base", type: "box", size: [80, 40, 6] },
    { id: "mount-holes", type: "hole", diameter: 5, at: "base.top", position: [-30, -12, 0], pattern: { grid: { count: [2, 2], step: [60, 24] } } },
    { id: "boss", type: "cylinder", diameter: 16, height: 10, at: "base.top" },
    { id: "boss-bore", type: "hole", diameter: 8, depth: 12, at: "boss.top" },
  ],
};
const lid = {
  id: "lid",
  features: [
    { id: "lid-plate", type: "box", size: [40, 40, 3], position: [0, 60, 0] },
    { id: "lid-knob", type: "cylinder", diameter: 10, height: 6, at: "lid-plate.top" },
  ],
};
const tree = { units: "mm", parts: [bracket, lid] };

ok((await call("write_model", { link, tree }, true)).includes("didn't pass its lock"), "a write without the lock is rejected, and the error asks for the lock");

const broken = {
  units: "mm",
  parts: [{ id: "bracket", features: [{ id: "base", type: "box", size: [80, 40, 6] }, { id: "base", type: "hole", diameter: 5, at: "nope.top" }] }],
};
const invalid = await call("write_model", { link, tree: broken, lock: claim.lock }, true);
ok(invalid.startsWith("Invalid tree") && invalid.includes('"base" is already used') && invalid.includes('"nope"'), "an invalid tree is rejected with every problem listed");
ok((await (await rest(`/api/models/${id}`)).json()).version === 0, "nothing was saved");

const huge = { units: "mm", parts: [{ id: "bracket", features: [{ id: "base", type: "box", size: [1, 1, 1], note: "x".repeat(300 * 1024) }] }] };
ok((await call("write_model", { link, tree: huge, lock: claim.lock }, true)).includes("too large"), "an oversized tree is rejected");

const w1 = await call("write_model", { link, tree, lock: claim.lock, base_version: 0, summary: "First bracket and lid" });
ok(w1.saved.version === 1 && w1.warnings === "none", "the first tree saves as v1 with no warnings");
ok(w1.facts_source === "kernel", "the kernel builds in the Worker");
const bracketStats = w1.parts.find((p) => p.id === "bracket");
ok(bracketStats.volume_mm3 > 15000 && bracketStats.through_holes === 4, `bracket measures ${bracketStats.volume_mm3} mm³ with 4 through holes`);
st = await (await rest(`/api/models/${id}`)).json();
ok(st.status === "ready" && st.version === 1 && st.tree.parts.length === 2, "the write ends the claim and REST returns the tree");
await sleep(150);
const treeMsg = messages.find((m) => m.type === "tree" && m.version === 1);
ok(treeMsg && ["base", "mount-holes", "lid", "lid-knob"].every((x) => treeMsg.changed.includes(x)) && treeMsg.tree.parts.length === 2, "the WebSocket sends the new tree with what changed");

// 2. read it back
const m1 = await call("get_model", { link });
const holesIdx = m1.features.find((f) => f.id === "mount-holes");
const baseIdx = m1.features.find((f) => f.id === "base");
ok(holesIdx.instances === 4 && holesIdx.depends_on.includes("base.top") && holesIdx.part === "bracket", "get_model indexes features with part, instances and depends_on");
ok(["mount-holes", "boss", "boss-bore"].every((x) => baseIdx.dependents.includes(x)), "base lists everything placed on it as dependents");
ok(m1.history[0].version === 1 && m1.history[0].summary === "First bracket and lid", "history carries the summary");

// 3. a link from the person → resolve
const r1 = await call("resolve", { link: `${link}?v=1#base.top,mount-holes:2` });
const top = r1.refs[0];
const hole2 = r1.refs[1];
ok(top.status === "ok" && top.kind === "face" && top.normal?.join() === "0,0,1", `base.top is a face, normal ${top.normal}`);
ok(top.area > 2500 && top.area < 3200, `base.top's measured area (${top.area} mm²) excludes the holes and the boss`);
ok(hole2.status === "ok" && hole2.kind === "feature" && hole2.instances === 4, "mount-holes:2 resolves to the patterned feature");
ok(r1.edit_scope.join() === "base,mount-holes" && top.changed_since_seen === false && r1.seen_version === 1, "edit_scope names the features; nothing changed since v1");

const r2 = await call("resolve", { link, refs: ["bose", "base.sideways", "mount-holes.wall", "Bad Ref"] });
const [bose, sideways, ambiguous, bad] = r2.refs;
ok(bose.status === "unknown" && bose.did_you_mean.includes("boss"), "a typo comes back unknown with did_you_mean");
ok(sideways.status === "unknown_role" && sideways.roles.includes("top"), "an unknown face lists the feature's roles");
ok(ambiguous.status === "unknown" && ambiguous.message.includes("mount-holes:1.wall"), "a patterned face without an instance says which forms are valid");
ok(bad.status === "unknown" && r2.edit_scope.length === 0, "a malformed ref doesn't fail the call");
ok((await call("resolve", { link }, true)).startsWith("No refs in that link"), "resolve without refs asks for some");

// 4. the scoped edit
const e1 = await call("edit_features", { link, ops: [{ op: "update", id: "mount-holes", set: { diameter: 6 } }], base_version: 1, summary: "M5 clearance" });
ok(e1.saved.version === 2 && e1.saved.changed.join() === "mount-holes" && !e1.saved.added && !e1.saved.removed, "edit_features changes exactly one feature");
ok(e1.touched?.[0]?.ref === "mount-holes" && e1.touched[0].faces_present, "the save returns fresh facts for the touched feature");
const v1f = featuresOf((await call("get_model", { link, version: 1 })).tree);
const v2f = featuresOf((await call("get_model", { link })).tree);
ok(Object.keys(v1f).every((k) => k === "mount-holes" || v1f[k] === v2f[k]) && v1f["mount-holes"] !== v2f["mount-holes"], "every other feature is byte-identical after the scoped edit");

const stale = await call("edit_features", { link, ops: [{ op: "update", id: "base", set: { size: [90, 40, 6] } }], base_version: 1 }, true);
ok(stale.startsWith("Version conflict") && stale.includes("mount-holes"), "a stale base_version is rejected and says what changed");

const orphan = await call("edit_features", { link, ops: [{ op: "remove", id: "base" }] }, true);
ok(orphan.startsWith("Invalid edit") && orphan.includes("mount-holes"), "removing a feature others sit on is rejected and names them");
ok((await (await rest(`/api/models/${id}`)).json()).version === 2, "a rejected edit saves nothing");

// 5. renames and removals keep old links meaningful
const e2 = await call("edit_features", { link, ops: [{ op: "rename", id: "boss", to: "standoff" }] });
ok(e2.saved.renamed?.boss === "standoff", "rename reports the new id");
const bore = (await call("get_model", { link })).tree.parts[0].features.find((f) => f.id === "boss-bore");
ok(bore.at === "standoff.top", "rename rewrites the at refs that pointed at it");
const r3 = await call("resolve", { link: `${link}#boss.top` });
ok(r3.refs[0].status === "renamed" && r3.refs[0].now === "standoff.top" && r3.refs[0].kind === "face" && r3.edit_scope.join() === "standoff", "an old link follows the rename");
await call("edit_features", { link, ops: [{ op: "rename", id: "standoff", to: "post" }] });
ok((await call("resolve", { link: `${link}#boss` })).refs[0].now === "post", "renames chain: the oldest link lands on the newest id");

await call("edit_features", { link, ops: [{ op: "remove", id: "lid-knob" }] });
const gone = (await call("resolve", { link: `${link}#lid-knob` })).refs[0];
ok(gone.status === "removed" && gone.removed_in > 2 && gone.was?.type === "cylinder", "a removed feature resolves as removed, with what it was");
const reuse = await call("edit_features", { link, ops: [{ op: "add", part: "lid", feature: { id: "lid-knob", type: "cylinder", diameter: 12, height: 5, at: "lid-plate.top" } }] });
ok(reuse.warnings.some((w) => w.includes('"lid-knob" was removed')), "reusing a removed id warns that old links now point at it");
ok((await call("resolve", { link: `${link}?v=1#boss-bore,lid-plate` })).refs.map((r) => r.changed_since_seen).join() === "true,false", "?v= tells what changed since the person looked");

// 6. whole-tree rewrites
const cur = (await call("get_model", { link })).tree;
const dropped = structuredClone(cur);
dropped.parts[0].features = dropped.parts[0].features.filter((f) => f.id !== "boss-bore");
const w2 = await call("write_model", { link, tree: dropped });
ok(w2.saved.removed?.join() === "boss-bore" && w2.warnings.some((w) => w.includes("removed boss-bore")), "a rewrite that drops an id warns about its links");
const renamed = structuredClone(dropped);
renamed.parts[1].features[0].id = "lid-panel";
renamed.parts[1].features[1].at = "lid-panel.top";
const w3 = await call("write_model", { link, tree: renamed, renames: { "lid-plate": "lid-panel" } });
ok(w3.saved.renamed?.["lid-plate"] === "lid-panel" && w3.warnings === "none", "a rewrite with renames keeps links");
ok((await call("resolve", { link: `${link}#lid-plate.top` })).refs[0].now === "lid-panel.top", "the renamed face resolves through the rewrite");
const same = await call("write_model", { link, tree: renamed });
ok(same.saved.version === w3.saved.version && same.warnings.some((w) => w.startsWith("Nothing changed")), "writing the same tree makes no new version");

// 7. geometry warnings come back with the save
const empties = await call("edit_features", { link, ops: [{ op: "add", part: "lid", feature: { id: "miss", type: "box", op: "intersect", size: [1, 1, 1], position: [500, 500, 500] } }] });
ok(empties.warnings.some((w) => w.includes("empty")), "a cut that empties a part is a warning, not a rejection");
await call("edit_features", { link, ops: [{ op: "remove", id: "miss" }] });

// 8. claims
const a = await call("start_edit", { link, task: "Ribs" });
ok((await call("start_edit", { link, task: "Other" }, true)).includes("didn't pass its lock"), "a second claim without the lock asks for it");
ok((await call("start_edit", { link, task: "Other", lock: "x".repeat(20) }, true)).includes("being edited by another session"), "a second session can't take a claimed model");
const renew = await call("start_edit", { link, task: "Ribs, take two", lock: a.lock });
st = await (await rest(`/api/models/${id}`)).json();
ok(renew.lock === a.lock && st.task === "Ribs, take two", "start_edit with your own lock renews the claim");
await call("edit_features", { link, lock: a.lock, keep_claim: true, ops: [{ op: "update", id: "base", set: { size: [80, 44, 6] } }] });
ok((await (await rest(`/api/models/${id}`)).json()).status === "working", "keep_claim keeps the claim after a save");
ok((await call("release_edit", { link, lock: a.lock })) === "Released.", "release_edit gives the claim up");
ok((await (await rest(`/api/models/${id}`)).json()).status === "ready", "the viewer sees the model as ready again");

// 9. history and REST
const old = await call("get_model", { link, version: 1 });
ok(old.model.version === 1 && old.model.current_version > 1 && featuresOf(old.tree)["boss"], "get_model reads an old version");
const versions = await (await rest(`/api/models/${id}/versions`)).json();
ok(versions.length >= 10 && versions[0].version > versions[1].version, `REST lists ${versions.length} versions, newest first`);
ok((await (await rest(`/api/models/${id}/versions/1`)).json()).tree.parts.length === 2, "REST reads an old tree");
const page = await rest(`/m/${id}`);
ok(page.headers.get("x-robots-tag")?.includes("noindex") && page.headers.get("content-security-policy")?.includes("'wasm-unsafe-eval'"), "the viewer page is private and allows WASM");
ok(page.status === 200 && (page.headers.get("content-type") ?? "").includes("text/html"), "/m/<model> serves the viewer");
ok((await rest(`/api/models/${id}`, "PATCH", { name: "Bracket v2" })).ok && (await call("get_model", { link })).model.name === "Bracket v2", "a person renames the model");
const oneStep = await call("create_model", { name: "One step", tree: { parts: [{ id: "cube", features: [{ id: "body", type: "box", size: [10, 10, 10] }] }] } });
ok(oneStep.version === 1 && oneStep.parts[0].volume_mm3 === 1000, "create_model with a tree builds v1 in one call");

// 10. trash
ok((await rest(`/api/models/${id}`, "DELETE")).ok && (await rest(`/api/models/${id}`)).status === 410, "a deleted model reads as gone (410)");
const deleted = await call("get_model", { link }, true);
ok(deleted.includes("was deleted") && deleted.includes("restore it from the viewer"), "the agent hears a deleted model can be restored");
ok((await rest(`/api/models/${id}/restore`, "POST")).ok && (await call("get_model", { link })).model.name === "Bracket v2", "anyone with the link restores it");
await sleep(150);
ok(messages.some((m) => m.type === "model-deleted") && messages.some((m) => m.type === "model-restored"), "the viewer hears the delete and the restore");

const nobody = "zzzzzzzzzzzzzz";
ok((await call("get_model", { link: `${base}/m/${nobody}` }, true)).startsWith("Model not found"), "an unknown model is not found");
ok((await rest(`/api/models/${nobody}`)).status === 404, "and looking it up created nothing");

ws.close();
await client.close();
console.log(`\nAll ${passed} checks passed against ${base}`);
