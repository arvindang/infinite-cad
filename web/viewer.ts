// The model viewer at /m/<id>: renders the feature tree live, picks faces and features by ref,
// and copies links (…/m/<id>?v=<n>#base.top,mount-holes:2) to paste back to the agent.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { type Body, disposeBody, toBody } from "./mesh";
import { type ExportFormat, FORMATS, exportBodies } from "./export";
import { type Dim, DimLayer, type Unit, UNITS, boxDims, faceDims } from "./measure";
import type { BuildReply, BuildRequest } from "./kernel-worker";
import type { StepReply, StepRequest } from "./step-worker";
import { parseRef, type CadDoc, type Ref } from "../src/schema.ts";
import { $, MOD, copy, escapeHtml, prefs, rememberModel, toast, viewerId, wireCopyButtons } from "./shared";

const modelId = location.pathname.split("/")[2] ?? "";
const phone = matchMedia("(max-width: 820px)");
const coarse = matchMedia("(pointer: coarse)");
const linkedVersion = Number(new URLSearchParams(location.search).get("v")) || 0;

interface ModelState {
  id: string;
  name: string;
  version: number;
  status: "working" | "ready";
  task: string | null;
  scope: string[];
  lockExpiresAt: number | null;
  tree: CadDoc;
}
type Claim = Pick<ModelState, "status" | "task" | "scope" | "lockExpiresAt">;
type BuildError = { featureId: string; message: string };

// ---------- theme ----------
type Theme = "light" | "dark";
const sysDark = matchMedia("(prefers-color-scheme: dark)");
let theme: Theme = prefs.get<Theme | null>("theme", null) ?? (sysDark.matches ? "dark" : "light");
const PALETTE = {
  light: { bg: 0xececea, body: 0xc4c7cc, edge: 0x2b2d31, grid1: 0xdadad6, grid2: 0xc6c6c2, accent: 0x4f46e5, flash: 0xf59e0b, dim: 0x0b7285 },
  dark: { bg: 0x161617, body: 0x7d8189, edge: 0x0c0c0d, grid1: 0x222224, grid2: 0x2f2f32, accent: 0x8b85ff, flash: 0xfbbf24, dim: 0x66d9e8 },
};
const pal = () => PALETTE[theme];

// ---------- three ----------
const canvas = $<HTMLCanvasElement>("#view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100000);
camera.up.set(0, 0, 1); // CAD: Z up, mm
camera.position.set(120, -160, 110);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
controls.screenSpacePanning = true;
controls.zoomToCursor = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a90, 1.4));
const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
headlight.position.set(0.4, 0.6, 1); // follows the camera: whatever you look at is lit
camera.add(headlight);
scene.add(camera);
const material = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.85, metalness: 0,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, // lines sit on top
});
const edgeMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 });
let grid: THREE.GridHelper | null = null;

// ---------- model ----------
let state: ModelState | null = null; // latest from the server
let doc: CadDoc = { units: "mm", parts: [] }; // the tree that's on screen
let shownVersion = 0; // the version that's on screen
let errors: BuildError[] = [];
let failed: { version: number; lines: string[] } | null = null; // newest version didn't build at all
let bodies: Body[] = [];
let allRefs: string[] = [];
const refInfo = new Map<string, { ref: Ref; body: Body; index: number }>();
const partOfFeature = new Map<string, string>();
const partIds = new Set<string>();

function setModel(meshes: Body[], next: CadDoc) {
  for (const b of bodies) {
    scene.remove(b.mesh, b.edges);
    disposeBody(b);
  }
  bodies = meshes;
  doc = next;
  for (const b of bodies) scene.add(b.mesh, b.edges);
  hoverKey = null;
  hoverRefs = new Set();
  moveDirty = true; // re-pick under the cursor
  refInfo.clear();
  for (const b of bodies) b.refs.forEach((r, index) => {
    const ref = parseRef(r);
    if (ref) refInfo.set(r, { ref, body: b, index });
  });
  allRefs = [...refInfo.keys()];
  partOfFeature.clear();
  partIds.clear();
  for (const p of doc.parts) {
    partIds.add(p.id);
    for (const f of p.features) partOfFeature.set(f.id, p.id);
  }
  faceCache.clear();
  gapCache = 0;
  sizeGrid();
  paintAll();
  refreshDims();
}
const triCount = () => bodies.reduce((n, b) => n + b.triRef.length, 0);

// ---------- refs: keys are what links say ----------
/** A link key (part, feature, feature:n, feature.role, feature:n.role) to the face refs it covers. */
function expand(key: string): string[] {
  if (partIds.has(key)) return allRefs.filter((r) => refInfo.get(r)!.body.id === key);
  const k = parseRef(key);
  if (!k) return [];
  return allRefs.filter((r) => {
    const p = refInfo.get(r)!.ref;
    return p.id === k.id && (k.instance == null || p.instance === k.instance) && (k.role == null || p.role === k.role);
  });
}
/** One level up: face → instance → feature → part. A part is the top. */
function parent(key: string): string | null {
  if (partIds.has(key)) return null;
  const k = parseRef(key);
  if (!k) return null;
  if (k.role) return k.instance ? `${k.id}:${k.instance}` : k.id;
  if (k.instance) return k.id;
  return partOfFeature.get(k.id) ?? null;
}
const exists = (key: string) => expand(key).length > 0 || partIds.has(key) || partOfFeature.has(key);

// ---------- highlight: vertex colors, one draw call, per-ref range writes ----------
let selection: string[] = [];
let selectedRefs = new Set<string>();
let hoverRefs = new Set<string>();
let hoverKey: string | null = null;
const flashAmt = new Map<string, number>();
let pulseRefs = new Set<string>();
let pulseAmt = 0;
const tmp = new THREE.Color();
const accentC = new THREE.Color();
const flashC = new THREE.Color();
function paintRef(b: Body, r: number) {
  const ref = b.refs[r];
  const p = pal();
  tmp.setHex(p.body);
  accentC.setHex(p.accent);
  const sel = selectedRefs.has(ref), hov = hoverRefs.has(ref);
  if (sel) tmp.lerp(accentC, hov ? 0.9 : 0.75);
  else if (hov) tmp.lerp(accentC, 0.35);
  else if (pulseRefs.has(ref)) tmp.lerp(accentC, pulseAmt);
  const f = flashAmt.get(ref);
  if (f) tmp.lerp(flashC.setHex(p.flash), f);
  const R = Math.round(tmp.r * 255), G = Math.round(tmp.g * 255), B = Math.round(tmp.b * 255);
  const a = b.color.array as Uint8Array;
  const { start, count } = b.range[r];
  for (let v = start * 3, end = (start + count) * 3; v < end; v += 3) {
    a[v] = R; a[v + 1] = G; a[v + 2] = B;
  }
  b.color.addUpdateRange(start * 3, count * 3);
  b.color.needsUpdate = true;
}
function paintAll() {
  for (const b of bodies) {
    for (let r = 0; r < b.refs.length; r++) paintRef(b, r);
    b.color.clearUpdateRanges(); // upload the whole buffer
  }
  const p = pal();
  scene.background = new THREE.Color(p.bg);
  edgeMaterial.color.setHex(p.edge);
  needsRender = true;
}
function repaint(refs: Iterable<string>) {
  for (const ref of refs) {
    const info = refInfo.get(ref);
    if (info) paintRef(info.body, info.index);
  }
  needsRender = true;
}

