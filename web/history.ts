// History, compare and notes. Built on ViewerHost (web/host.ts); owned by the history agent.
// History: every version newest first, the focused one expanded to its per-property diff; view one
// pinned (Enter), restore it (Shift+R twice), or compare it with the latest (D). Notes and History
// share the right side panel slot (a bottom sheet on phones).
import type { ItemDiff, PropertyChange, RestoreResult, VersionDiff, VersionInfo, VersionPage } from "../src/collab.ts";
import type { ViewerHost } from "./host";
import { initCompare } from "./compare";
import { initNotes } from "./notes";
import { $, ago, commenter, escapeHtml, isPhone, viewerId } from "./shared";

export interface SidePanels {
  show(name: string, el: HTMLElement, close: () => void): void;
  hide(name: string, el: HTMLElement): void;
}

/** One side panel at a time on the right; on phones a bottom sheet (one sheet at a time, via the host). */
function sidePanels(host: ViewerHost): SidePanels {
  let open: { name: string; el: HTMLElement; close: () => void } | null = null;
  const inset = () => {
    const px = open && !isPhone() ? open.el.offsetWidth + 12 : 0;
    if (host.insets().right !== px) host.setRightInset(px);
  };
  matchMedia("(max-width: 820px)").addEventListener("change", inset);
  return {
    show(name, el, close) {
      if (open && open.name !== name) {
        const prev = open;
        open = null;
        prev.close();
      }
      open = { name, el, close };
      el.hidden = false;
      document.body.classList.add("side-open");
      if (isPhone()) host.claimSheet(name, close);
      inset();
    },
    hide(name, el) {
      el.hidden = true;
      host.releaseSheet(name);
      if (open?.name !== name) return;
      open = null;
      document.body.classList.remove("side-open");
      inset();
    },
  };
}

const PAGE = 30;

/** "agent:claude" -> "✦ claude", "person:Ada" -> "Ada". */
function who(by: string) {
  const [kind, name] = [by.split(":")[0], by.slice(by.indexOf(":") + 1)];
  if (kind === "agent") return `<span class="agent">✦ ${escapeHtml(by.includes(":") && name ? name : "agent")}</span>`;
  return escapeHtml(by.includes(":") && name ? name : "Someone");
}

function fmt(v: unknown): string {
  if (v === undefined) return "—";
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null)) return `[${v.map(fmt).join(", ")}]`;
  const s = JSON.stringify(v);
  return s.length > 64 ? `${s.slice(0, 61)}…` : s;
}

