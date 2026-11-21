// Comments: threads pinned to faces, features and parts. Built on ViewerHost (web/host.ts); owned by the comments agent.
// Desktop: C enters comment mode (a canvas tool), a click on a face drafts a thread there. Phones: tap selects as
// always, the selection bar's Comment button drafts one, the thread opens as a bottom sheet.
import * as THREE from "three";
import type { CameraPose, Thread, ThreadComment, ThreadStatus } from "../src/collab.ts";
import { parseRef } from "../src/schema.ts";
import type { Hit, Tool, ViewerHost } from "./host";
import { PinPlacer, spotOn, threadKey } from "./pins";
import { $, MOD, ago, authorColor, commenter, copy, escapeHtml, isPhone, renameCommenter, toast, viewerId } from "./shared";

interface Draft {
  ref: string | null;
  /** The ref it was started on, so "Whole model" can be undone. */
  from: string | null;
  point: THREE.Vector3 | null;
  normal: THREE.Vector3 | null;
  camera: CameraPose;
  version: number;
}
type Active = { id: string } | { draft: Draft } | null;

const MAX_PINS = 200;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const initials = (c: ThreadComment) =>
  c.authorKind === "agent" ? "✦" : c.authorName.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const avatar = (c: ThreadComment) =>
  `<span class="av${c.authorKind === "agent" ? " agent" : ""}" style="--c:${c.authorKind === "agent" ? "var(--accent)" : authorColor(c.authorId)}">${escapeHtml(initials(c))}</span>`;
const v3 = (v: THREE.Vector3) => v.toArray().map((n) => Math.round(n * 1000) / 1000);