// ---------- selection ----------
function setSelection(keys: string[], opts: { fit?: boolean; hash?: boolean } = {}) {
  selection = [...new Set(keys)];
  const prev = selectedRefs;
  selectedRefs = new Set(selection.flatMap(expand));
  repaint([...prev, ...selectedRefs]);
  if (opts.hash !== false) syncUrl();
  if (opts.fit && selectedRefs.size) fitRefs([...selectedRefs]);
  renderSelBar();
  markTree();
  refreshDims();
}
/** The address bar is always the link you'd copy. */
function syncUrl() {
  const url = `/m/${modelId}${shownVersion ? `?v=${shownVersion}` : ""}${selection.length ? `#${selection.join(",")}` : ""}`;
  if (location.pathname + location.search + location.hash !== url) history.replaceState(null, "", url);
}
/** Add or remove one key; adding drops keys it covers and keys that cover it. */
function toggleKey(key: string) {
  if (selection.includes(key)) return setSelection(selection.filter((k) => k !== key));
  const inner = new Set(expand(key));
  const keep = selection.filter((k) => {
    const e = expand(k);
    if (!e.length) return true;
    if (e.every((r) => inner.has(r))) return false; // inside the new one
    return ![...inner].every((r) => e.includes(r)); // around the new one
  });
  setSelection([...keep, key]);
}
function setHover(key: string | null) {
  if (key === hoverKey) return;
  hoverKey = key;
  const prev = hoverRefs;
  hoverRefs = new Set(key ? expand(key) : []);
  repaint([...prev, ...hoverRefs]);
  document.querySelectorAll(".tree .row.hover").forEach((n) => n.classList.remove("hover"));
  if (key) document.querySelector(`.tree [data-key="${CSS.escape(key)}"]`)?.classList.add("hover");
}
// ---------- picking ----------
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const ndc = new THREE.Vector2();
function pickAt(x: number, y: number): string | null {
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(bodies.map((b) => b.mesh), false)[0];
  if (!hit?.face) return null;
  const b = bodies.find((x) => x.mesh === hit.object)!;
  // The BVH reorders the index it adds, so faceIndex isn't our triangle order; the
  // non-indexed positions are (vertex / 3 = triangle).
  return b.refs[b.triRef[Math.floor(hit.face.a / 3)]];
}
/** A click picks the face; Option picks the level around it (its instance or feature). */
function keyFor(ref: string, up: boolean): string {
  return (up && parent(ref)) || ref;
}
const tip = $("#tip");
let lastMove: { x: number; y: number; alt: boolean } | null = null;
let moveDirty = false;
let down: { x: number; y: number; t: number } | null = null;
let multi = false; // touch's Shift
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") return;
  lastMove = { x: e.clientX, y: e.clientY, alt: e.altKey };
  moveDirty = true;
});
canvas.addEventListener("pointerleave", () => {
  lastMove = null;
  setHover(null);
  tip.hidden = true;
});
canvas.addEventListener("pointerdown", (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now() };
  closePops();
});
canvas.addEventListener("pointerup", (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || performance.now() - down.t > 600;
  down = null;
  if (moved || e.button !== 0) return; // an orbit or pan
  const ref = pickAt(e.clientX, e.clientY);
  if (!ref) {
    if (!e.shiftKey && !multi) setSelection([]);
    return;
  }
  const key = keyFor(ref, e.altKey);
  if (e.shiftKey || multi) toggleKey(key);
  else setSelection(selection.length === 1 && selection[0] === key ? [] : [key]);
});
canvas.addEventListener("dblclick", () => selectedRefs.size && fitRefs([...selectedRefs]));
function hoverFrame() {
  if (!moveDirty || !lastMove || down) return;
  moveDirty = false;
  const ref = pickAt(lastMove.x, lastMove.y);
  const key = ref ? keyFor(ref, lastMove.alt) : null;
  setHover(key);
  canvas.style.cursor = key ? "pointer" : "";
  tip.hidden = !key;
  if (key) {
    tip.textContent = key;
    tip.style.transform = `translate(${lastMove.x + 14}px, ${lastMove.y + 16}px)`;
  }
}
// holding Option previews the level it would pick
for (const type of ["keydown", "keyup"] as const)
  addEventListener(type, (e) => {
    if (e.key !== "Alt" || !lastMove) return;
    lastMove.alt = type === "keydown";
    moveDirty = true;
  });