export function initHistory(host: ViewerHost) {
  const panels = sidePanels(host);
  const notes = initNotes(host, panels);

  const panel = $("#historyPanel");
  const list = panel.querySelector<HTMLOListElement>(".versions")!;
  const foot = panel.querySelector<HTMLElement>(".more")!;
  const btn = $("#historyBtn");
  const banner = $("#pinBanner");
  const versionEl = $("#version");

  let on = false;
  let versions: VersionInfo[] = [];
  let next: number | null = null;
  let oldest = 1;
  let loaded = false;
  let loading = false;
  let loadError: string | null = null;
  let focused: number | null = null;
  const diffs = new Map<number, VersionDiff | "loading" | "error">();
  let armed: { v: number; timer: number } | null = null;
  let restoring = false;

  const compare = initCompare(host, {
    oldest: () => Math.max(1, oldest),
    opened: () => {
      if (isPhone() && on) toggle(false);
    },
  });

  const latest = () => host.state()?.version ?? 0;

  // ---------- data ----------
  async function fetchPage(before?: number): Promise<VersionPage> {
    const res = await fetch(`/api/models/${host.modelId}/versions?limit=${PAGE}${before ? `&before=${before}` : ""}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Couldn't load history (${res.status})`);
    if (Array.isArray(data)) return { versions: [...data].sort((a, b) => b.version - a.version), current: 0, oldest: 1, next: null }; // older Worker
    return data as VersionPage;
  }
  /** First page; merged with what's loaded so scroll position and older pages survive. */
  async function refresh() {
    try {
      const p = await fetchPage();
      loadError = null;
      oldest = p.oldest ?? 1;
      const have = new Map(versions.map((v) => [v.version, v]));
      for (const v of p.versions) have.set(v.version, v);
      versions = [...have.values()].sort((a, b) => b.version - a.version);
      if (!loaded) next = p.next;
      loaded = true;
    } catch (err) {
      loadError = (err as Error).message;
    }
    render();
  }
  async function more() {
    if (loading || next == null) return;
    loading = true;
    render();
    try {
      const p = await fetchPage(next);
      const have = new Set(versions.map((v) => v.version));
      versions.push(...p.versions.filter((v) => !have.has(v.version)));
      next = p.next;
    } catch (err) {
      host.toast(escapeHtml((err as Error).message), 3000);
    } finally {
      loading = false;
    }
    render();
  }
  async function diffFor(v: number) {
    if (diffs.has(v) || v - 1 < oldest) return;
    diffs.set(v, "loading");
    try {
      const res = await fetch(`/api/models/${host.modelId}/diff?from=${v - 1}&to=${v}`);
      if (!res.ok) throw new Error(String(res.status));
      diffs.set(v, (await res.json()) as VersionDiff);
    } catch {
      diffs.set(v, "error");
    }
    if (on) render();
  }

  // ---------- render ----------
  const keyBtn = (id: string) => `<button class="id" data-key="${escapeHtml(id)}">${escapeHtml(id)}</button>`;
  function propLine(c: ItemDiff, p: PropertyChange) {
    const path = `<code>${escapeHtml(`${c.id}.${p.path}`)}</code>`;
    if (!("from" in p) || p.from === undefined) return `<li class="d-add">${path} <span class="sign">+</span> ${escapeHtml(fmt(p.to))}</li>`;
    if (!("to" in p) || p.to === undefined) return `<li class="d-rm">${path} <span class="sign">−</span> <s>${escapeHtml(fmt(p.from))}</s></li>`;
    return `<li class="d-chg">${path} <span class="from">${escapeHtml(fmt(p.from))}</span> → <span class="to">${escapeHtml(fmt(p.to))}</span></li>`;
  }
  function diffHtml(info: VersionInfo): string {
    const v = info.version;
    if (v - 1 < oldest) {
      const ids = info.detail?.added ?? info.changed;
      return ids.length ? `<ul class="diff">${ids.map((id) => `<li class="d-add"><span class="sign">+</span> ${keyBtn(id)}</li>`).join("")}</ul>` : `<p class="muted">The first version.</p>`;
    }
    const d = diffs.get(v);
    if (!d || d === "loading") return `<p class="muted">Loading changes…</p>`;
    if (d === "error") return `<p class="muted">Couldn't load the changes.</p>`;
    if (!d.changes.length && !d.reordered.length) return `<p class="muted">No changes to the tree.</p>`;
    const lines: string[] = [];
    for (const c of d.changes) {
      const type = c.kind === "part" ? "part" : ((c.value as { type?: string } | undefined)?.type ?? "feature");
      if (c.change === "added") lines.push(`<li class="d-add"><span class="sign">+</span> ${keyBtn(c.id)} <span class="muted">${escapeHtml(type)}</span></li>`);
      else if (c.change === "removed") lines.push(`<li class="d-rm"><span class="sign">−</span> <code>${escapeHtml(c.id)}</code> <span class="muted">${escapeHtml(type)}</span></li>`);
      else {
        if (c.change === "renamed") lines.push(`<li class="d-ren"><code>${escapeHtml(c.was!)}</code> → ${keyBtn(c.id)}</li>`);
        lines.push(...c.props.map((p) => propLine(c, p)));
      }
    }
    for (const p of d.reordered) lines.push(`<li class="muted">Reordered features in ${keyBtn(p)}</li>`);
    return `<ul class="diff">${lines.join("")}</ul>`;
  }
  function chips(info: VersionInfo) {
    const d = info.detail;
    const all: [string, string][] = d
      ? [...d.added.map((id) => [id, "added"] as [string, string]), ...d.changed.map((id) => [id, "changed"] as [string, string]), ...d.removed.map((id) => [id, "removed"] as [string, string]),
         ...Object.entries(d.renames).filter(([, to]) => !d.changed.includes(to) && !d.added.includes(to)).map(([, to]) => [to, "changed"] as [string, string])]
      : info.changed.map((id) => [id, ""] as [string, string]);
    if (!all.length) return "";
    const shown = all.slice(0, 6);
    return `<div class="ver-ids">${shown.map(([id, s]) => `<span class="vchip ${s}" title="${escapeHtml(s ? `${id} · ${s}` : id)}">${escapeHtml(id)}</span>`).join("")}${all.length > 6 ? `<span class="vchip more">+${all.length - 6}</span>` : ""}</div>`;
  }
  function render() {
    btn.setAttribute("aria-pressed", String(on));
    renderBanner();
    if (!on) return;
    const pinned = host.pinned();
    const viewing = pinned ?? latest();
    if (!loaded) {
      list.innerHTML = `<li class="muted pad">${loadError ? escapeHtml(loadError) : "Loading…"}</li>`;
      foot.innerHTML = "";
      return;
    }
    list.innerHTML = versions.map((info) => {
      const v = info.version;
      const isLatest = v === latest();
      const isFocus = v === focused;
      const restored = info.detail?.restoredFrom;
      return `<li class="ver${v === viewing ? " on" : ""}${isFocus ? " focus" : ""}" id="ver-${v}" data-v="${v}" role="option" aria-selected="${isFocus}">
        <div class="ver-head"><span class="vn">v${v}</span><span class="sum">${escapeHtml(info.summary || "(no summary)")}</span></div>
        <div class="ver-meta">${who(info.by)} · <time title="${new Date(info.at).toLocaleString()}">${ago(info.at, true)}</time>${restored ? ` <span class="tag">Restored v${restored}</span>` : ""}${isLatest ? ` <span class="tag latest">latest</span>` : ""}${v === pinned ? ` <span class="tag viewing">viewing</span>` : ""}</div>
        ${chips(info)}
        ${isFocus ? `<div class="ver-diff">${diffHtml(info)}
          <div class="ver-acts">
            ${v === viewing ? "" : `<button class="btn" data-act="view" title="View v${v} (Enter)">${isLatest ? "Back to latest" : `View v${v}`} <kbd>↵</kbd></button>`}
            ${v !== latest() ? `<button class="btn" data-act="compare" title="Compare v${v} with the latest (D)">Compare <kbd>D</kbd></button>` : v > oldest ? `<button class="btn" data-act="compare" title="Compare with the previous version (D)">Compare <kbd>D</kbd></button>` : ""}
          </div></div>` : ""}
      </li>`;
    }).join("") || `<li class="muted pad">No versions yet.</li>`;
    foot.innerHTML = next != null ? `<button class="btn" data-act="more">${loading ? "Loading…" : "Older versions"}</button>` : versions.length ? `<span class="muted">Every version is kept.</span>` : "";
    list.setAttribute("aria-activedescendant", focused ? `ver-${focused}` : "");
    if (focused) for (const v of versions) if (v.version === focused) diffFor(v.version);
  }

  function renderBanner() {
    const v = host.pinned();
    banner.hidden = v == null;
    document.body.classList.toggle("pinned", v != null);
    if (v == null) return;
    const busy = host.claimActive();
    const isArmed = armed?.v === v;
    banner.innerHTML = `<span>Viewing <b>v${v}</b> · latest v${latest()}</span>
      <button class="btn ${isArmed ? "danger" : ""}" data-act="restore" ${busy || restoring ? "disabled" : ""} title="${busy ? "The agent is editing: restore after it saves" : `Make v${v} the latest again, as a new version (Shift+R, twice)`}">${restoring ? "Restoring…" : isArmed ? `Press again to restore v${v}` : `Restore v${v}`} <kbd>⇧R</kbd></button>
      <button class="btn" data-act="latest" title="Back to the latest version (Esc)">Back to latest <kbd>Esc</kbd></button>`;
  }

  // ---------- actions ----------
  async function view(v: number) {
    if (v === latest()) await host.showVersion(null);
    else await host.showVersion(v);
    render();
  }
  function focus(v: number | null, scroll = true) {
    focused = v;
    render();
    if (scroll && v != null) list.querySelector(`#ver-${v}`)?.scrollIntoView({ block: "nearest" });
  }
  function move(by: 1 | -1) {
    if (!versions.length) return;
    const i = versions.findIndex((x) => x.version === focused);
    const j = i < 0 ? 0 : Math.max(0, Math.min(versions.length - 1, i + by));
    focus(versions[j].version);
    if (j >= versions.length - 3) more();
  }
  function compareFrom(v: number | null) {
    const L = latest();
    if (v != null && v < L) compare.open(v, L);
    else compare.open(L - 1, L);
  }
  function restoreKey() {
    const v = host.pinned();
    if (v == null) return void host.toast("View a past version first: <kbd>H</kbd>, then <kbd>↵</kbd> on one", 3000);
    if (host.claimActive()) return void host.toast("The agent is editing. Restore after it saves.", 3000);
    if (armed?.v === v) return void restore(v);
    if (armed) clearTimeout(armed.timer);
    armed = { v, timer: window.setTimeout(() => ((armed = null), renderBanner()), 4000) };
    renderBanner();
  }
  async function restore(v: number) {
    if (armed) clearTimeout(armed.timer), (armed = null);
    if (restoring) return;
    restoring = true;
    renderBanner();
    try {
      const res = await fetch(`/api/models/${host.modelId}/versions/${v}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseVersion: latest(), by: `person:${commenter().name}`, viewer: viewerId() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return void host.toast(escapeHtml(data.error || `Couldn't restore v${v} (${res.status})`), 5000);
      const r = data as RestoreResult;
      await host.showVersion(null);
      focused = r.version;
      const lost = r.orphaned?.length ? ` · ${r.orphaned.length === 1 ? "1 comment lost its face" : `${r.orphaned.length} comments lost their face`}` : "";
      host.toast(r.unchanged ? `v${v} is already what the latest looks like` : `Restored v${v} as v${r.version}${lost}`, 4000);
    } catch {
      host.toast(`Couldn't restore v${v}`, 3000);
    } finally {
      restoring = false;
      render();
    }
  }

  function toggle(next = !on) {
    if (next === on) return;
    on = next;
    if (on) {
      panels.show("history", panel, () => toggle(false));
      if (focused == null) focused = host.pinned() ?? latest() ?? null;
      render();
      refresh().then(() => focused && list.querySelector(`#ver-${focused}`)?.scrollIntoView({ block: "nearest" }));
    } else {
      panels.hide("history", panel);
      render();
    }
  }

  // ---------- wiring ----------
  btn.addEventListener("click", () => toggle());
  versionEl.setAttribute("role", "button");
  versionEl.tabIndex = 0;
  versionEl.title = "History (H)";
  versionEl.addEventListener("click", () => toggle());
  versionEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });

  panel.addEventListener("click", (e) => {
    const t = e.target as Element;
    const key = t.closest<HTMLElement>("button.id[data-key]")?.dataset.key;
    if (key) {
      const k = host.resolveKey(key);
      if (k) host.setSelection([k], { fit: true });
      else host.toast(`<code>${escapeHtml(key)}</code> isn't in v${host.shownVersion()}`, 2500);
      return;
    }
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    const row = t.closest<HTMLElement>(".ver");
    const v = row ? Number(row.dataset.v) : null;
    if (act === "close") toggle(false);
    else if (act === "more") more();
    else if (act === "view" && v) view(v);
    else if (act === "compare" && v) compareFrom(v);
    else if (v && !act) {
      focus(v, false);
      view(v);
    }
  });
  list.addEventListener("scroll", () => {
    if (list.scrollTop + list.clientHeight > list.scrollHeight - 80) more();
  }, { passive: true });

  banner.addEventListener("click", (e) => {
    const act = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "latest") host.showVersion(null).then(render);
    else if (act === "restore") restoreKey();
  });

  host.onKey((e) => {
    // Enter on one of our own buttons clicks it instead
    const inControl = !!(e.target as Element | null)?.closest?.(".side-panel :is(button, a), .pin-banner button, .cmp-bar button, #version");
    if (e.code === "KeyH" && !e.shiftKey) return toggle(), true;
    if (e.code === "KeyN" && !e.shiftKey) return notes.toggle(), true;
    if (e.code === "KeyD" && !e.shiftKey) {
      if (compare.on()) compare.exit();
      else compareFrom(host.pinned() ?? (on ? focused : null));
      return true;
    }
    if (e.code === "KeyG" && !e.shiftKey && compare.on()) return compare.setGhost(!compare.ghost()), true;
    if ((e.code === "BracketLeft" || e.code === "BracketRight") && compare.on()) {
      compare.step(e.shiftKey ? "b" : "a", e.code === "BracketLeft" ? -1 : 1);
      return true;
    }
    if (e.code === "KeyR" && e.shiftKey) return restoreKey(), true;
    if (on && (e.key === "ArrowDown" || e.key === "ArrowUp") && !e.shiftKey) return move(e.key === "ArrowDown" ? 1 : -1), true;
    if (e.key === "Enter" && !e.shiftKey && !inControl) {
      if (on && focused) return view(focused), true;
      if (notes.on()) return notes.edit();
    }
    return false;
  });
  host.onEscape(40, () => (on ? (toggle(false), true) : notes.escape()));
  host.onEscape(50, () => (host.pinned() != null ? (host.showVersion(null).then(render), true) : false));

  host.on("build", render);
  host.on("claim", renderBanner);
  host.on("load", () => {
    if (loaded) refresh();
    else renderBanner();
  });
  host.onMessage((msg) => {
    if (msg.type !== "tree") return;
    if (loaded) refresh();
    else renderBanner();
  });
  setInterval(() => on && render(), 60000);
}
