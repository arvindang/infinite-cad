// Notes: one markdown doc per model, in the right side panel, that people and agents both edit.
// Ported from Divs & Spans (web/notes.ts). Saves carry the version they started from, so two
// editors can't silently overwrite each other. Ref links ([text](#base.top), #a,b, /m/<id>#refs) act on the model.
import type { ModelNotes } from "../src/collab.ts";
import type { ViewerHost } from "./host";
import type { SidePanels } from "./history";
import { $, MOD, ago, commenter, escapeHtml, viewerId } from "./shared";
import { renderMarkdown } from "./markdown";

export function initNotes(host: ViewerHost, panels: SidePanels) {
  const panel = $("#notesPanel");
  const view = panel.querySelector<HTMLElement>(".md")!;
  const form = panel.querySelector<HTMLFormElement>("form")!;
  const input = form.querySelector<HTMLTextAreaElement>("textarea")!;
  const by = panel.querySelector<HTMLElement>(".by")!;
  const banner = panel.querySelector<HTMLElement>(".banner")!;
  const editBtn = panel.querySelector<HTMLButtonElement>("[data-act=edit]")!;
  const btn = $("#notesBtn");
  form.querySelector("button[type=submit] kbd")!.textContent = `${MOD}↵`;

  let notes: ModelNotes | null = null;
  let loadError: string | null = null;
  let on = false;
  /** While editing: the version the draft started from, and whether someone saved since. */
  let editing: { base: number; stale: ModelNotes | null } | null = null;
  let saving = false;

  const api = async (method = "GET", body?: unknown): Promise<ModelNotes> => {
    const res = await fetch(`/api/models/${host.modelId}/notes`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data as ModelNotes;
  };

  function render() {
    btn.setAttribute("aria-pressed", String(on));
    btn.classList.toggle("has", !!notes?.body);
    if (!on) return;
    form.hidden = !editing;
    view.hidden = !!editing;
    editBtn.hidden = !!editing || !notes;
    editBtn.querySelector(".label")!.textContent = notes?.body ? "Edit" : "Write";
    if (!notes) {
      view.innerHTML = `<p class="notes-empty">${loadError ? escapeHtml(loadError) : "Loading…"}</p>`;
      by.textContent = "";
    } else {
      view.innerHTML = notes.body
        ? renderMarkdown(notes.body)
        : `<p class="notes-empty">No notes yet. Requirements, tolerances, material, decisions, open questions. Your agent reads and writes these too.</p>`;
      wireLinks();
      by.textContent = notes.version
        ? `v${notes.version} · ${notes.updatedByKind === "agent" ? "✦ " : ""}${notes.updatedBy || "someone"}${notes.updatedAt ? ` · ${ago(notes.updatedAt, true)}` : ""}`
        : "";
    }
    const stale = editing?.stale;
    banner.hidden = !stale;
    if (stale) banner.innerHTML = `${stale.updatedByKind === "agent" ? "✦ " : ""}${escapeHtml(stale.updatedBy || "Someone")} just saved these notes. <button type="button" class="btn" data-act="theirs">Use theirs</button> <button type="button" class="btn" data-act="mine">Keep mine</button>`;
  }

  /** Links in notes: ref links select on the model; everything else opens in a new tab. */
  function wireLinks() {
    for (const a of view.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const keys = refKeys(a.getAttribute("href")!);
      if (!keys) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        continue;
      }
      a.classList.add("ref");
      a.dataset.keys = keys.join(",");
      a.title = keys.length ? keys.join(", ") : "This model";
    }
  }
  /** #a,b or a link to this model (/m/<id>[?…][#a,b]) to its keys; null for anything else. */
  function refKeys(href: string): string[] | null {
    let frag: string;
    if (href.startsWith("#")) frag = href.slice(1);
    else {
      const m = href.match(/^(?:https?:\/\/[^/]+)?\/m\/([a-z0-9]+)\/?(?:\?[^#]*)?(?:#(.*))?$/);
      if (!m || m[1] !== host.modelId) return null;
      frag = m[2] ?? "";
    }
    const keys = decodeURIComponent(frag).split(",").map((s) => s.trim()).filter(Boolean);
    return keys.every((k) => /^[A-Za-z0-9_-]+(:\d+)?(\.[A-Za-z0-9_-]+)?$/.test(k)) ? keys : null;
  }
  const keysOf = (a: HTMLElement) => (a.dataset.keys ? a.dataset.keys.split(",") : []);

  view.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a.ref");
    if (!a) return;
    e.preventDefault();
    host.setHover(null);
    const keys = keysOf(a);
    const found = keys.map((k) => host.resolveKey(k)).filter((k): k is string => !!k);
    const missing = keys.filter((k) => !host.resolveKey(k));
    host.setSelection(found, { fit: true });
    if (missing.length) {
      const where = host.pinned() != null ? `in v${host.shownVersion()}` : "in this model";
      host.toast(`Not ${where}: ${missing.map((k) => `<code>${escapeHtml(k)}</code>`).join(", ")}`, 3500);
    }
  });
  view.addEventListener("mouseover", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a.ref");
    if (a) host.setHover(keysOf(a).map((k) => host.resolveKey(k)).find(Boolean) ?? null);
  });
  view.addEventListener("mouseout", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a.ref");
    if (a && !a.contains(e.relatedTarget as Node)) host.setHover(null);
  });
  view.addEventListener("dblclick", (e) => {
    if (!(e.target as Element).closest("a")) edit();
  });

  async function fetchNotes() {
    try {
      const n = await api();
      loadError = null;
      if (!editing || saving) notes = n;
      else if (n.version !== editing.base) (editing.stale = n), (notes = n);
    } catch (err) {
      loadError = (err as Error).message;
    }
    render();
  }

  function edit() {
    if (!notes || editing) return;
    editing = { base: notes.version, stale: null };
    input.value = notes.body;
    render();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /** Save the draft if it changed. Resolves false when a conflict needs the person's call. */
  async function commit(force = false): Promise<boolean> {
    if (!editing || saving) return !editing;
    const e = editing;
    if (input.value.trimEnd() === (notes?.body ?? "").trimEnd() && !force) {
      editing = null;
      render();
      return true;
    }
    saving = true;
    try {
      const base = force && e.stale ? e.stale.version : e.base;
      notes = await api("PUT", { body: input.value, baseVersion: base, by: commenter().name, viewer: viewerId() });
      editing = null;
      render();
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        e.stale = await api().catch(() => null);
        if (e.stale) notes = e.stale;
        render();
        input.focus();
      } else host.toast(escapeHtml((err as Error).message), 4000);
      return false;
    } finally {
      saving = false;
    }
  }

  function cancel() {
    editing = null;
    render();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    commit();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    }
  });
  panel.addEventListener("click", (e) => {
    const act = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "edit") edit();
    else if (act === "cancel") cancel();
    else if (act === "close") toggle(false);
    else if (act === "mine") commit(true);
    else if (act === "theirs") cancel();
  });

  async function toggle(next = !on) {
    if (next === on) return;
    if (!next && !(await commit())) return;
    on = next;
    if (on) {
      panels.show("notes", panel, () => toggle(false));
      render();
      fetchNotes();
    } else {
      panels.hide("notes", panel);
      render();
    }
  }
  btn.addEventListener("click", () => toggle());

  // the button shows whether there are notes, so fetch once up front
  host.on("load", () => void fetchNotes());
  host.onMessage((msg) => {
    if (msg.type !== "notes") return;
    const n = msg.notes;
    if (editing && !saving && n.version !== editing.base) editing.stale = n;
    if (!saving) notes = n;
    render();
  });

  return {
    on: () => on,
    toggle,
    /** Esc closes the panel (a draft is saved first). */
    escape(): boolean {
      if (!on) return false;
      toggle(false);
      return true;
    },
    /** Enter starts editing while the panel is open. */
    edit(): boolean {
      if (!on || !notes || editing) return false;
      edit();
      return true;
    },
  };
}