// ---------- camera ----------
let anim: { from: THREE.Vector3[]; to: THREE.Vector3[]; t0: number } | null = null;
let visibleAspect = 1;
function flyTo(target: THREE.Vector3, position: THREE.Vector3) {
  anim = { from: [controls.target.clone(), camera.position.clone()], to: [target, position], t0: performance.now() };
  needsRender = true;
}
function landNow() {
  if (anim) anim.t0 = -1e9;
}
function boxOfRefs(refs: string[]) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const ref of refs) {
    const info = refInfo.get(ref);
    if (!info) continue;
    const pos = info.body.mesh.geometry.attributes.position.array as Float32Array;
    const { start, count } = info.body.range[info.index];
    for (let i = start; i < start + count; i++) box.expandByPoint(v.fromArray(pos, i * 3));
  }
  return box;
}
function fitBox(box: THREE.Box3, dir?: THREE.Vector3) {
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 3);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(fov / 2) * visibleAspect);
  const dist = (r / Math.sin(Math.min(fov, hfov) / 2)) * 1.25;
  const d = (dir ?? camera.position.clone().sub(controls.target)).normalize();
  flyTo(sphere.center.clone(), sphere.center.clone().addScaledVector(d, dist));
}
const fitRefs = (refs: string[]) => fitBox(boxOfRefs(refs));
const fitAll = (dir?: THREE.Vector3) => fitBox(boxOfRefs(allRefs), dir);
const fitSelectionOrAll = () => (selectedRefs.size ? fitRefs([...selectedRefs]) : fitAll());
// +Z up, front looks along +Y (box front is -Y)
const VIEWS: Record<string, [number, number, number]> = {
  "1": [0, -1, 0], "2": [0, 1, 0], "3": [-1, 0, 0], "4": [1, 0, 0], "5": [0, -0.0001, 1], "6": [0, -0.0001, -1], "7": [1, -1, 0.8],
};
const VIEW_NAMES: Record<string, string> = { "1": "Front", "2": "Back", "3": "Left", "4": "Right", "5": "Top", "6": "Bottom", "7": "Iso" };
let currentView: string | null = null;
function markView(k: string | null) {
  currentView = k;
  $("#viewLabel").textContent = k ? VIEW_NAMES[k] : "View";
  document.querySelectorAll<HTMLElement>("#viewMenu [data-view]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.view === k)));
}
function setView(k: string) {
  fitAll(new THREE.Vector3(...VIEWS[k]));
  markView(k);
  closeViewMenu();
  toast(VIEW_NAMES[k], 700);
}
// orbiting away from a named view drops its name from the menu button
controls.addEventListener("end", () => {
  if (!currentView) return;
  const want = new THREE.Vector3(...VIEWS[currentView]).normalize();
  const have = camera.position.clone().sub(controls.target).normalize();
  if (want.dot(have) < 0.9995) markView(null);
});
function sizeGrid() {
  const box = boxOfRefs(allRefs);
  if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 0));
  const size = box.getSize(new THREE.Vector3());
  const span = Math.ceil((Math.max(size.x, size.y) * 3) / 100) * 100 || 200;
  if (grid) {
    scene.remove(grid);
    grid.dispose();
  }
  const p = pal();
  grid = new THREE.GridHelper(span, span / 10, p.grid2, p.grid1); // 10 mm cells
  grid.rotation.x = Math.PI / 2; // into XY
  grid.position.set(Math.round(box.getCenter(new THREE.Vector3()).x / 10) * 10, Math.round(box.getCenter(new THREE.Vector3()).y / 10) * 10, box.min.z - 0.01);
  scene.add(grid);
}

// ---------- kernel worker ----------
const worker = new Worker("/js/kernel-worker.js", { type: "module" });
let seq = 0;
let building: { seq: number; version: number; tree: CadDoc; changed?: string[]; summary?: string } | null = null;
let firstBuild = true;
function requestBuild(version: number, tree: CadDoc, extra: { changed?: string[]; summary?: string } = {}) {
  building = { seq: ++seq, version, tree, ...extra };
  renderSelBar();
  worker.postMessage({ seq, doc: tree } satisfies BuildRequest);
}
worker.addEventListener("message", (e: MessageEvent<BuildReply>) => {
  const r = e.data;
  if (!building || r.seq !== building.seq) return; // a newer version is on its way
  const job = building;
  building = null;
  if ("fatal" in r) {
    failed = { version: job.version, lines: [`The geometry kernel stopped: ${escapeHtml(r.fatal)}`] };
    return renderStatus();
  }
  if (r.issues.length || (!r.bodies.length && job.tree.parts.length && bodies.length)) {
    // keep the last version that built
    failed = {
      version: job.version,
      lines: r.issues.length
        ? r.issues.map((i) => `<code>${escapeHtml(i.path)}</code> ${escapeHtml(i.message)}`)
        : r.errors.map((x) => `<button class="id" data-key="${escapeHtml(x.featureId)}">${escapeHtml(x.featureId)}</button> ${escapeHtml(x.message)}`),
    };
    if (job.summary) toast(`v${job.version} didn't build`, 3000);
    return renderStatus();
  }
  failed = null;
  errors = r.errors;
  const before = shownVersion;
  shownVersion = job.version;
  setModel(r.bodies.map((m) => toBody(m, material, edgeMaterial)), job.tree);
  renderTree();
  const first = firstBuild && bodies.length > 0;
  if (!first) {
    setSelection(selection, { hash: false }); // refs are stable: the same keys find the new faces
    syncUrl();
  }
  renderStatus();
  if (job.changed?.length) {
    flash(job.changed);
    toast(`v${job.version}${job.summary ? ` · ${escapeHtml(job.summary)}` : ""}`, 3000);
  }
  if (first) {
    firstBuild = false;
    if (!applyHash()) fitAll();
    landNow();
    if (linkedVersion && linkedVersion < job.version && before === 0) changedSinceLink(linkedVersion);
  }
  setClaim(claim); // scope refs may have appeared
});
worker.addEventListener("error", (e) => {
  failed = { version: state?.version ?? 0, lines: [`Couldn't load the geometry kernel: ${escapeHtml(e.message || "unknown error")}`] };
  renderStatus();
});

// ---------- flash what changed ----------
const FLASH_MS = 1100;
let flashT0 = 0;
let flashRefs: string[] = [];
function flash(featureIds: string[]) {
  const ids = new Set(featureIds);
  flashRefs = allRefs.filter((r) => ids.has(refInfo.get(r)!.ref.id) || ids.has(refInfo.get(r)!.body.id));
  flashT0 = performance.now();
}
function stepFlash(now: number) {
  if (!flashRefs.length) return;
  const k = Math.max(0, 1 - (now - flashT0) / FLASH_MS);
  for (const r of flashRefs) flashAmt.set(r, k * k * 0.85);
  repaint(flashRefs);
  if (k === 0) {
    for (const r of flashRefs) flashAmt.delete(r);
    flashRefs = [];
  }
}
/** Opened a link from an older version: show what changed since. */
async function changedSinceLink(v: number) {
  try {
    const res = await fetch(`/api/models/${modelId}/versions`);
    if (!res.ok) return;
    const list = (await res.json()) as { version: number; changed: string[] }[];
    const changed = [...new Set(list.filter((x) => x.version > v).flatMap((x) => x.changed))];
    if (!changed.length) return;
    flash(changed);
    toast(`This link is from v${v}. Changed since: ${changed.slice(0, 6).map((c) => `<code>${escapeHtml(c)}</code>`).join(", ")}${changed.length > 6 ? ` and ${changed.length - 6} more` : ""}`, 6000);
  } catch {}
}

