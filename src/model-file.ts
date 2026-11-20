import { DurableObject } from "cloudflare:workers";
import { newLockToken } from "./ids.ts";
import type { Env } from "./index.ts";
import { track } from "./analytics.ts";
import { type CadDoc, type Issue, emptyDoc, validate } from "./schema.ts";
import { type EditOp, allIds, applyOps, canonical, diff, findFeature } from "./tree.ts";

/** How long a start_edit claim holds before another session may take the model. */
const LOCK_MS = 10 * 60 * 1000;
/** The viewer pings every 25s; a ping marked active (visible tab, recent input) counts as that much engaged time. */
const PING_MS = 25 * 1000;
/** Versions kept for ?v= comparisons, conflict reports and reading old trees. Trees are small. */
export const HISTORY = 50;
/** Deleted models wait this long in the trash, where anyone with the link can restore them, before they're erased. */
export const TRASH_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_TREE_BYTES = 256 * 1024;


export class ToolError extends Error {}

/** Kept on each socket (survives hibernation) so the session can be reported when it closes. */
interface ViewerSession {
  viewer: string;
  device: string;
  country: string;
  start: number;
  activePings: number;
}

export type ClaimStatus = "working" | "ready";

export interface ModelState {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  status: ClaimStatus;
  task: string | null;
  /** Refs the claim said it would change; the viewer highlights them. */
  scope: string[];
  lockExpiresAt: number | null;
  tree: CadDoc;
}

export interface TrashedModel {
  id: string;
  name: string;
  deletedAt: number;
  purgeAt: number;
}

export interface VersionInfo {
  version: number;
  summary: string;
  changed: string[];
  by: string;
  at: number;
}

export interface Alias {
  oldId: string;
  /** Null when the id was removed without a successor. */
  newId: string | null;
  version: number;
  /** The feature or part JSON when it was removed. */
  was: unknown;
}

export interface CommitResult {
  version: number;
  tree: CadDoc;
  added: string[];
  changed: string[];
  removed: string[];
  renames: Record<string, string>;
  warnings: string[];
  unchanged: boolean;
}

type Broadcast =
  | { type: "tree"; version: number; tree: CadDoc; summary: string; changed: string[]; by: string }
  | { type: "claim"; status: ClaimStatus; task: string | null; scope: string[]; lockExpiresAt: number | null }
  | { type: "model"; name: string }
  | ({ type: "model-deleted" } & TrashedModel)
  | { type: "model-restored" };

interface VersionRow {
  version: number;
  tree: string;
  summary: string;
  changed: string;
  by: string;
  created_at: number;
  [key: string]: SqlStorageValue;
}

interface AliasRow {
  old_id: string;
  new_id: string | null;
  version: number;
  was: string | null;
  created_at: number;
  [key: string]: SqlStorageValue;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "Invalid tree: 2 problems. parts[0].features[3].at: …" — one line per issue, from validate() or applyOps(). */
export function issuesMessage(prefix: "Invalid tree" | "Invalid edit", issues: Issue[]): string {
  const shown = issues.slice(0, 20).map((i) => (i.path && !i.path.startsWith("ops[") ? `${i.path}: ${i.message}` : i.message));
  const more = issues.length > shown.length ? ` …and ${issues.length - shown.length} more.` : "";
  return `${prefix}: ${issues.length} problem${issues.length === 1 ? "" : "s"}. ${shown.join(" · ")}${more} Nothing was saved.`;
}

/** Validation the Durable Object can run on its own: pure TS, no geometry. */
export function checkTree(doc: CadDoc): string {
  const json = canonical(doc);
  if (json.length > MAX_TREE_BYTES) throw new ToolError(`Tree too large: ${Math.round(json.length / 1024)} KB (limit ${MAX_TREE_BYTES / 1024} KB).`);
  const issues = validate(doc);
  if (issues.length) throw new ToolError(issuesMessage("Invalid tree", issues));
  return json;
}

/**
 * One Durable Object per model. It owns the model's tree and its history,
 * serializes every write (so claims can't race), and fans changes out to
 * every open viewer over hibernatable WebSockets. It never builds geometry:
 * that runs in the Worker isolate (MCP) and in the browser.
 */
export class CadModel extends DurableObject<Env> {
  private sql: SqlStorage;
  /** False until init() runs. Lookups of a model that doesn't exist must not write, or they'd count as stored objects. */
  private ready: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ready = this.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
  }