export function initComments(host: ViewerHost) {
  const btn = $("#commentBtn");
  const pinsEl = $("#pins");
  const pop = $("#thread");
  const head = pop.querySelector<HTMLElement>(".head")!;
  const sub = pop.querySelector<HTMLElement>(".sub")!;
  const items = pop.querySelector<HTMLElement>(".items")!;
  const form = pop.querySelector<HTMLFormElement>("form")!;
  const input = form.querySelector<HTMLTextAreaElement>("textarea")!;
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const treeEl = $("#tree");
  const placer = new PinPlacer(host);

  const threads = new Map<string, Thread>();
  /** Comment mode (desktop: the canvas tool; phones: pins shown). */
  let on = false;
  let showResolved = false;
  let active: Active = null;
  let editing: string | null = null;
  let formFor = "";
  let wanted = host.urlParam("c");
  let loaded = false;
  let built = false;
  const pinEls = new Map<string, HTMLButtonElement>();
  const pinAt = new Map<string, { x: number; y: number; off: boolean }>();

  const api = async (path: string, method = "GET", body?: unknown) => {
    const res = await fetch(`/api/models/${host.modelId}/comments${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  };
  const failed = (err: unknown) => host.toast(escapeHtml((err as Error).message || "Couldn't save the comment"), 4000);
  const upsert = (t: Thread | null | undefined) => t && threads.set(t.id, t);
  const activeThread = () => (active && "id" in active ? threads.get(active.id) ?? null : null);
  const draft = () => (active && "draft" in active ? active.draft : null);
  const keyOf = (t: Thread) => threadKey(host, t);
  /** Shown as a pin, in counts and in [ ]: open ones, resolved ones with Shift+C, and the one that's open. */
  const visible = (t: Thread) => t.comments.length > 0 && (t.status === "open" || showResolved || activeThread()?.id === t.id);
  const linkTo = (t: Thread) => {
    const key = keyOf(t);
    return `${location.origin}/m/${host.modelId}?c=${t.id}${key ? `#${key}` : ""}`;
  };
  /** Threads on the same key (or all whole-model / detached ones), oldest first. */
  const siblings = (t: Thread) => {
    const k = keyOf(t);
    return [...threads.values()].filter((x) => visible(x) && keyOf(x) === k).sort((a, b) => a.createdAt - b.createdAt);
  };
  const chip = (key: string, gone = false) =>
    `<button class="chip${gone ? " gone" : ""}" data-act="goto" data-key="${escapeHtml(key)}" title="${gone ? "Not on the model now" : "Show it"}">${escapeHtml(key)}</button>`;

  // ---------- pins ----------
  function draw() {
    const show = on || !!active;
    pinsEl.hidden = !show;
    const seen = new Set<string>();
    if (show) {
      const cur = activeThread()?.id;
      const place = (id: string, p: THREE.Vector3, n: THREE.Vector3, html: string, cls: string, title: string) => {
        const s = placer.project(p.clone().addScaledVector(n, 1e-3 * placer.modelSize()));
        pinAt.set(id, s);
        if (s.off) return;
        seen.add(id);
        let pin = pinEls.get(id);
        if (!pin) {
          pin = document.createElement("button");
          pin.dataset.thread = id;
          pinsEl.append(pin);
          pinEls.set(id, pin);
        }
        const c = `pin ${cls}${s.behind ? " behind" : ""}`;
        if (pin.className !== c) pin.className = c;
        if (pin.innerHTML !== html) pin.innerHTML = html;
        const t = title + (s.behind ? " · behind the model" : "");
        if (pin.title !== t) pin.title = t;
        pin.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
      };
      let n = 0;
      for (const t of threads.values()) {
        if (!visible(t) || n >= MAX_PINS) continue;
        const spot = placer.spot(t);
        if (!spot) continue;
        n++;
        const first = t.comments[0];
        const count = t.comments.length;
        place(t.id, spot.point, spot.normal, `${avatar(first)}${count > 1 ? `<i>${count}</i>` : ""}`,
          `${t.status}${t.id === cur ? " active" : ""}`, `${first.authorName}: ${first.body.slice(0, 80)}`);
      }
      const d = draft();
      if (d?.ref && d.point && d.normal) place("draft", d.point, d.normal, `<span class="av" style="--c:var(--accent)">+</span>`, "draft active", "New comment");
    }
    for (const [id, el] of pinEls)
      if (!seen.has(id)) {
        el.remove();
        pinEls.delete(id);
      }
    positionPopover();
  }

  function positionPopover() {
    if (pop.hidden || isPhone()) return;
    const id = active && ("draft" in active ? "draft" : active.id);
    const a = id && pinEls.has(id) ? pinAt.get(id) : null;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const { left, right } = host.insets();
    const maxX = innerWidth - right - w - 12;
    let x = a ? a.x + 24 : maxX;
    let y = a ? a.y - 28 : 64;
    if (a && x > maxX) x = a.x - w - 16;
    x = clamp(x, left + 12, maxX);
    y = clamp(y, 60, innerHeight - h - 12);
    pop.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  pinsEl.addEventListener("click", (e) => {
    const id = (e.target as Element).closest<HTMLElement>("[data-thread]")?.dataset.thread;
    if (!id || id === "draft") return;
    if (activeThread()?.id === id) close();
    else open({ id });
  });

  // ---------- popover ----------
  function where(): { head: string; notes: string[] } {
    const t = activeThread();
    const shown = host.shownVersion();
    if (!t) {
      const d = draft()!;
      if (!d.ref) return { head: `<span class="where">Whole model</span>`, notes: d.from ? [`<button class="link" data-act="unwhole">Comment on ${escapeHtml(d.from)} instead</button>`] : [] };
      const here = [...threads.values()].filter((x) => x.status === "open" && x.comments.length && keyOf(x) === d.ref);
      return {
        head: `<span class="where">${chip(d.ref, !host.exists(d.ref))}</span>`,
        notes: [
          ...(here.length ? [`Also here: ${here.map((x) => `<button class="link" data-open="${x.id}" title="${escapeHtml(x.comments[0].body.slice(0, 120))}">${escapeHtml(x.comments[0].authorName)}: ${escapeHtml(x.comments[0].body.slice(0, 32))}${x.comments[0].body.length > 32 ? "…" : ""}</button>`).join(", ")}`] : []),
          `<button class="link" data-act="whole">Comment on the whole model instead</button>`,
        ],
      };
    }
    const notes: string[] = [];
    const ref = t.anchor.ref;
    const key = keyOf(t);
    let h: string;
    if (!ref) h = `<span class="where">Whole model</span>`;
    else if (!key) {
      h = `<span class="where">${chip(ref, true)}</span>`;
      notes.push(t.target.status === "unknown" && t.target.message
        ? escapeHtml(t.target.message)
        : `It was removed${t.target.since ? ` in v${t.target.since}` : ""}, so it's listed under Whole model.`);
    } else {
      h = `<span class="where">${chip(key)}</span>`;
      const now = t.target.ref ?? ref;
      if (now !== ref) notes.push(`Was <code>${escapeHtml(ref)}</code>${t.target.since ? ` until v${t.target.since}` : ""}`);
      if (key !== now) notes.push(`<code>${escapeHtml(now)}</code> isn't in v${shown}; pinned to <code>${escapeHtml(key)}</code>`);
    }
    if (t.anchor.version !== shown) notes.push(`Made on v${t.anchor.version}`);
    return { head: h, notes };
  }

  function renderPopover() {
    if (!active) {
      pop.hidden = true;
      return;
    }
    const me = commenter();
    const t = activeThread();
    if ("id" in active && !t) return close();
    pop.hidden = false;
    pop.classList.toggle("resolved", t?.status === "resolved");
    const w = where();
    if (t) {
      const resolved = t.status === "resolved";
      const sibs = siblings(t);
      const i = sibs.findIndex((x) => x.id === t.id);
      const nav = sibs.length > 1
        ? `<span class="nav"><button class="btn icon" data-act="prev" title="Previous thread here ([)" aria-label="Previous thread">‹</button><span class="of">${i + 1} of ${sibs.length} here</span><button class="btn icon" data-act="next" title="Next thread here (])" aria-label="Next thread">›</button><kbd>[</kbd><kbd>]</kbd></span>`
        : "";
      if (nav) w.notes.unshift(nav);
      head.innerHTML = w.head +
        `<button class="btn icon" data-act="status" title="${resolved ? "Reopen" : "Resolve"} (${MOD}Enter; with a reply typed, sends it first)" aria-pressed="${resolved}">${resolved ? "Reopen" : "✓ Resolve"} <kbd>${MOD}↵</kbd></button>` +
        `<button class="btn icon" data-act="link" title="Copy a link to this thread">Link</button>` +
        `<button class="btn icon" data-act="close" title="Close (Esc)" aria-label="Close">✕ <kbd>Esc</kbd></button>`;
      items.innerHTML = t.comments.map((c) => {
        const mine = c.authorKind === "person" && c.authorId === me.id;
        return `<li data-comment="${c.id}">${avatar(c)}<div class="body">` +
          `<div class="meta"><b>${escapeHtml(c.authorName)}</b>${c.authorKind === "agent" ? `<span class="tag">agent</span>` : ""}` +
          `<time title="${new Date(c.createdAt).toLocaleString()}">${ago(c.createdAt)}${c.editedAt ? " · edited" : ""}</time>` +
          (mine ? `<span class="own"><button data-act="edit">Edit</button><button data-act="delete">Delete</button></span>` : "") +
          `</div><p>${escapeHtml(c.body)}</p></div></li>`;
      }).join("") + (resolved ? `<li class="note">Resolved by ${escapeHtml(t.resolvedBy ?? "someone")}. Replying reopens it.</li>` : "");
    } else {
      head.innerHTML = w.head + `<button class="btn icon" data-act="close" title="Close (Esc)" aria-label="Close">✕ <kbd>Esc</kbd></button>`;
      items.innerHTML = "";
    }
    sub.innerHTML = w.notes.map((n) => `<span>${n}</span>`).join("");
    sub.hidden = !w.notes.length;
    // keep what's being typed when a live update re-renders the thread
    const key = `${t?.id ?? "draft"}:${editing ?? ""}`;
    if (key !== formFor) {
      formFor = key;
      const c = editing ? t?.comments.find((x) => x.id === editing) : null;
      input.value = c?.body ?? "";
      input.placeholder = t ? "Reply…" : draft()?.ref ? `Comment on ${draft()!.ref}…` : "Comment on the whole model…";
      submit.querySelector(".label")!.textContent = editing ? "Save" : t ? "Reply" : "Post";
      if (!matchMedia("(pointer: coarse)").matches) requestAnimationFrame(() => input.focus());
    }
    form.querySelector<HTMLElement>(".as")!.innerHTML = editing
      ? `Editing · <button type="button" data-act="cancel">Cancel</button>`
      : `as <button type="button" data-act="rename" title="Change your name on comments" style="color:${authorColor(me.id)}">${escapeHtml(me.name)}</button>`;
    requestAnimationFrame(positionPopover);
  }

  function open(next: Active) {
    active = next;
    editing = null;
    formFor = "";
    host.setUrlParam("c", activeThread()?.id ?? null);
    document.body.classList.toggle("thread-open", !!active);
    if (active && isPhone()) host.claimSheet("thread", close);
    renderPopover();
    draw();
  }
  function close() {
    if (!active) return;
    active = null;
    editing = null;
    formFor = "";
    pop.hidden = true;
    document.body.classList.remove("thread-open");
    host.releaseSheet("thread");
    host.setUrlParam("c", null);
    draw();
  }

  function startDraft(ref: string | null, point?: THREE.Vector3 | null, normal?: THREE.Vector3 | null) {
    let p = point ?? null, n = normal ?? null;
    if (ref && (!p || !n)) {
      const s = spotOn(host, ref, p);
      p = s?.point ?? null;
      n = s?.normal ?? null;
    }
    open({ draft: { ref, from: ref, point: p?.clone() ?? null, normal: n?.clone() ?? null, camera: host.cameraPose(), version: host.shownVersion() } });
  }

  /** C with a selection, the selection bar's Comment button, phones: a draft on the last picked key, at the tap if it's on it. */
  function commentOnSelection() {
    const sel = host.selection();
    if (!sel.length) return;
    const key = sel[sel.length - 1];
    const hit = host.lastHit();
    const at = hit && host.expand(key).includes(hit.ref) ? hit : null;
    toggle(true);
    startDraft(key, at?.point, at?.normal);
  }

  async function send(): Promise<boolean> {
    const body = input.value.trim();
    if (!body || !active) return false;
    const me = commenter();
    const author = { id: me.id, name: me.name, secret: me.secret };
    submit.disabled = true;
    try {
      const t = activeThread();
      const d = draft();
      if (d) {
        const created = (await api("", "POST", {
          ref: d.ref,
          point: d.ref && d.point ? v3(d.point) : null,
          normal: d.ref && d.normal ? v3(d.normal) : null,
          camera: d.camera,
          version: d.version,
          body,
          author,
          viewer: viewerId(),
        })) as Thread;
        upsert(created);
        open({ id: created.id });
      } else if (t && editing) {
        upsert((await api(`/${t.id}/${editing}`, "PATCH", { body, secret: me.secret, viewer: viewerId() })) as Thread);
        editing = null;
        formFor = "";
      } else if (t) {
        upsert((await api(`/${t.id}`, "POST", { body, author, viewer: viewerId() })) as Thread);
        formFor = "";
      }
      input.value = "";
      refresh();
      return true;
    } catch (err) {
      failed(err);
      return false;
    } finally {
      submit.disabled = false;
    }
  }

  async function toggleStatus() {
    const t = activeThread();
    if (!t) return;
    const status: ThreadStatus = t.status === "open" ? "resolved" : "open";
    try {
      upsert((await api(`/${t.id}`, "PATCH", { status, by: commenter().name, viewer: viewerId() })) as Thread);
    } catch (err) {
      return failed(err);
    }
    if (status === "resolved") {
      host.toast(showResolved ? "Resolved" : "Resolved · <kbd>⇧C</kbd> shows resolved");
      close();
    }
    refresh();
  }

  function step(dir: 1 | -1) {
    const t = activeThread();
    if (!t) return false;
    const sibs = siblings(t);
    if (sibs.length < 2) return false;
    const i = sibs.findIndex((x) => x.id === t.id);
    open({ id: sibs[(i + dir + sibs.length) % sibs.length].id });
    return true;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      // ⌘↵: send what's typed, then resolve (or reopen) the thread
      e.preventDefault();
      (async () => {
        const wasDraft = !!draft();
        if (input.value.trim() && !(await send())) return;
        if (!wasDraft && activeThread()) toggleStatus();
      })();
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (editing) {
        editing = null;
        renderPopover();
      } else {
        close();
        input.blur();
      }
    }
  });

  pop.addEventListener("click", async (e) => {
    const el = e.target as Element;
    const act = el.closest<HTMLElement>("[data-act]")?.dataset.act;
    const openId = el.closest<HTMLElement>("[data-open]")?.dataset.open;
    if (openId) return open({ id: openId });
    if (act === "close") return close();
    if (act === "cancel") {
      editing = null;
      return renderPopover();
    }
    if (act === "rename") return rename(el.closest<HTMLElement>("[data-act]")!);
    if (act === "goto") {
      const key = el.closest<HTMLElement>("[data-key]")!.dataset.key!;
      const k = host.resolveKey(key);
      if (k) host.setSelection([k], { fit: true });
      return;
    }
    const d = draft();
    if (d && (act === "whole" || act === "unwhole")) {
      d.ref = act === "whole" ? null : d.from;
      renderPopover();
      return draw();
    }
    const t = activeThread();
    if (!t) return;
    const commentId = el.closest<HTMLElement>("[data-comment]")?.dataset.comment;
    const me = commenter();
    try {
      if (act === "link") copy(linkTo(t), "Copied thread link");
      else if (act === "status") await toggleStatus();
      else if (act === "prev" || act === "next") step(act === "next" ? 1 : -1);
      else if (act === "edit" && commentId) {
        editing = commentId;
        renderPopover();
      } else if (act === "delete" && commentId) {
        if (!confirm("Delete this comment?")) return;
        const { thread } = (await api(`/${t.id}/${commentId}`, "DELETE", { secret: me.secret, viewer: viewerId() })) as { thread: Thread | null };
        if (thread) upsert(thread);
        else {
          threads.delete(t.id);
          close();
        }
        refresh();
      }
    } catch (err) {
      failed(err);
    }
  });

  function rename(btnEl: HTMLElement) {
    const field = document.createElement("input");
    field.className = "rename";
    field.value = commenter().name;
    field.maxLength = 40;
    field.setAttribute("aria-label", "Your name on comments");
    btnEl.replaceWith(field);
    field.focus();
    field.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save) renameCommenter(field.value);
      field.replaceWith(btnEl);
      renderPopover();
      input.focus();
    };
    field.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") e.preventDefault(), finish(true);
      else if (e.key === "Escape") e.preventDefault(), finish(false);
    });
    field.addEventListener("blur", () => finish(true));
  }

  /** Open a thread from a badge or a link: comment mode, the camera on its ref (from where it was made), the conversation. */
  function focus(id: string) {
    const t = threads.get(id);
    if (!t) return;
    toggle(true);
    open({ id });
    const key = keyOf(t);
    if (!key) return;
    host.setSelection([key]);
    const box = host.boxOfRefs(host.expand(key));
    const cam = t.anchor.camera;
    host.fitBox(box, cam ? new THREE.Vector3(...cam.position).sub(new THREE.Vector3(...cam.target)) : undefined);
  }

  // ---------- mode ----------
  const tool: Tool = {
    name: "comment",
    hover: true,
    cursor: "crosshair",
    click(hit: Hit | null, e: PointerEvent) {
      const d = draft();
      if (!hit) {
        if (d && input.value.trim()) return true; // don't lose a half-written comment
        if (active) return close(), true;
        return false;
      }
      const key = (e.altKey && host.parent(hit.ref)) || hit.ref;
      const text = d ? input.value : "";
      startDraft(key, hit.point, hit.normal);
      if (text) input.value = text; // re-aiming a half-written draft keeps it
      host.setSelection([key]);
      return true;
    },
    exit() {
      if (on) toggle(false);
    },
  };

  function toggle(next = !on) {
    if (next === on) return;
    on = next;
    if (on && !isPhone()) host.setTool(tool);
    if (!on) {
      if (host.tool() === tool) host.setTool(null);
      close();
    }
    document.body.classList.toggle("commenting", on);
    btn.setAttribute("aria-pressed", String(on));
    host.renderSelBar();
    draw();
  }
  btn.addEventListener("click", () => toggle());

  host.addSelAction({
    act: "comment",
    html: () => `<button class="btn" data-act="comment" title="Comment on the selection (C)" aria-label="Comment"><svg class="phone-only" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3.2V14.5H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg><span class="not-phone">Comment</span> <kbd>C</kbd></button>`,
    run: commentOnSelection,
  });
  host.setSelHint(() => {
    if (!on) return null;
    if (isPhone()) return `<b>Tap</b> a face, then <b>Comment</b> · tap a pin to open it`;
    return `<b>Click</b> a face to comment · <kbd>⌥</kbd> its feature · <kbd>⇧C</kbd> ${showResolved ? "hide" : "show"} resolved · <kbd>Esc</kbd> done`;
  });

  host.onKey((e) => {
    if (e.code === "KeyC" && e.shiftKey) {
      showResolved = !showResolved;
      if (!on) toggle(true);
      host.toast(showResolved ? "Showing resolved comments" : "Hiding resolved comments", 1200);
      refresh();
      return true;
    }
    if (e.code === "KeyC") {
      if (on) toggle(false);
      else if (host.selection().length) commentOnSelection();
      else toggle(true);
      return true;
    }
    if (!e.shiftKey && (e.key === "[" || e.key === "]")) return step(e.key === "]" ? 1 : -1);
    return false;
  });
  host.onEscape(10, () => {
    if (!active) return false;
    if (editing) (editing = null), renderPopover();
    else close();
    return true;
  });
  host.onEscape(30, () => {
    if (!on) return false;
    toggle(false);
    return true;
  });

  // ---------- counts: toolbar badge, Features panel badges, the Whole model row ----------
  function renderCounts() {
    const open = [...threads.values()].filter((t) => t.status === "open" && t.comments.length).length;
    const badge = btn.querySelector<HTMLElement>(".badge")!;
    badge.textContent = String(open);
    badge.hidden = !open;
    btn.title = `Comment: ${isPhone() ? "show pins; select a face and tap Comment" : "click a face to leave a comment"} (C)${open ? ` · ${open} open` : ""}`;
  }

  function renderBadges() {
    const own = new Map<string, number>();
    const sum = new Map<string, number>(); // feature id -> threads on it or anything inside it
    let whole = 0;
    for (const t of threads.values()) {
      if (t.status !== "open" || !t.comments.length) continue;
      const k = keyOf(t);
      if (!k) {
        whole++;
        continue;
      }
      own.set(k, (own.get(k) ?? 0) + 1);
      const id = parseRef(k)?.id;
      if (id) sum.set(id, (sum.get(id) ?? 0) + 1);
    }
    const pill = (cls: string, n: number) => (n ? `<i class="${cls}" title="${n} open comment${n === 1 ? "" : "s"}">${n}</i>` : "");
    const side = (key: string | null, o: number, s: number) =>
      `<span class="cside"><span class="cbadge">${pill("own", o)}${pill("sum", s)}</span>` +
      `<span class="cadd" title="Comment on ${escapeHtml(key ?? "the whole model")} (C)" aria-label="Comment on ${escapeHtml(key ?? "the whole model")}">+</span></span>`;
    treeEl.querySelectorAll<HTMLElement>(".row[data-key]").forEach((row) => {
      const key = row.dataset.key!;
      const li = row.parentElement;
      const feat = li?.classList.contains("feat") ? li.dataset.feature! : null;
      row.querySelector(".cside")?.remove();
      row.insertAdjacentHTML("beforeend", side(key, own.get(key) ?? 0, feat ? sum.get(feat) ?? 0 : 0));
    });
    let wholeRow = treeEl.querySelector<HTMLElement>(":scope > .cwhole");
    if (!wholeRow) {
      treeEl.insertAdjacentHTML("afterbegin", `<li class="cwhole"><div class="row" role="button" tabindex="0" title="Comments on the model as a whole, and on faces that are gone"><span class="id">Whole model</span></div></li>`);
      wholeRow = treeEl.querySelector<HTMLElement>(":scope > .cwhole")!;
    }
    const r = wholeRow.querySelector<HTMLElement>(".row")!;
    r.querySelector(".cside")?.remove();
    r.insertAdjacentHTML("beforeend", side(null, whole, 0));
  }

  const threadsFor = (key: string | null, feat: string | null) =>
    [...threads.values()]
      .filter((t) => t.status === "open" && t.comments.length)
      .filter((t) => {
        const k = keyOf(t);
        if (key === null) return !k;
        return feat ? !!k && parseRef(k)?.id === feat : k === key;
      })
      .sort((a, b) => a.createdAt - b.createdAt);

  // ahead of the viewer's own row clicks (capture), so a badge or "+" doesn't also select
  treeEl.addEventListener("click", (e) => {
    const el = e.target as Element;
    const pill = el.closest<HTMLElement>(".cbadge i");
    const add = el.closest(".cadd");
    const whole = el.closest(".cwhole");
    if (!pill && !add && !whole) return;
    e.stopPropagation();
    e.preventDefault();
    const key = whole ? null : el.closest<HTMLElement>("[data-key]")?.dataset.key ?? null;
    if (add) {
      toggle(true);
      if (key) host.setSelection([key]);
      return startDraft(key);
    }
    const feat = pill?.classList.contains("sum") ? el.closest<HTMLElement>(".feat")?.dataset.feature ?? null : null;
    const list = threadsFor(key, feat);
    if (list.length) return focus(list[0].id);
    if (whole) toggle(true), startDraft(null);
  }, true);
  treeEl.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && (e.target as Element).closest?.(".cwhole")) {
      e.preventDefault();
      (e.target as HTMLElement).click();
    }
  });

  // ---------- data ----------
  function refresh() {
    renderCounts();
    renderBadges();
    renderPopover();
    draw();
    host.renderSelBar();
  }

  function initialFocus() {
    if (!wanted || !loaded || !built) return;
    const id = wanted;
    wanted = null;
    if (threads.has(id)) focus(id);
    else {
      host.setUrlParam("c", null);
      host.toast("That comment thread was deleted", 3000);
    }
  }

  async function load() {
    try {
      const { threads: all } = (await api("")) as { threads: Thread[] };
      threads.clear();
      all.forEach(upsert);
      loaded = true;
    } catch {}
    refresh();
    initialFocus();
  }

  host.on("load", load);
  host.on("tree", renderBadges);
  host.on("render", draw);
  host.on("resize", draw);
  host.on("build", () => {
    placer.invalidate();
    built = true;
    refresh();
    initialFocus();
  });
  host.onMessage((msg) => {
    if (msg.type === "thread") {
      upsert(msg.thread);
      placer.invalidate(msg.thread.id);
    } else if (msg.type === "thread-deleted") {
      threads.delete(msg.id);
      placer.invalidate(msg.id);
    } else if (msg.type === "thread-targets") {
      for (const [id, target] of Object.entries(msg.targets)) {
        const t = threads.get(id);
        if (t) (t.target = target), placer.invalidate(id);
      }
    } else return false;
    refresh();
    return true;
  });

  // relative times drift; refresh them now and then
  setInterval(() => active && renderPopover(), 60000);
  renderCounts();
}