// ---------- claim: the agent holds the edit lock ----------
let claim: Claim = { status: "ready", task: null, scope: [], lockExpiresAt: null };
const claimActive = () => claim.status === "working" && (!claim.lockExpiresAt || claim.lockExpiresAt > Date.now());
function setClaim(c: Claim) {
  claim = c;
  const on = claimActive();
  const pill = $("#working");
  pill.hidden = !on;
  document.body.classList.toggle("working-on", on);
  pill.querySelector(".task")!.textContent = on && c.task ? c.task : "";
  pill.title = on && c.scope?.length ? `Scope: ${c.scope.join(", ")}` : "";
  const prev = pulseRefs;
  pulseRefs = new Set(on ? (c.scope ?? []).flatMap(expand) : []);
  if (!pulseRefs.size) pulseAmt = 0;
  repaint([...prev, ...pulseRefs]);
  renderStatus();
}
setInterval(() => {
  if (claim.status === "working" && !claimActive()) setClaim({ ...claim, status: "ready" });
}, 10000);
function stepPulse(now: number) {
  if (!pulseRefs.size) return;
  pulseAmt = 0.08 + 0.3 * (0.5 + 0.5 * Math.sin((now / 1400) * Math.PI * 2));
  repaint(pulseRefs);
}

// ---------- features panel ----------
const treeEl = $("#tree");
const openFeatures = new Set<string>();
function renderTree() {
  const errored = new Set(errors.map((e) => e.featureId));
  const present = new Map<string, Ref[]>(); // feature id -> refs on screen
  for (const r of allRefs) {
    const p = refInfo.get(r)!.ref;
    if (!present.has(p.id)) present.set(p.id, []);
    present.get(p.id)!.push(p);
  }
  const role = (key: string, label: string) => `<li><button class="row role" data-key="${key}"><span class="id">${label}</span></button></li>`;
  treeEl.innerHTML = !doc.parts.length ? `<li class="none">No parts yet</li>` : doc.parts.map((part) => `
    <li><button class="row part ${errored.has(part.id) ? "err" : ""}" data-key="${part.id}"><span class="id">${part.id}</span><span class="op">${escapeHtml(part.name ?? "part")}</span></button>
      <ol>${part.features.map((f) => {
        const refs = present.get(f.id) ?? [];
        const instances = [...new Set(refs.map((r) => r.instance).filter((n): n is number => n != null))].sort((a, b) => a - b);
        const roles = (inst?: number) => [...new Set(refs.filter((r) => r.instance === inst && r.role).map((r) => r.role!))]
          .map((ro) => role(`${f.id}${inst ? `:${inst}` : ""}.${ro}`, `.${ro}`)).join("");
        const kids = instances.length
          ? instances.map((n) => `<li><button class="row inst" data-key="${f.id}:${n}"><span class="id">:${n}</span></button><ol>${roles(n)}</ol></li>`).join("")
          : roles();
        return `<li class="feat ${openFeatures.has(f.id) ? "open" : ""}" data-feature="${f.id}">
          <button class="row ${errored.has(f.id) ? "err" : ""} ${refs.length ? "" : "absent"}" data-key="${f.id}" title="${escapeHtml(f.note ?? "")}">
            <span class="caret" data-act="toggle" aria-label="Show faces">${kids ? `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M6.5 4 11.5 9 6.5 14" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ""}</span><span class="id">${f.id}</span><span class="op">${f.type}${f.pattern ? ` ×${instances.length || "?"}` : ""}</span>
          </button><ol>${kids}</ol></li>`;
      }).join("")}</ol>
    </li>`).join("");
  markTree();
}
/** Selection and hover classes only: the tree's markup is rebuilt per version, not per click. */
function markTree() {
  const sel = new Set(selection);
  treeEl.querySelectorAll<HTMLElement>("[data-key]").forEach((n) => {
    const key = n.dataset.key!;
    const covered = !sel.has(key) && expand(key).length > 0 && expand(key).every((r) => selectedRefs.has(r));
    n.classList.toggle("on", sel.has(key));
    n.classList.toggle("in", covered);
  });
  // open the features that hold a selected face so it's visible
  for (const key of selection) {
    const k = parseRef(key);
    if (k && (k.role || k.instance)) {
      treeEl.querySelector(`.feat[data-feature="${CSS.escape(k.id)}"]`)?.classList.add("open");
    }
  }
  treeEl.querySelector(".row.on")?.scrollIntoView({ block: "nearest" });
  syncTreeAll();
}
treeEl.addEventListener("click", (e) => {
  const t = e.target as Element;
  if (t.closest("[data-act=toggle]")) {
    const li = t.closest<HTMLElement>(".feat")!;
    li.classList.toggle("open");
    const id = li.dataset.feature!;
    li.classList.contains("open") ? openFeatures.add(id) : openFeatures.delete(id);
    syncTreeAll();
    return;
  }
  const key = t.closest<HTMLElement>("[data-key]")?.dataset.key;
  if (!key) return;
  if (e.shiftKey || multi) toggleKey(key);
  else setSelection([key]);
});
treeEl.addEventListener("dblclick", (e) => {
  const key = (e.target as Element).closest<HTMLElement>("[data-key]")?.dataset.key;
  if (key) fitRefs(expand(key));
});
treeEl.addEventListener("pointerover", (e) => setHover((e.target as Element).closest<HTMLElement>("[data-key]")?.dataset.key ?? null));
treeEl.addEventListener("pointerleave", () => setHover(null));
/** Shift+B: expand every feature's faces, or collapse them all when all are already open. */
function toggleAllFeatures() {
  const feats = [...treeEl.querySelectorAll<HTMLElement>(".feat")].filter((li) => li.querySelector("[data-act=toggle] svg"));
  const open = feats.some((li) => !li.classList.contains("open"));
  for (const li of feats) {
    li.classList.toggle("open", open);
    open ? openFeatures.add(li.dataset.feature!) : openFeatures.delete(li.dataset.feature!);
  }
  if (open) setTreeOpen(true);
  syncTreeAll();
}
function syncTreeAll() {
  const feats = [...treeEl.querySelectorAll<HTMLElement>(".feat")].filter((li) => li.querySelector("[data-act=toggle] svg"));
  const allOpen = feats.length > 0 && feats.every((li) => li.classList.contains("open"));
  $("#treeAllLabel").textContent = allOpen ? "Collapse all" : "Expand all";
  ($("#treeAllBtn") as HTMLButtonElement).disabled = !feats.length;
}
$("#treeAllBtn").addEventListener("click", toggleAllFeatures);

function setTreeOpen(on: boolean) {
  if (on && phone.matches) closeViewSheet();
  document.body.classList.toggle("tree-open", on);
  $("#treeBtn").setAttribute("aria-pressed", String(on));
  if (!phone.matches) prefs.set("tree", on);
  resize();
}

// ---------- selection bar ----------
const link = () => `${location.origin}/m/${modelId}${shownVersion ? `?v=${shownVersion}` : ""}${selection.length ? `#${selection.join(",")}` : ""}`;
function renderSelBar() {
  const bar = $("#selBar");
  const n = selection.length;
  bar.classList.toggle("idle", !n);
  if (n) {
    const chips = selection.map((k) => {
      const gone = !exists(k);
      return `<span class="chip ${gone ? "gone" : ""}" title="${gone ? "Not in this version" : escapeHtml(expand(k).join(", "))}">${escapeHtml(k)}${gone ? " · gone" : ""}</span>`;
    }).join("");
    const up = selection.some((k) => parent(k));
    bar.innerHTML = `<div class="chips">${chips}</div>
      <div class="actions">
        ${coarse.matches && up ? `<button class="btn" data-act="parent" title="Select the feature or part around it">↑ Up</button>` : ""}
        ${coarse.matches ? `<button class="btn" data-act="multi" aria-pressed="${multi}" title="Tap more faces to add or remove them">+ Add</button>` : ""}
        <button class="btn primary" data-act="copy" title="Copy a link to the selection (${MOD}C)">Copy link <kbd>${MOD}C</kbd></button>
        <button class="btn" data-act="clear" title="Clear (Esc)" aria-label="Clear selection">✕ <kbd>Esc</kbd></button>
      </div>`;
    return;
  }
  bar.innerHTML = measuring && doc.parts.length && !(building && firstBuild)
    ? `<span class="hint">Measuring every part · <b>${coarse.matches ? "Tap" : "Click"}</b> a face to measure only it${coarse.matches ? "" : ` · <kbd>U</kbd> ${unit}`}</span>`
    : building && firstBuild
    ? `<span class="hint"><span class="pulse"></span> Building…</span>`
    : !doc.parts.length
      ? `<span class="hint">Nothing to select yet</span>`
      : coarse.matches
        ? `<span class="hint"><b>Tap</b> a face to select it</span>`
        : `<span class="hint"><b>Click</b> a face to select it · <kbd>⇧</kbd> add · <kbd>⌥</kbd> its feature</span>`;
}
$("#selBar").addEventListener("click", (e) => {
  const act = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
  if (act === "copy") copyLink();
  if (act === "clear") setSelection([]);
  if (act === "multi") {
    multi = !multi;
    renderSelBar();
  }
  if (act === "parent") setSelection(selection.map((k) => parent(k) ?? k));
});
function copyLink() {
  const n = selection.length;
  copy(link(), n ? `Copied link to ${n === 1 ? selection[0] : `${n} refs`}` : "Copied model link");
}

// ---------- deep links ----------
/** Select the link's refs and frame them. A face that's gone falls back to its feature. */
function applyHash(): boolean {
  const keys = decodeURIComponent(location.hash.slice(1)).split(",").map((s) => s.trim()).filter(Boolean);
  if (!keys.length) return false;
  const resolved = keys.map((k) => {
    if (exists(k)) return k;
    for (let p: string | null | undefined = parent(k) ?? parseRef(k)?.id; p; p = parent(p)) if (exists(p)) return p;
    return k;
  });
  const fellBack = keys.filter((k, i) => resolved[i] !== k);
  const lost = resolved.filter((k) => !exists(k));
  setSelection(resolved, { fit: true });
  if (!selectedRefs.size) fitAll();
  const msgs = [
    lost.length ? `Not in this version: ${lost.map((k) => `<code>${escapeHtml(k)}</code>`).join(", ")}` : "",
    fellBack.length ? `Gone, selected what's around it: ${fellBack.map((k) => `<code>${escapeHtml(k)}</code>`).join(", ")}` : "",
  ].filter(Boolean);
  if (msgs.length) toast(msgs.join("<br>"), 5000);
  return true;
}
addEventListener("hashchange", () => applyHash());