  private createSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (
        version INTEGER PRIMARY KEY,
        tree TEXT NOT NULL,
        summary TEXT NOT NULL,
        changed TEXT NOT NULL,
        by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aliases (
        old_id TEXT PRIMARY KEY,
        new_id TEXT,
        version INTEGER NOT NULL,
        was TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.ready = true;
  }

  // ---------- meta ----------

  private meta(key: string): string | null {
    if (!this.ready) return null;
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? row.value : null;
  }
  private setMeta(key: string, value: string | null) {
    if (value === null) this.sql.exec("DELETE FROM meta WHERE key = ?", key);
    else this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
  /** A trashed model reads as deleted everywhere except trashInfo() and restoreModel(). */
  private requireModel() {
    if (!this.meta("id")) throw new ToolError("Model not found. Check the link, or create one with create_model.");
    const t = this.trashed();
    if (t) throw new ToolError(`This model was deleted on ${day(t.deletedAt)}. Anyone with its link can restore it from the viewer until ${day(t.purgeAt)}.`);
  }
  private trashed(): TrashedModel | null {
    const at = Number(this.meta("deleted_at"));
    return at ? { id: this.meta("id")!, name: this.meta("name")!, deletedAt: at, purgeAt: at + TRASH_MS } : null;
  }
  private version(): number {
    return Number(this.meta("version") ?? 0);
  }

  /** Create the model. A tree, if given, becomes version 1 (it must already pass checkTree; nothing is created otherwise). */
  async init(id: string, name: string, tree?: CadDoc, by = "agent", summary = "Created"): Promise<ModelState> {
    if (tree) checkTree(tree);
    if (!this.ready) this.createSchema();
    if (!this.meta("id")) {
      const now = Date.now();
      this.setMeta("id", id);
      this.setMeta("name", name);
      this.setMeta("created_at", String(now));
      this.setMeta("updated_at", String(now));
      this.setMeta("version", "0");
      this.sql.exec("INSERT INTO versions (version, tree, summary, changed, by, created_at) VALUES (0, ?, 'Empty model', '[]', ?, ?)", canonical(emptyDoc()), by, now);
      if (tree) this.commit(tree, { summary, by });
    }
    return this.getState();
  }

  async exists(): Promise<boolean> {
    return !!this.meta("id");
  }

  /** The model's trash state, or null if it isn't trashed (or doesn't exist). Never throws, so the viewer can offer a restore. */
  async trashInfo(): Promise<TrashedModel | null> {
    return this.meta("id") ? this.trashed() : null;
  }

  async deleteModel(): Promise<TrashedModel> {
    this.requireModel();
    this.setMeta("deleted_at", String(Date.now()));
    this.clearClaim();
    await this.ctx.storage.setAlarm(Date.now() + TRASH_MS);
    const t = this.trashed()!;
    this.broadcast({ type: "model-deleted", ...t });
    return t;
  }

  async restoreModel(): Promise<ModelState> {
    if (!this.meta("id")) this.requireModel();
    if (this.trashed()) {
      this.setMeta("deleted_at", null);
      await this.ctx.storage.deleteAlarm();
      this.broadcast({ type: "model-restored" });
    }
    return this.getState();
  }

  async alarm() {
    if (!this.ready) return;
    const at = Number(this.meta("deleted_at"));
    if (!at) return;
    if (at + TRASH_MS > Date.now()) {
      await this.ctx.storage.setAlarm(at + TRASH_MS);
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "deleted");
      } catch {}
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ready = false;
  }

  private claim() {
    const lock = this.meta("lock");
    const expires = Number(this.meta("lock_expires") ?? 0);
    const live = !!lock && expires > Date.now();
    return {
      live,
      lock: live ? lock : null,
      task: live ? this.meta("task") : null,
      scope: live ? (JSON.parse(this.meta("scope") ?? "[]") as string[]) : [],
      expires: live ? expires : null,
    };
  }

  private clearClaim() {
    for (const k of ["lock", "lock_expires", "task", "scope"]) this.setMeta(k, null);
  }

  private claimMessage(): Broadcast {
    const c = this.claim();
    // an expired claim reads as ready so a crashed session never shows as working forever
    return { type: "claim", status: c.live ? "working" : "ready", task: c.task, scope: c.scope, lockExpiresAt: c.expires };
  }

  async getState(): Promise<ModelState> {
    this.requireModel();
    const c = this.claim();
    return {
      id: this.meta("id")!,
      name: this.meta("name")!,
      createdAt: Number(this.meta("created_at")),
      updatedAt: Number(this.meta("updated_at")),
      version: this.version(),
      status: c.live ? "working" : "ready",
      task: c.task,
      scope: c.scope,
      lockExpiresAt: c.expires,
      tree: this.treeAt(this.version())!.tree,
    };
  }

  async renameModel(name: string): Promise<void> {
    this.requireModel();
    this.setMeta("name", name);
    this.broadcast({ type: "model", name });
  }

  // ---------- versions ----------

  private treeAt(version: number): { tree: CadDoc; row: VersionRow } | null {
    const row = this.sql.exec<VersionRow>("SELECT * FROM versions WHERE version = ?", version).toArray()[0];
    return row ? { tree: JSON.parse(row.tree) as CadDoc, row } : null;
  }

  async getTree(version?: number): Promise<{ version: number; tree: CadDoc; summary: string; by: string; at: number }> {
    this.requireModel();
    const v = version ?? this.version();
    const t = this.treeAt(v);
    if (!t) {
      const oldest = this.sql.exec<{ v: number }>("SELECT MIN(version) AS v FROM versions").toArray()[0]?.v ?? 0;
      throw new ToolError(`Version ${v} not found: this model is at v${this.version()} and keeps v${oldest}–v${this.version()}.`);
    }
    return { version: v, tree: t.tree, summary: t.row.summary, by: t.row.by, at: t.row.created_at };
  }

  async listVersions(limit = HISTORY): Promise<VersionInfo[]> {
    this.requireModel();
    return this.sql
      .exec<VersionRow>("SELECT version, summary, changed, by, created_at FROM versions ORDER BY version DESC LIMIT ?", limit)
      .toArray()
      .map((r) => ({ version: r.version, summary: r.summary, changed: JSON.parse(r.changed), by: r.by, at: r.created_at }));
  }

  /** Ids that differ between `version` and now, or null if that version is older than the kept history. */
  async changedSince(version: number): Promise<string[] | null> {
    this.requireModel();
    return this.changedSinceSync(version);
  }
  private changedSinceSync(version: number): string[] | null {
    const now = this.version();
    if (version >= now) return [];
    const then = this.treeAt(version);
    if (!then) return null;
    const d = diff(then.tree, this.treeAt(now)!.tree);
    return [...d.added, ...d.changed, ...d.removed];
  }

  async lookupAliases(ids: string[]): Promise<Record<string, Alias>> {
    this.requireModel();
    const out: Record<string, Alias> = {};
    for (const id of new Set(ids)) {
      const r = this.sql.exec<AliasRow>("SELECT * FROM aliases WHERE old_id = ?", id).toArray()[0];
      if (r) out[id] = { oldId: r.old_id, newId: r.new_id, version: r.version, was: r.was ? JSON.parse(r.was) : null };
    }
    return out;
  }

  // ---------- claims ----------

  private assertClaimable(lock?: string) {
    const c = this.claim();
    if (!c.live || c.lock === lock) return;
    const mins = Math.ceil((c.expires! - Date.now()) / 60000);
    const task = c.task ? ` (task: ${c.task})` : "";
    // sessions can't be told apart, so a call without the lock is as likely the claim holder's slip as a second session
    if (!lock) {
      throw new ToolError(
        `The model is claimed${task} and this call didn't pass its lock. If you claimed it with start_edit, call again with the lock it returned. ` +
          `Otherwise it's being edited by another session: its claim expires in ~${mins} min, so try again later.`,
      );
    }
    throw new ToolError(`The model is being edited by another session${task}; the lock you passed isn't the current claim. Its claim expires in ~${mins} min.`);
  }

  private assertBase(baseVersion?: number) {
    const now = this.version();
    if (baseVersion === undefined || baseVersion === now) return;
    const changed = this.changedSinceSync(baseVersion);
    const what = changed === null ? "" : changed.length ? ` Changed since: ${changed.join(", ")}.` : "";
    throw new ToolError(`Version conflict: the model is at v${now}, you edited v${baseVersion}.${what} Call resolve (or get_model) again and reapply your change.`);
  }

  /** Claim the model. The viewer shows the task and highlights `scope` until a write or release_edit. Passing the lock you hold renews the claim. */
  async startEdit(input: { task: string; scope?: string[]; lock?: string }): Promise<{ lock: string; baseVersion: number; lockExpiresAt: number }> {
    this.requireModel();
    this.assertClaimable(input.lock);
    const c = this.claim();
    const lock = input.lock && c.lock === input.lock ? input.lock : newLockToken();
    const expires = Date.now() + LOCK_MS;
    this.setMeta("lock", lock);
    this.setMeta("lock_expires", String(expires));
    this.setMeta("task", input.task);
    this.setMeta("scope", JSON.stringify(input.scope ?? []));
    this.broadcast(this.claimMessage());
    return { lock, baseVersion: this.version(), lockExpiresAt: expires };
  }

  async releaseEdit(lock?: string): Promise<void> {
    this.requireModel();
    this.assertClaimable(lock);
    this.clearClaim();
    this.broadcast(this.claimMessage());
  }

  // ---------- writes ----------

  /** Replace the whole tree. `renames` (old id → new id) keeps old links following renamed features. */
  async writeTree(input: {
    tree: CadDoc;
    lock?: string;
    baseVersion?: number;
    summary?: string;
    renames?: Record<string, string>;
    keepClaim?: boolean;
    by: string;
  }): Promise<CommitResult> {
    this.requireModel();
    this.assertClaimable(input.lock);
    this.assertBase(input.baseVersion);
    checkTree(input.tree);
    const prev = this.treeAt(this.version())!.tree;
    const renames = input.renames ?? {};
    const prevIds = new Set(allIds(prev));
    const nextIds = new Set(allIds(input.tree));
    const bad = Object.entries(renames).flatMap(([from, to]) => [
      ...(prevIds.has(from) ? [] : [`renames: "${from}" isn't in the current tree`]),
      ...(nextIds.has(to) ? [] : [`renames: "${to}" isn't in the new tree`]),
      ...(nextIds.has(from) ? [`renames: "${from}" is still in the new tree`] : []),
    ]);
    if (bad.length) throw new ToolError(`Invalid tree: ${bad.join(" · ")}. Nothing was saved.`);
    const result = this.commit(input.tree, {
      summary: input.summary || "Rewrote the model",
      by: input.by,
      renames,
      keepClaim: input.keepClaim,
    });
    const silent = result.removed;
    if (silent.length) {
      result.warnings.unshift(
        `This write removed ${silent.join(", ")}. Links to ${silent.length === 1 ? "it" : "them"} now resolve as removed. If you renamed ${silent.length === 1 ? "it" : "them"}, write again with renames or use edit_features rename.`,
      );
    }
    return result;
  }

  /** The scoped edit: apply ops to the current tree, validate the result once, save atomically. */
  async applyEdit(input: { ops: EditOp[]; lock?: string; baseVersion?: number; summary?: string; keepClaim?: boolean; by: string }): Promise<CommitResult> {
    this.requireModel();
    this.assertClaimable(input.lock);
    this.assertBase(input.baseVersion);
    const prev = this.treeAt(this.version())!.tree;
    const r = applyOps(prev, input.ops);
    if (!r.ok) throw new ToolError(issuesMessage("Invalid edit", r.issues));
    const json = canonical(r.doc);
    if (json.length > MAX_TREE_BYTES) throw new ToolError(`Tree too large: ${Math.round(json.length / 1024)} KB (limit ${MAX_TREE_BYTES / 1024} KB).`);
    const auto = input.ops
      .slice(0, 4)
      .map((o) => `${o.op} ${"id" in o ? o.id : o.op === "add" ? o.feature?.id : o.op === "add_part" ? o.part?.id : ""}${o.op === "rename" ? ` → ${o.to}` : ""}`)
      .join(", ");
    return this.commit(r.doc, {
      summary: input.summary || `edit_features: ${auto}${input.ops.length > 4 ? ", …" : ""}`,
      by: input.by,
      renames: r.renames,
      keepClaim: input.keepClaim,
    });
  }

  /** Store a new version (the tree is already valid), record aliases, trim history, end the claim, broadcast. */
  private commit(next: CadDoc, opts: { summary: string; by: string; renames?: Record<string, string>; keepClaim?: boolean }): CommitResult {
    const now = Date.now();
    const cur = this.version();
    const prev = this.treeAt(cur)!.tree;
    const tree = JSON.parse(canonical({ units: "mm", ...next })) as CadDoc;
    const renames = opts.renames ?? {};
    const d = diff(prev, tree);
    const renamedFrom = new Set(Object.keys(renames));
    const removed = d.removed.filter((id) => !renamedFrom.has(id));
    const warnings: string[] = [];

    const finish = () => {
      if (!opts.keepClaim) this.clearClaim();
      else if (this.claim().live) this.setMeta("lock_expires", String(now + LOCK_MS));
      this.broadcast(this.claimMessage());
    };

    if (!d.added.length && !d.changed.length && !d.removed.length) {
      finish();
      return { version: cur, tree: prev, added: [], changed: [], removed: [], renames: {}, warnings: ["Nothing changed: the tree is the same as v" + cur + "."], unchanged: true };
    }

    const version = cur + 1;
    // live ids shadow aliases: reusing a removed or renamed-away id repoints its old links
    const renamedTo = new Set(Object.values(renames));
    for (const id of d.added) {
      const a = this.sql.exec<AliasRow>("SELECT * FROM aliases WHERE old_id = ?", id).toArray()[0];
      if (!a) continue;
      this.sql.exec("DELETE FROM aliases WHERE old_id = ?", id);
      if (!renamedTo.has(id)) {
        warnings.push(
          `"${id}" was ${a.new_id ? `renamed to "${a.new_id}"` : "removed"} in v${a.version}; old links to "${id}" now point at this new feature. Prefer a new id unless it's the same thing.`,
        );
      }
    }
    for (const [from, to] of Object.entries(renames)) {
      this.sql.exec("UPDATE aliases SET new_id = ?, version = ? WHERE new_id = ?", to, version, from);
      this.sql.exec(
        "INSERT INTO aliases (old_id, new_id, version, was, created_at) VALUES (?, ?, ?, NULL, ?) ON CONFLICT(old_id) DO UPDATE SET new_id = excluded.new_id, version = excluded.version, was = NULL",
        from, to, version, now,
      );
    }
    this.sql.exec("DELETE FROM aliases WHERE old_id = new_id");
    for (const id of removed) {
      const loc = findFeature(prev, id);
      const was = canonical(loc ? loc.feature : prev.parts.find((p) => p.id === id) ?? null);
      // links that followed a rename to this id are gone with it
      this.sql.exec("UPDATE aliases SET new_id = NULL, version = ?, was = ? WHERE new_id = ?", version, was, id);
      this.sql.exec(
        "INSERT INTO aliases (old_id, new_id, version, was, created_at) VALUES (?, NULL, ?, ?, ?) ON CONFLICT(old_id) DO UPDATE SET new_id = NULL, version = excluded.version, was = excluded.was",
        id, version, was, now,
      );
    }

    const changed = [...d.added, ...d.changed, ...d.removed];
    this.sql.exec(
      "INSERT INTO versions (version, tree, summary, changed, by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      version, canonical(tree), opts.summary.slice(0, 200), JSON.stringify(changed), opts.by, now,
    );
    this.sql.exec("DELETE FROM versions WHERE version <= ?", version - HISTORY);
    this.setMeta("version", String(version));
    this.setMeta("updated_at", String(now));
    this.broadcast({ type: "tree", version, tree, summary: opts.summary, changed, by: opts.by });
    finish();
    return { version, tree, added: d.added, changed: d.changed, removed, renames, warnings, unchanged: false };
  }

  // ---------- live viewer ----------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const session: ViewerSession = {
      viewer: (url.searchParams.get("v") ?? "").replace(/[^a-z0-9]/g, "").slice(0, 32),
      device: url.searchParams.get("d") === "touch" ? "touch" : "desktop",
      country: request.headers.get("x-ic-country") ?? "",
      start: Date.now(),
      activePings: 0,
    };
    pair[1].serializeAttachment(session);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message !== "ping" && message !== "ping:active") return;
    ws.send("pong");
    if (message === "ping:active") {
      const session = ws.deserializeAttachment() as ViewerSession | null;
      if (session) ws.serializeAttachment({ ...session, activePings: session.activePings + 1 });
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    await this.endSession(ws);
    try {
      ws.close(code, "bye");
    } catch {}
  }

  async webSocketError(ws: WebSocket) {
    await this.endSession(ws);
  }

  /** One "session" event per viewer connection: how long it was open and how much of that was engaged. */
  private async endSession(ws: WebSocket) {
    const session = ws.deserializeAttachment() as ViewerSession | null;
    if (!session?.viewer) return;
    ws.serializeAttachment(null); // close and error can both fire; report once
    await track(this.env, {
      event: "session",
      name: "viewer",
      modelId: this.meta("id") ?? undefined,
      actor: session.viewer,
      detail: session.device,
      country: session.country,
      ms: Date.now() - session.start,
      size: session.activePings * PING_MS,
    });
  }

  private broadcast(msg: Broadcast) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {}
    }
  }
}
