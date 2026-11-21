// Compare: two versions side by side (stacked on phones) with one shared camera, what changed tinted,
// or overlaid as a ghost (G). Builds both in a second kernel worker with its own bodies and materials;
// the viewer's own bodies stay hidden until compare exits.
import * as THREE from "three";
import { parseRef, type CadDoc } from "../src/schema.ts";
import type { ItemDiff, VersionDiff, VersionTree } from "../src/collab.ts";
import type { Split, Tool, ViewerHost } from "./host";
import { type Body, disposeBody, toBody } from "./mesh";
import { type KernelClient, kernelClient } from "./kernel-client";
import { $, escapeHtml, isPhone } from "./shared";

type Status = "added" | "changed" | "removed";
interface Entry {
  version: number;
  bodies: Body[];
  group: THREE.Group;
  used: number;
}
export interface CompareDeps {
  /** Oldest kept version (1 unless older ones were pruned). */
  oldest(): number;
  /** Compare just opened (phones close the history sheet). */
  opened(): void;
}

const TINT: Record<Status, number> = { added: 0x22a06b, changed: 0xf59e0b, removed: 0xe5484d };
const CACHE = 4;

export function initCompare(host: ViewerHost, deps: CompareDeps) {
  const bar = $("#cmpBar");
  const labels = $("#cmpLabels");
  const [labelA, labelB] = [labels.querySelector<HTMLElement>(".a")!, labels.querySelector<HTMLElement>(".b")!];
  const divider = labels.querySelector<HTMLElement>(".divider")!;
  const { scene } = host.three;

  const solid = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.85, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  const ghost = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, transparent: true, opacity: 0.25, depthWrite: false });
  const edges = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 });

  let cmp: { a: number; b: number; ghost: boolean; diff: VersionDiff | null; error: string | null; loading: boolean; fitted: boolean } | null = null;
  let token = 0;
  let kernel: KernelClient | null = null;
  const cache = new Map<number, Entry>();
  const trees = new Map<number, CadDoc>();
  const diffs = new Map<string, VersionDiff>();
  let clock = 0;
  let shown: [Entry, Entry] | null = null;

  const latest = () => host.state()?.version ?? host.shownVersion();
  const dir = (): "h" | "v" => (isPhone() ? "v" : "h");
  const split: () => Split = () => ({
    dir: dir(),
    pass(i) {
      if (!shown) return;
      shown[0].group.visible = i === 0;
      shown[1].group.visible = i === 1;
    },
  });

  const tool: Tool = { name: "compare", hover: false, cursor: "", click: () => true, exit: () => exit(true) };

  async function tree(v: number): Promise<CadDoc> {
    if (host.pinned() == null && host.shownVersion() === v) return host.doc();
    const hit = trees.get(v);
    if (hit) return hit;
    const res = await fetch(`/api/models/${host.modelId}/versions/${v}`);
    if (!res.ok) throw new Error(res.status === 404 ? `v${v} isn't kept` : `Couldn't load v${v} (${res.status})`);
    const t = ((await res.json()) as VersionTree).tree;
    trees.set(v, t);
    return t;
  }
  async function diffOf(a: number, b: number): Promise<VersionDiff> {
    const key = `${a}-${b}`;
    const hit = diffs.get(key);
    if (hit) return hit;
    const res = await fetch(`/api/models/${host.modelId}/diff?from=${a}&to=${b}`);
    if (!res.ok) throw new Error(`Couldn't diff v${a} and v${b} (${res.status})`);
    const d = (await res.json()) as VersionDiff;
    diffs.set(key, d);
    return d;
  }
  async function entry(v: number): Promise<Entry> {
    const hit = cache.get(v);
    if (hit) return (hit.used = ++clock), hit;
    const doc = await tree(v);
    kernel ??= kernelClient();
    const r = await kernel.build(doc);
    if ("fatal" in r) throw new Error(`The geometry kernel stopped: ${r.fatal}`);
    if (r.issues.length) throw new Error(`v${v} didn't build`);
    const again = cache.get(v); // built twice meanwhile
    if (again) return again;
    const group = new THREE.Group();
    const bodies = r.bodies.map((m) => toBody(m, solid, edges));
    for (const b of bodies) group.add(b.mesh, b.edges);
    const e: Entry = { version: v, bodies, group, used: ++clock };
    cache.set(v, e);
    evict();
    return e;
  }
  function evict() {
    const keep = new Set([cmp?.a, cmp?.b]);
    const old = [...cache.values()].filter((e) => !keep.has(e.version)).sort((x, y) => x.used - y.used);
    while (cache.size > CACHE && old.length) drop(old.shift()!);
  }
  function drop(e: Entry) {
    scene.remove(e.group);
    e.bodies.forEach(disposeBody);
    cache.delete(e.version);
  }

  /** Per side: feature id or part id -> status. Old side uses ids in `from`, new side ids in `to`. */
  function statuses(d: VersionDiff, side: 0 | 1) {
    const feat = new Map<string, Status>(), part = new Map<string, Status>();
    const put = (c: ItemDiff, id: string, s: Status) => (c.kind === "part" ? part : feat).set(id, s);
    for (const c of d.changes) {
      if (c.change === "added") side === 1 && put(c, c.id, "added");
      else if (c.change === "removed") side === 0 && put(c, c.id, "removed");
      else if (c.props.length) put(c, side === 0 ? (c.was ?? c.id) : c.id, "changed");
    }
    return { feat, part };
  }
  const tmp = new THREE.Color(), tint = new THREE.Color();
  function paint(e: Entry, side: 0 | 1, d: VersionDiff | null) {
    const p = host.palette();
    const st = d ? statuses(d, side) : null;
    for (const b of e.bodies) {
      const a = b.color.array as Uint8Array;
      const whole = st?.part.get(b.id);
      for (let r = 0; r < b.refs.length; r++) {
        const s = whole ?? st?.feat.get(parseRef(b.refs[r])?.id ?? "");
        tmp.setHex(p.body);
        if (s) tmp.lerp(tint.setHex(TINT[s]), 0.78);
        const R = Math.round(tmp.r * 255), G = Math.round(tmp.g * 255), B = Math.round(tmp.b * 255);
        const { start, count } = b.range[r];
        for (let v = start * 3, end = (start + count) * 3; v < end; v += 3) (a[v] = R), (a[v + 1] = G), (a[v + 2] = B);
      }
      b.color.clearUpdateRanges();
      b.color.needsUpdate = true;
      b.mesh.material = side === 0 && cmp?.ghost ? ghost : solid;
      b.mesh.renderOrder = side === 0 && cmp?.ghost ? 1 : 0; // the ghost draws over the new side
      b.edges.visible = !(side === 0 && cmp?.ghost);
    }
    edges.color.setHex(p.edge);
  }
  function attach() {
    if (!shown || !cmp) return;
    for (const e of cache.values()) if (!shown.includes(e)) scene.remove(e.group);
    shown.forEach((e, i) => {
      if (e.group.parent !== scene) scene.add(e.group);
      e.group.visible = true;
      paint(e, i as 0 | 1, cmp!.diff);
    });
    host.requestRender();
  }

  async function show() {
    if (!cmp) return;
    const t = ++token;
    const { a, b } = cmp;
    cmp.loading = true;
    cmp.error = null;
    host.setUrlParam("cmp", `${a}-${b}`);
    renderBar();
    try {
      const [ea, eb, d] = await Promise.all([entry(a), entry(b), diffOf(a, b).catch(() => null)]);
      if (t !== token || !cmp) return;
      cmp.diff = d;
      cmp.loading = false;
      shown = [ea, eb];
      attach();
      if (!cmp.fitted) {
        cmp.fitted = true;
        const box = new THREE.Box3();
        for (const e of shown) for (const x of e.bodies) box.union(x.mesh.geometry.boundingBox!);
        if (!box.isEmpty()) host.fitBox(box);
      }
      evict();
    } catch (err) {
      if (t !== token || !cmp) return;
      cmp.loading = false;
      cmp.error = (err as Error).message;
    }
    renderBar();
    place();
  }

  function count(d: VersionDiff) {
    const n = { added: 0, changed: 0, removed: 0 };
    for (const c of d.changes) {
      if (c.change === "added") n.added++;
      else if (c.change === "removed") n.removed++;
      else n.changed++;
    }
    return n;
  }
  function renderBar() {
    if (!cmp) return;
    const { a, b, diff, error, loading } = cmp;
    const L = latest();
    const st = (c: ItemDiff): Status => (c.change === "added" ? "added" : c.change === "removed" ? "removed" : "changed");
    const n = diff ? count(diff) : null;
    const chips = diff
      ? diff.changes.slice(0, 12).map((c) => `<button class="cmp-chip ${st(c)}" data-id="${escapeHtml(c.id)}" title="${escapeHtml(c.was ? `${c.was} → ${c.id}` : c.id)} · ${st(c)}">${escapeHtml(c.id)}</button>`).join("") +
        (diff.changes.length > 12 ? `<span class="more">+${diff.changes.length - 12}</span>` : "")
      : "";
    bar.innerHTML = `
      <div class="cmp-pair">
        <button class="btn step" data-act="a-1" ${a <= deps.oldest() ? "disabled" : ""} title="Older side: one version back ([)" aria-label="Older side back">‹</button>
        <b class="va">v${a}</b>
        <button class="btn step" data-act="a+1" ${a + 1 >= b ? "disabled" : ""} title="Older side: one version forward (])" aria-label="Older side forward">›</button>
        <kbd>[ ]</kbd>
        <span class="arrow">→</span>
        <button class="btn step" data-act="b-1" ${b - 1 <= a ? "disabled" : ""} title="Newer side: one version back (Shift+[)" aria-label="Newer side back">‹</button>
        <b class="vb">v${b}${b === L ? ` <span class="latest">latest</span>` : ""}</b>
        <button class="btn step" data-act="b+1" ${b >= L ? "disabled" : ""} title="Newer side: one version forward (Shift+])" aria-label="Newer side forward">›</button>
        <kbd>⇧[ ⇧]</kbd>
      </div>
      <div class="cmp-sum">${
        error ? `<span class="err">${escapeHtml(error)}</span>`
        : loading ? `<span class="pulse"></span> Building…`
        : n ? (diff!.changes.length ? `<span class="lg added">${n.added} added</span><span class="lg changed">${n.changed} changed</span><span class="lg removed">${n.removed} removed</span>` : `<span class="same">No changes</span>`)
        : `<span class="same">Couldn't diff</span>`
      }</div>
      ${chips ? `<div class="cmp-chips">${chips}</div>` : ""}
      <div class="actions">
        <button class="btn" data-act="ghost" aria-pressed="${cmp.ghost}" title="Overlay the older version as a ghost (G)">Ghost <kbd>G</kbd></button>
        <button class="btn" data-act="close" title="Leave compare (D or Esc)" aria-label="Leave compare">✕ <kbd>Esc</kbd></button>
      </div>`;
    labelA.textContent = `v${a}`;
    labelB.textContent = cmp.ghost ? `v${a} ghost over v${b}` : `v${b}${b === L ? " · latest" : ""}`;
    labelA.hidden = cmp.ghost;
  }

  /** Version labels over each half, and the line between them. */
  function place() {
    if (!cmp) return;
    const { left: L, right: R } = host.insets();
    const w = innerWidth, h = innerHeight, vw = w - L - R;
    labels.classList.toggle("ghosting", cmp.ghost);
    if (cmp.ghost) {
      labelB.style.cssText = `left:${L + 12}px;top:64px`;
      divider.hidden = true;
      return;
    }
    divider.hidden = false;
    if (dir() === "h") {
      labelA.style.cssText = `left:${L + 12}px;top:64px`;
      labelB.style.cssText = `left:${L + vw / 2 + 12}px;top:64px`;
      divider.style.cssText = `left:${L + vw / 2}px;top:0;width:1px;height:${h}px`;
    } else {
      labelA.style.cssText = `left:${L + 12}px;top:64px`;
      labelB.style.cssText = `left:${L + 12}px;top:${h / 2 + 10}px`;
      divider.style.cssText = `left:${L}px;top:${h / 2}px;width:${vw}px;height:1px`;
    }
  }

  function setGhost(on: boolean) {
    if (!cmp || cmp.ghost === on) return;
    cmp.ghost = on;
    host.setSplit(on ? null : split());
    attach();
    renderBar();
    place();
  }

  function open(a: number, b: number) {
    const L = latest();
    b = Math.min(Math.max(b, 2), L);
    a = Math.max(Math.min(a, b - 1), 1);
    if (L < 2 || a >= b) return void host.toast("Only one version so far: nothing to compare", 2500);
    if (cmp) {
      cmp.a = a;
      cmp.b = b;
      return void show();
    }
    cmp = { a, b, ghost: false, diff: null, error: null, loading: true, fitted: false };
    host.setTool(tool);
    host.setMeasuring(false);
    host.setBodiesHidden(true);
    host.setSplit(split());
    document.body.classList.add("comparing");
    bar.hidden = false;
    labels.hidden = false;
    deps.opened();
    show();
  }

  function exit(fromTool = false) {
    if (!cmp) return;
    cmp = null;
    token++;
    shown = null;
    host.setSplit(null);
    host.setBodiesHidden(false);
    for (const e of [...cache.values()]) drop(e);
    kernel?.terminate();
    kernel = null;
    trees.clear();
    document.body.classList.remove("comparing");
    bar.hidden = true;
    labels.hidden = true;
    host.setUrlParam("cmp", null);
    if (!fromTool && host.tool() === tool) host.setTool(null);
    host.renderSelBar();
    host.requestRender();
  }

  function step(side: "a" | "b", by: 1 | -1) {
    if (!cmp) return;
    const L = latest();
    if (side === "a") {
      const a = cmp.a + by;
      if (a < deps.oldest() || a >= cmp.b) return;
      cmp.a = a;
    } else {
      const b = cmp.b + by;
      if (b <= cmp.a || b > L) return;
      cmp.b = b;
    }
    show();
  }

  bar.addEventListener("click", (e) => {
    const t = e.target as Element;
    const id = t.closest<HTMLElement>(".cmp-chip")?.dataset.id;
    if (id) return fitId(id);
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") exit();
    else if (act === "ghost") setGhost(!cmp?.ghost);
    else if (act === "a-1") step("a", -1);
    else if (act === "a+1") step("a", 1);
    else if (act === "b-1") step("b", -1);
    else if (act === "b+1") step("b", 1);
  });
  /** Frame one changed id on both sides. */
  function fitId(id: string) {
    if (!shown || !cmp?.diff) return;
    const c = cmp.diff.changes.find((x) => x.id === id);
    const ids = [id, c?.was].filter(Boolean) as string[];
    const box = new THREE.Box3(), p = new THREE.Vector3();
    for (const e of shown) for (const b of e.bodies) {
      const pos = b.mesh.geometry.attributes.position.array as Float32Array;
      b.refs.forEach((ref, r) => {
        if (!(ids.includes(b.id) || ids.includes(parseRef(ref)?.id ?? ""))) return;
        const { start, count } = b.range[r];
        for (let v = start; v < start + count; v++) box.expandByPoint(p.fromArray(pos, v * 3));
      });
    }
    if (!box.isEmpty()) host.fitBox(box);
  }

  host.on("theme", () => attach());
  host.on("resize", () => place());
  matchMedia("(max-width: 820px)").addEventListener("change", () => {
    if (cmp && !cmp.ghost) host.setSplit(split());
  });
  host.onMessage((msg) => {
    if (msg.type === "tree" && cmp) renderBar();
  });
  host.onEscape(20, () => (cmp ? (exit(), true) : false));
  // ?cmp=A-B opens compare once the model is known
  let fromUrl = host.urlParam("cmp");
  host.on("load", () => {
    const m = fromUrl?.match(/^(\d+)-(\d+)$/);
    fromUrl = null;
    if (m) open(Number(m[1]), Number(m[2]));
  });

  return {
    on: () => !!cmp,
    open,
    exit: () => exit(),
    setGhost: (on: boolean) => setGhost(on),
    ghost: () => !!cmp?.ghost,
    step,
  };
}