// ---------- status: build errors, empty model ----------
function renderStatus() {
  const card = $("#errors");
  const v = $("#version");
  v.textContent = failed && shownVersion ? `v${failed.version} · showing v${shownVersion}` : shownVersion ? `v${shownVersion}` : state ? `v${state.version}` : "v–";
  document.body.classList.toggle("stale", !!failed && bodies.length > 0);
  if (failed) {
    card.hidden = false;
    card.innerHTML = `<h3>Version ${failed.version} didn't build</h3>
      <p>${shownVersion ? `Showing v${shownVersion}, the last one that did.` : "Nothing to show yet."}</p>
      <ol>${failed.lines.map((l) => `<li>${l}</li>`).join("")}</ol>`;
  } else if (errors.length) {
    card.hidden = false;
    card.innerHTML = `<h3>Built without ${errors.length === 1 ? "one feature" : `${errors.length} features`}</h3>
      <ol>${errors.map((x) => `<li><button class="id" data-key="${escapeHtml(x.featureId)}">${escapeHtml(x.featureId)}</button> ${escapeHtml(x.message)}</li>`).join("")}</ol>`;
  } else card.hidden = true;
  $("#empty").hidden = !(state && !doc.parts.length && !building && !failed && !claimActive() && $("#trashed").hidden);
  renderSelBar();
}
$("#errors").addEventListener("click", (e) => {
  const key = (e.target as Element).closest<HTMLElement>("[data-key]")?.dataset.key;
  if (key) setSelection([key], { fit: true });
});

// ---------- view settings ----------
function setTheme(t: Theme) {
  theme = t;
  document.documentElement.dataset.theme = t;
  prefs.set("theme", t);
  sizeGrid();
  paintAll();
  dimLayer.setColor(pal().dim);
}
let xray = false;
function setXray(on: boolean) {
  xray = on;
  material.transparent = on;
  material.opacity = on ? 0.35 : 1;
  material.depthWrite = !on;
  material.needsUpdate = true;
  $("#xrayBtn").setAttribute("aria-pressed", String(on));
  needsRender = true;
}
function stepFeature(dir: 1 | -1) {
  const ids = doc.parts.flatMap((p) => p.features.map((f) => f.id));
  if (!ids.length) return;
  const last = selection.at(-1);
  const cur = last ? ids.indexOf(parseRef(last)?.id ?? "") : -1;
  const next = ids[cur < 0 ? (dir > 0 ? 0 : ids.length - 1) : (cur + dir + ids.length) % ids.length];
  setSelection([next]);
}
// ---------- measure ----------
let measuring = false;
let unit: Unit = UNITS.includes(prefs.get<Unit>("unit", "mm")) ? prefs.get<Unit>("unit", "mm") : "mm";
const dimLayer = new DimLayer($("#dims"));
scene.add(dimLayer.group);
const faceCache = new Map<string, ReturnType<typeof faceDims>>(); // per build: ref -> its dimensions
let gapCache = 0;
/** How far dimension lines stand off the model: a share of its size, the same for every face. */
function modelGap() {
  if (!gapCache) {
    const size = boxOfRefs(allRefs).getSize(new THREE.Vector3());
    gapCache = Math.max(Math.max(size.x, size.y, size.z) * 0.06, 1);
  }
  return gapCache;
}
function dimsOfFace(ref: string) {
  let d = faceCache.get(ref);
  if (!d) {
    const info = refInfo.get(ref)!;
    const { start, count } = info.body.range[info.index];
    d = faceDims(info.body.mesh.geometry.attributes.position.array as Float32Array, start, count, modelGap() * 0.6);
    faceCache.set(ref, d);
  }
  return d;
}
/** A box's X/Y/Z, plus the Ø of every round wall inside it (which give way to the box when labels collide). */
function dimsOfRefs(refs: string[], priority: number): Dim[] {
  const round = refs.flatMap((r) => {
    const f = dimsOfFace(r);
    return f.shape === "cylinder" ? f.dims.filter((d) => d.dia).map((d) => ({ ...d, priority: priority - 1 })) : [];
  });
  return [...boxDims(boxOfRefs(refs), modelGap(), priority), ...round];
}
/** Nothing selected: every part. A selection: only what's selected (a face's own dimensions). */
function refreshDims() {
  if (!measuring) return;
  const dims: Dim[] = !selection.length
    ? bodies.flatMap((b) => dimsOfRefs(b.refs, 3))
    : selection.flatMap((key) => {
      const refs = expand(key);
      if (refs.length === 1) return dimsOfFace(refs[0]).dims;
      return refs.length ? dimsOfRefs(refs, 4) : [];
    });
  const gap = modelGap();
  dimLayer.setColor(pal().dim);
  dimLayer.set(dims, unit, gap * 0.35);
  placeDims();
  needsRender = true;
}
function placeDims() {
  if (measuring) dimLayer.place(camera, canvas.clientWidth, canvas.clientHeight);
}
function setMeasuring(on: boolean) {
  measuring = on;
  $("#dims").hidden = !on;
  $("#measureBtn").setAttribute("aria-pressed", String(on));
  $("#unitBtn").hidden = !on;
  if (on) refreshDims();
  else dimLayer.clear();
  renderSelBar();
  needsRender = true;
}
function cycleUnit() {
  unit = UNITS[(UNITS.indexOf(unit) + 1) % UNITS.length];
  prefs.set("unit", unit);
  $("#unitLabel").textContent = unit;
  if (!measuring) setMeasuring(true);
  else refreshDims(), renderSelBar();
  toast(`Units: ${unit === "in" ? "inches" : unit === "m" ? "metres" : "millimetres"}`, 900);
}
$("#unitLabel").textContent = unit;

// ---------- export ----------
const exportMenu = $("#exportMenu");
exportMenu.innerHTML = FORMATS.map((f, i) =>
  `<button class="menu-item" role="menuitem" data-export="${f.id}" title="Download ${f.label}"><span><span class="fmt">${f.label}</span> <span class="note">${f.note}</span></span><kbd>${i + 1}</kbd></button>`).join("");
function openExportMenu() {
  exportMenu.hidden = false;
  $("#exportBtn").setAttribute("aria-expanded", "true");
  exportMenu.querySelector<HTMLElement>(".menu-item")!.focus();
}
function closeExportMenu() {
  exportMenu.hidden = true;
  $("#exportBtn").setAttribute("aria-expanded", "false");
}
// Exact STEP runs OpenCascade in its own worker, fetched the first time someone asks for STEP.
let stepWorker: Worker | null = null;
let stepSeq = 0;
const stepWaiting = new Map<number, (r: StepReply) => void>();
function stepRequest(tree: CadDoc): Promise<StepReply> {
  if (!stepWorker) {
    toast("Loading the CAD kernel for STEP (about 7 MB, first time only)…", 6000);
    stepWorker = new Worker("/js/step-worker.js", { type: "module" });
    stepWorker.onmessage = (e: MessageEvent<StepReply>) => {
      stepWaiting.get(e.data.seq)?.(e.data);
      stepWaiting.delete(e.data.seq);
    };
    stepWorker.onerror = (e) => {
      for (const [seq, done] of stepWaiting) done({ seq, error: e.message || "the CAD kernel didn't load" });
      stepWaiting.clear();
      stepWorker?.terminate();
      stepWorker = null;
    };
  }
  const seq = ++stepSeq;
  return new Promise((done) => {
    stepWaiting.set(seq, done);
    stepWorker!.postMessage({ seq, doc: tree } satisfies StepRequest);
  });
}
/** Exact B-rep STEP; falls back to the faceted one (and says so) if OpenCascade can't do it. */
async function exactStep(tree: CadDoc, title: string): Promise<{ blob: Blob; note?: string }> {
  const r = await stepRequest(tree);
  if ("step" in r) return { blob: new Blob([r.step], { type: "model/step" }) };
  console.warn("exact STEP failed:", r.error);
  return { blob: await exportBodies("step", bodies, title), note: `faceted: exact STEP failed (${r.error})` };
}
async function exportAs(id: ExportFormat["id"]) {
  closeExportMenu();
  if (!bodies.length) return void toast("Nothing to export yet");
  const f = FORMATS.find((x) => x.id === id)!;
  const title = state?.name || "model";
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "model";
  const file = `${slug}-v${shownVersion}.${f.ext}`;
  let blob: Blob, note: string | undefined;
  try {
    if (id === "step") ({ blob, note } = await exactStep(doc, title));
    else blob = await exportBodies(id, bodies, title);
  } catch (err) {
    console.error(err);
    return void toast(`Couldn't export ${f.label}. Try again.`);
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Downloading ${escapeHtml(file)}${note ? ` (${escapeHtml(note)})` : ""}`, note ? 6000 : undefined);
}
$("#exportBtn").addEventListener("click", () => (exportMenu.hidden ? openExportMenu() : closeExportMenu()));
exportMenu.addEventListener("click", (e) => {
  const id = (e.target as Element).closest<HTMLElement>("[data-export]")?.dataset.export;
  if (id) exportAs(id as ExportFormat["id"]);
});
exportMenu.addEventListener("keydown", (e) => {
  const items = [...exportMenu.querySelectorAll<HTMLElement>(".menu-item")];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
  const n = Number(e.key);
  if (n >= 1 && n <= FORMATS.length) exportAs(FORMATS[n - 1].id);
  else if (e.key === "Home" || e.key === "End") items[e.key === "Home" ? 0 : items.length - 1].focus();
  else if (step) items[(i + step + items.length) % items.length].focus();
  else if (e.key === "Escape" || e.code === "KeyE") closeExportMenu(), $("#exportBtn").focus();
  else return;
  e.preventDefault();
  e.stopPropagation();
});
addEventListener("pointerdown", (e) => {
  if (!exportMenu.hidden && !(e.target as Element).closest("#exportWrap")) closeExportMenu();
});

// ---------- delete / restore ----------
let deleteArmed = 0;
async function deleteModel() {
  const btn = $("#deleteBtn");
  if (Date.now() > deleteArmed) {
    deleteArmed = Date.now() + 4000;
    btn.classList.add("danger");
    btn.firstChild!.textContent = "Click again to delete ";
    setTimeout(() => {
      btn.classList.remove("danger");
      btn.firstChild!.textContent = "Delete ";
    }, 4000);
    toast(`Delete this model? Press again. Anyone with the link can restore it for 30 days.`, 4000);
    return;
  }
  deleteArmed = 0;
  const res = await fetch(`/api/models/${modelId}`, { method: "DELETE" });
  if (!res.ok) return void toast("Couldn't delete the model. Try again.");
  showTrashed((await res.json()) as { deletedAt: number; purgeAt: number });
}
function showTrashed(info: { deletedAt?: number; purgeAt?: number }) {
  closePops();
  $("#trashed").hidden = false;
  $("#empty").hidden = true;
  const when = info.purgeAt ? new Date(info.purgeAt).toLocaleDateString(undefined, { month: "long", day: "numeric" }) : "in 30 days";
  $("#trashedText").textContent = `It will be erased for good on ${when}. Until then anyone with the link can restore it.`;
}
$("#restoreBtn").addEventListener("click", async () => {
  const res = await fetch(`/api/models/${modelId}/restore`, { method: "POST" });
  if (!res.ok) return void toast("Couldn't restore the model. Try again.");
  $("#trashed").hidden = true;
  await load();
  toast("Model restored");
});

// ---------- rename ----------
const nameInput = $<HTMLInputElement>("#modelName");
function setName(name: string) {
  if (document.activeElement !== nameInput) nameInput.value = name;
  document.title = `${name} · Infinite CAD`;
}
async function saveName() {
  const name = nameInput.value.trim();
  if (!state || !name || name === state.name) return void (nameInput.value = state?.name ?? "");
  state.name = name;
  setName(name);
  rememberModel(modelId, name);
  await fetch(`/api/models/${modelId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
}
nameInput.addEventListener("blur", saveName);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") nameInput.blur();
  if (e.key === "Escape") {
    nameInput.value = state?.name ?? "";
    nameInput.blur();
  }
});

// ---------- popovers & phone sheets ----------
function openConnect() {
  const pop = $("#connectPop");
  pop.hidden = !pop.hidden;
  $("#connectBtn").setAttribute("aria-expanded", String(!pop.hidden));
  ($("#mcpUrl") as HTMLInputElement).value = `${location.origin}/mcp`;
  ($("#modelUrl") as HTMLInputElement).value = `${location.origin}/m/${modelId}`;
  $("#copyKey").textContent = `${MOD}C`;
  $("#promptEx").textContent = `${location.origin}/m/${modelId}\nDesign a wall bracket for a 30 mm pipe, two M4 mounting holes.`;
}
function closeViewSheet() {
  document.body.classList.remove("view-open");
  $("#viewBtn").setAttribute("aria-expanded", "false");
}
function openViewMenu() {
  $("#viewMenu").hidden = false;
  $("#viewMenuBtn").setAttribute("aria-expanded", "true");
  ($("#viewMenu [aria-checked='true']") ?? $("#viewMenu .menu-item")).focus();
}
function closeViewMenu() {
  $("#viewMenu").hidden = true;
  $("#viewMenuBtn").setAttribute("aria-expanded", "false");
}
function closePops() {
  $("#connectPop").hidden = true;
  $("#connectBtn").setAttribute("aria-expanded", "false");
  closeViewMenu();
  closeExportMenu();
  closeViewSheet();
}
$("#viewMenuBtn").addEventListener("click", () => ($("#viewMenu").hidden ? openViewMenu() : closeViewMenu()));
$("#viewMenu").addEventListener("keydown", (e) => {
  const items = [...$("#viewMenu").querySelectorAll<HTMLElement>(".menu-item")];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
  if (e.key === "Home" || e.key === "End") items[e.key === "Home" ? 0 : items.length - 1].focus();
  else if (step) items[(i + step + items.length) % items.length].focus();
  else return;
  e.preventDefault();
  e.stopPropagation();
});
addEventListener("pointerdown", (e) => {
  if (!$("#viewMenu").hidden && !(e.target as Element).closest("#viewMenuWrap")) closeViewMenu();
});
$("#connectBtn").addEventListener("click", openConnect);
$("#emptyConnect").addEventListener("click", openConnect);
wireCopyButtons($("#connectPop"));
$("#viewBtn").addEventListener("click", () => {
  const on = !document.body.classList.contains("view-open");
  if (on) setTreeOpen(false);
  document.body.classList.toggle("view-open", on);
  $("#viewBtn").setAttribute("aria-expanded", String(on));
});
$("#viewSheet").addEventListener("click", (e) => {
  const v = (e.target as Element).closest<HTMLElement>("[data-view]")?.dataset.view;
  if (v) setView(v);
  if (phone.matches && (e.target as Element).closest(".btn,.menu-item") && !(e.target as Element).closest("#deleteBtn,#connectBtn,#viewMenuBtn,#exportBtn")) closeViewSheet();
});
$("#fitBtn").addEventListener("click", () => (fitSelectionOrAll(), closeViewMenu()));
$("#xrayBtn").addEventListener("click", () => setXray(!xray));
$("#measureBtn").addEventListener("click", () => setMeasuring(!measuring));
$("#unitBtn").addEventListener("click", cycleUnit);
$("#treeBtn").addEventListener("click", () => setTreeOpen(!document.body.classList.contains("tree-open")));
$("#themeBtn").addEventListener("click", () => setTheme(theme === "light" ? "dark" : "light"));
$("#deleteBtn").addEventListener("click", deleteModel);
$("#shareBtn").addEventListener("click", () => {
  if (navigator.share) navigator.share({ url: link(), title: state?.name ?? undefined }).catch(() => {});
  else copyLink();
});

// ---------- keyboard ----------
addEventListener("keydown", (e) => {
  const tag = (document.activeElement?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (!$("#trashed").hidden) return;
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyC" && !getSelection()?.toString()) {
    copyLink();
    e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const del = e.key === "Backspace" || e.key === "Delete";
  if (e.key === "Escape") {
    if (!$("#viewMenu").hidden) closeViewMenu(), $("#viewMenuBtn").focus();
    else if (!$("#connectPop").hidden || document.body.classList.contains("view-open")) closePops();
    else if (selection.length) setSelection([]);
    else if (measuring) setMeasuring(false);
    else if (xray) setXray(false);
    else if (multi) (multi = false), renderSelBar();
  } else if (del && e.shiftKey) deleteModel();
  else if (e.shiftKey && e.code === "Digit1") fitAll();
  else if (!e.shiftKey && VIEWS[e.key]) setView(e.key);
  else if (e.code === "KeyF") fitSelectionOrAll();
  else if (e.code === "KeyX") setXray(!xray);
  else if (e.code === "KeyM") setMeasuring(!measuring);
  else if (e.code === "KeyU") cycleUnit();
  else if (e.code === "KeyB" && e.shiftKey) toggleAllFeatures();
  else if (e.code === "KeyB") setTreeOpen(!document.body.classList.contains("tree-open"));
  else if (e.code === "KeyT") setTheme(theme === "light" ? "dark" : "light");
  else if (e.code === "KeyE") exportMenu.hidden ? openExportMenu() : closeExportMenu();
  else if (e.key === "Tab") stepFeature(e.shiftKey ? -1 : 1);
  else if (e.key === "=" || e.key === "+") (controls.dollyIn(1.25), controls.update(), (needsRender = true));
  else if (e.key === "-") (controls.dollyOut(1.25), controls.update(), (needsRender = true));
  else return;
  e.preventDefault();
});

// ---------- render loop ----------
let needsRender = true;
controls.addEventListener("change", () => (needsRender = true));
const panelInset = () => (document.body.classList.contains("tree-open") && !phone.matches ? $("#treePanel").offsetWidth + 12 : 0);
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  // the features panel covers the left: shift the projection so the model centers in what's visible
  const p = panelInset();
  if (p) camera.setViewOffset(w + p, h, 0, 0, w, h);
  else camera.clearViewOffset();
  camera.aspect = (w + p) / h;
  camera.updateProjectionMatrix();
  visibleAspect = (w - p) / h;
  needsRender = true;
}
new ResizeObserver(resize).observe(canvas);
phone.addEventListener("change", resize);
function loop(now: number) {
  requestAnimationFrame(loop);
  if (anim) {
    const k = Math.min(1, (now - anim.t0) / 320);
    const e = 1 - (1 - k) ** 3;
    controls.target.lerpVectors(anim.from[0], anim.to[0], e);
    camera.position.lerpVectors(anim.from[1], anim.to[1], e);
    if (k === 1) anim = null;
    needsRender = true;
  }
  hoverFrame();
  stepFlash(now);
  stepPulse(now);
  controls.update();
  if (needsRender) {
    renderer.render(scene, camera);
    placeDims();
    needsRender = false;
  }
}

// ---------- live sync ----------
let ws: WebSocket | null = null;
let retry = 0;
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/api/models/${modelId}/ws?v=${viewerId()}&d=${coarse.matches ? "touch" : "desktop"}`);
  ws.addEventListener("open", () => {
    retry = 0;
    setLive(true);
    load(); // resync anything missed while disconnected
  });
  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    const msg = JSON.parse(e.data);
    if (msg.type === "tree") {
      if (state) Object.assign(state, { version: msg.version, tree: msg.tree });
      if (msg.version > (building?.version ?? shownVersion)) requestBuild(msg.version, msg.tree, { changed: msg.changed, summary: msg.summary });
    } else if (msg.type === "claim") setClaim(msg);
    else if (msg.type === "model") {
      if (state) state.name = msg.name;
      setName(msg.name);
    } else if (msg.type === "model-deleted") showTrashed(msg);
    else if (msg.type === "model-restored") {
      $("#trashed").hidden = true;
      load();
    }
  });
  ws.addEventListener("close", () => {
    setLive(false);
    setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
  });
}
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
let lastInput = Date.now();
for (const type of ["pointerdown", "keydown", "wheel"]) addEventListener(type, () => (lastInput = Date.now()), { capture: true, passive: true });
setInterval(() => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(document.visibilityState === "visible" && Date.now() - lastInput < ACTIVE_WINDOW_MS ? "ping:active" : "ping");
}, 25000);
function setLive(on: boolean) {
  const dot = $("#liveDot");
  dot.classList.toggle("live", on);
  dot.title = on ? "Live" : "Reconnecting…";
}

async function load() {
  const res = await fetch(`/api/models/${modelId}`);
  if (res.status === 404) {
    document.body.innerHTML = `<main class="home"><div class="home-card"><h1>Model not found</h1><p>This link doesn't point to a model. <a href="/">Make one</a>.</p></div></main>`;
    ws?.close();
    return;
  }
  // in the trash: keep the socket, so a restore from another browser brings it back
  if (res.status === 410) return showTrashed(await res.json());
  if (!res.ok) return void toast("Couldn't load the model. Retrying when the connection comes back.", 4000);
  $("#trashed").hidden = true;
  state = (await res.json()) as ModelState;
  setName(state.name);
  rememberModel(state.id, state.name);
  setClaim(state);
  if (state.version !== (building?.version ?? shownVersion)) requestBuild(state.version, state.tree);
  renderStatus();
}

// ---------- start ----------
document.documentElement.dataset.theme = theme;
setTreeOpen(phone.matches ? false : prefs.get("tree", true));
renderTree();
renderSelBar();
sizeGrid();
paintAll();
requestAnimationFrame(loop);
load().then(connect);
