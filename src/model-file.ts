import { DurableObject } from "cloudflare:workers";
import { newCommentId, newLockToken, newThreadId } from "./ids.ts";
import type { Env } from "./index.ts";
import { track } from "./analytics.ts";
import { type CadDoc, type Issue, type Vec3, emptyDoc, formatRef, parseRef, validate } from "./schema.ts";
import { type EditOp, allIds, applyOps, canonical, diff, findFeature, propertyDiff, refProblem } from "./tree.ts";
import {
  type AuthorKind, type CameraPose, type ClaimStatus, type FactsSnapshot, type ModelNotes, type ModelState, type OrphanedComment,
  type RefTarget, type RestoreResult, type ServerMessage, type Thread, type ThreadStatus, type TrashedModel, type VersionDetail,
  type VersionDiff, type VersionInfo, type VersionPage, type VersionTree, LIMITS_COLLAB,
} from "./collab.ts";

export type { ClaimStatus, ModelState, TrashedModel, VersionInfo };

/** How long a start_edit claim holds before another session may take the model. */
const LOCK_MS = 10 * 60 * 1000;
/** The viewer pings every 25s; a ping marked active (visible tab, recent input) counts as that much engaged time. */
const PING_MS = 25 * 1000;
/** Versions per page of listVersions (every version is kept; trees are small). */
const PAGE = 50;
const MAX_PAGE = 200;
const MAX_THREADS = LIMITS_COLLAB.threads;
const MAX_COMMENTS_PER_THREAD = LIMITS_COLLAB.repliesPerThread;
const MAX_BODY = LIMITS_COLLAB.commentChars;
const MAX_NOTES = LIMITS_COLLAB.notesChars;
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
  /** Open threads this write detached (their ref was removed or no longer resolves). */
  orphaned: OrphanedComment[];
  /** Open threads on the model after the write. */
  openComments: number;
}

type Broadcast = ServerMessage;

interface VersionRow {
  version: number;
  tree: string;
  summary: string;
  changed: string;
  by: string;
  created_at: number;
  detail: string | null;
  [key: string]: SqlStorageValue;
}

interface ThreadRow {
  id: string;
  ref: string | null;
  point: string | null;
  normal: string | null;
  camera: string | null;
  version: number;
  facts: string | null;
  status: ThreadStatus;
  resolved_by: string | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

interface CommentRow {
  id: string;
  thread_id: string;
  author_id: string;
  author_name: string;
  author_kind: AuthorKind;
  author_key: string | null;
  body: string;
  created_at: number;
  edited_at: number | null;
  [key: string]: SqlStorageValue;
}

interface NotesRow {
  body: string;
  version: number;
  updated_at: number;
  updated_by: string;
  updated_by_kind: AuthorKind;
  [key: string]: SqlStorageValue;
}

/** Who wrote a comment. There's no auth: people are a random id + name kept in their browser, and `secret` lets only that browser edit or delete what it wrote. */
export interface CommentAuthor {
  id: string;
  name: string;
  kind: AuthorKind;
  secret?: string;
}

const EMPTY_DETAIL: VersionDetail = { added: [], changed: [], removed: [], renames: {}, restoredFrom: null };

const cleanBody = (body: string) => {
  const b = (body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!b) throw new ToolError("A comment needs some text.");
  if (b.length > MAX_BODY) throw new ToolError(`Comment too large: ${b.length} characters (limit ${MAX_BODY}).`);
  return b;
};

const cleanName = (name: string | undefined) => (name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);

const cleanAuthor = (a: CommentAuthor): CommentAuthor => {
  const name = cleanName(a?.name);
  if (!name || !/^[a-z0-9:_-]{2,48}$/i.test(a?.id ?? "")) throw new ToolError("A comment needs an author id and name.");
  if (a.kind !== "agent" && !/^[a-z0-9]{24,64}$/i.test(a.secret ?? "")) throw new ToolError("A comment needs the author's key.");
  return { id: a.id, name, kind: a.kind === "agent" ? "agent" : "person", secret: a.secret };
};

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 1e6);
const cleanPoint = (v: unknown): Vec3 | null => (isVec3(v) ? v : null);
const cleanNormal = (v: unknown): Vec3 | null => {
  if (!isVec3(v)) return null;
  const l = Math.hypot(...v);
  return l > 1e-9 ? (v.map((x) => x / l) as Vec3) : null;
};
const cleanCamera = (c: unknown): CameraPose | null => {
  const x = c as CameraPose | null;
  if (!x || !isVec3(x.position) || !isVec3(x.target) || !isVec3(x.up)) return null;
  if (typeof x.fov !== "number" || !Number.isFinite(x.fov) || x.fov < 1 || x.fov > 179) return null;
  return { position: x.position, target: x.target, up: x.up, fov: x.fov };
};
const excerpt = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

async function keyHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ic-author:${secret}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  /** Comment tables arrived after models existed, so they're created on the first comment, not in createSchema. */
  private commentsReady: boolean;
  /** And notes, with the first write. */
  private notesReady: boolean;
  /** The current tree, parsed once per version. */
  private cur?: { version: number; doc: CadDoc; ids: Set<string> };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    const tables = new Set(this.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => r.name));
    this.ready = tables.has("meta");
    this.commentsReady = tables.has("threads");
    this.notesReady = tables.has("notes");
    // models made before history kept details have no detail column (no migration layer, see createSchema)
    if (tables.has("versions") && !this.sql.exec<{ name: string }>("PRAGMA table_info(versions)").toArray().some((c) => c.name === "detail")) {
      this.sql.exec("ALTER TABLE versions ADD COLUMN detail TEXT");
    }
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
        created_at INTEGER NOT NULL,
        detail TEXT
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
      this.sql.exec(
        "INSERT INTO versions (version, tree, summary, changed, by, created_at, detail) VALUES (0, ?, 'Empty model', '[]', ?, ?, ?)",
        canonical(emptyDoc()), by, now, JSON.stringify(EMPTY_DETAIL),
      );
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
    this.commentsReady = false;
    this.notesReady = false;
    this.cur = undefined;
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

  /** The current tree, parsed once per version. */
  private current(): { version: number; doc: CadDoc; ids: Set<string> } {
    const v = this.version();
    if (this.cur?.version !== v) {
      const doc = this.treeAt(v)!.tree;
      this.cur = { version: v, doc, ids: new Set(allIds(doc)) };
    }
    return this.cur;
  }

  private oldest(): number {
    return this.sql.exec<{ v: number | null }>("SELECT MIN(version) AS v FROM versions").toArray()[0]?.v ?? 0;
  }

  private requireTree(version: number): { tree: CadDoc; row: VersionRow } {
    const t = this.treeAt(version);
    if (!t) throw new ToolError(`Version ${version} not found: this model is at v${this.version()} and keeps v${this.oldest()}–v${this.version()}.`);
    return t;
  }

  private info(r: VersionRow): VersionInfo {
    return {
      version: r.version,
      summary: r.summary,
      by: r.by,
      at: r.created_at,
      changed: JSON.parse(r.changed),
      detail: r.detail ? (JSON.parse(r.detail) as VersionDetail) : null,
    };
  }

  async getTree(version?: number): Promise<VersionTree> {
    this.requireModel();
    const t = this.requireTree(version ?? this.version());
    return { ...this.info(t.row), tree: t.tree };
  }

  /** Newest first, `limit` per page; pass the returned `next` as `before` for the next, older page. */
  async listVersions(opts: { before?: number; limit?: number } = {}): Promise<VersionPage> {
    this.requireModel();
    const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(opts.limit ?? PAGE) || PAGE));
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    const rows = this.sql
      .exec<VersionRow>("SELECT version, summary, changed, by, created_at, detail FROM versions WHERE version < ? ORDER BY version DESC LIMIT ?", before, limit + 1)
      .toArray();
    const page = rows.slice(0, limit);
    return {
      versions: page.map((r) => this.info(r)),
      current: this.version(),
      oldest: this.oldest(),
      next: rows.length > limit ? page[page.length - 1].version : null,
    };
  }

  /** Per-property changes between two versions (to defaults to the current one; from > to diffs backwards), following renames. */
  async diffVersions(from: number, to?: number): Promise<VersionDiff> {
    this.requireModel();
    return this.diffSync(from, to ?? this.version());
  }
  private diffSync(from: number, to: number): VersionDiff {
    const a = this.requireTree(from).tree, b = this.requireTree(to).tree;
    const lo = Math.min(from, to), hi = Math.max(from, to);
    // compose renames lo → hi: ids at lo -> ids at hi
    const composed: Record<string, string> = {};
    let complete = true;
    const rows = this.sql.exec<{ detail: string | null }>("SELECT detail FROM versions WHERE version > ? AND version <= ? ORDER BY version ASC", lo, hi).toArray();
    if (rows.length !== hi - lo) complete = false;
    for (const r of rows) {
      if (!r.detail) {
        complete = false;
        continue;
      }
      for (const [x, y] of Object.entries((JSON.parse(r.detail) as VersionDetail).renames)) {
        const k = Object.keys(composed).find((k) => composed[k] === x);
        if (k !== undefined) composed[k] = y;
        else if (!(x in composed)) composed[x] = y;
      }
    }
    const renames = from <= to ? composed : Object.fromEntries(Object.entries(composed).map(([x, y]) => [y, x]));
    return { from, to, renamesComplete: complete, ...propertyDiff(a, b, renames) };
  }

  /**
   * Make an old version current again, as a new version. Renames made since are undone (old links
   * keep working), and the restore is refused while anyone holds a claim (people) or without the lock (agents).
   */
  async restoreVersion(input: { version: number; baseVersion?: number; lock?: string; by: string; who: "person" | "agent" }): Promise<RestoreResult> {
    this.requireModel();
    if (input.who === "person") {
      const c = this.claim();
      if (c.live) {
        const mins = Math.ceil((c.expires! - Date.now()) / 60000);
        throw new ToolError(
          `The model is being edited by another session${c.task ? ` (task: ${c.task})` : ""}. Its claim expires in ~${mins} min; restore after it saves or releases.`,
        );
      }
    } else this.assertClaimable(input.lock);
    this.assertBase(input.baseVersion);
    const target = this.requireTree(input.version).tree;
    checkTree(target);
    const { ids: live } = this.current();
    const targetIds = new Set(allIds(target));
    const renames: Record<string, string> = {};
    for (const x of targetIds) {
      if (live.has(x)) continue;
      const a = this.sql.exec<{ new_id: string | null }>("SELECT new_id FROM aliases WHERE old_id = ?", x).toArray()[0];
      const y = a?.new_id;
      if (y && live.has(y) && !targetIds.has(y) && !Object.values(renames).includes(x) && !(y in renames)) renames[y] = x;
    }
    const r = this.commit(target, { summary: `Restored v${input.version}`, by: input.by, renames, restoredFrom: input.version, restoring: true });
    return {
      version: r.version,
      tree: r.tree,
      restoredFrom: input.version,
      unchanged: r.unchanged,
      added: r.added,
      changed: r.changed,
      removed: r.removed,
      renames: r.renames,
      warnings: r.warnings,
      orphaned: r.orphaned,
    };
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

  /** Store a new version (the tree is already valid), record aliases, end the claim, follow comment threads, broadcast. Every version is kept. */
  private commit(
    next: CadDoc,
    opts: { summary: string; by: string; renames?: Record<string, string>; keepClaim?: boolean; restoredFrom?: number; restoring?: boolean },
  ): CommitResult {
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
      return {
        version: cur, tree: prev, added: [], changed: [], removed: [], renames: {}, unchanged: true,
        warnings: ["Nothing changed: the tree is the same as v" + cur + "."], orphaned: [], openComments: this.openCount(),
      };
    }

    const before = this.commentsReady ? this.targets() : null;
    const version = cur + 1;
    // live ids shadow aliases: reusing a removed or renamed-away id repoints its old links
    const renamedTo = new Set(Object.values(renames));
    for (const id of d.added) {
      const a = this.sql.exec<AliasRow>("SELECT * FROM aliases WHERE old_id = ?", id).toArray()[0];
      if (!a) continue;
      this.sql.exec("DELETE FROM aliases WHERE old_id = ?", id);
      if (!renamedTo.has(id) && !opts.restoring) {
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
    const detail: VersionDetail = {
      added: d.added.filter((id) => !renamedTo.has(id)),
      changed: d.changed,
      removed,
      renames,
      restoredFrom: opts.restoredFrom ?? null,
    };
    this.sql.exec(
      "INSERT INTO versions (version, tree, summary, changed, by, created_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      version, canonical(tree), opts.summary.slice(0, 200), JSON.stringify(changed), opts.by, now, JSON.stringify(detail),
    );
    this.setMeta("version", String(version));
    this.setMeta("updated_at", String(now));
    this.cur = { version, doc: tree, ids: new Set(allIds(tree)) };
    this.broadcast({ type: "tree", version, tree, summary: opts.summary, changed, by: opts.by, renames, restoredFrom: opts.restoredFrom ?? null });

    const orphaned: OrphanedComment[] = [];
    if (before) {
      const after = this.targets();
      const moved: Record<string, RefTarget> = {};
      const open = new Set(
        this.sql.exec<{ id: string }>("SELECT id FROM threads WHERE status = 'open'").toArray().map((r) => r.id),
      );
      for (const [id, t] of after) {
        const b = before.get(id);
        if (!b || (b.status === t.status && b.ref === t.ref)) continue;
        moved[id] = t;
        if (open.has(id) && (b.status === "ok" || b.status === "renamed") && (t.status === "removed" || t.status === "unknown")) {
          const first = this.sql.exec<{ body: string }>("SELECT body FROM comments WHERE thread_id = ? ORDER BY created_at ASC LIMIT 1", id).toArray()[0];
          orphaned.push({ threadId: id, ref: b.ref!, excerpt: excerpt(first?.body ?? "", 100) });
        }
      }
      if (Object.keys(moved).length) this.broadcast({ type: "thread-targets", version, targets: moved });
    }
    finish();
    return { version, tree, added: d.added, changed: d.changed, removed, renames, warnings, unchanged: false, orphaned, openComments: this.openCount() };
  }

  // ---------- comments ----------

  private ensureComments() {
    if (this.commentsReady) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        ref TEXT,
        point TEXT,
        normal TEXT,
        camera TEXT,
        version INTEGER NOT NULL,
        facts TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        resolved_by TEXT,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS threads_by_status ON threads (status, created_at);
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_key TEXT,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        edited_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS comments_by_thread ON comments (thread_id, created_at);
    `);
    this.commentsReady = true;
  }

  private openCount(): number {
    if (!this.commentsReady) return 0;
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM threads WHERE status = 'open'").toArray()[0].n;
  }

  /** What a pinned ref points at in the current tree, following renames. */
  private targetOf(ref: string | null, aliases?: Map<string, AliasRow>): RefTarget {
    if (ref === null) return { status: "ok", ref: null };
    const r = parseRef(ref);
    if (!r) return { status: "unknown", ref: null, message: `"${ref}" is not a ref` };
    const { doc, ids } = this.current();
    if (ids.has(r.id)) {
      const problem = refProblem(doc, ref);
      return problem ? { status: "unknown", ref, message: problem } : { status: "ok", ref };
    }
    const a = aliases ? aliases.get(r.id) : this.sql.exec<AliasRow>("SELECT * FROM aliases WHERE old_id = ?", r.id).toArray()[0];
    if (a?.new_id) {
      const now = formatRef(a.new_id, r.instance, r.role);
      const problem = refProblem(doc, now);
      return problem ? { status: "unknown", ref: now, since: a.version, message: problem } : { status: "renamed", ref: now, since: a.version };
    }
    return a ? { status: "removed", ref: null, since: a.version } : { status: "removed", ref: null };
  }

  /** Every thread's target, by thread id. */
  private targets(): Map<string, RefTarget> {
    const aliases = new Map(this.sql.exec<AliasRow>("SELECT * FROM aliases").toArray().map((a) => [a.old_id, a]));
    const out = new Map<string, RefTarget>();
    for (const r of this.sql.exec<{ id: string; ref: string | null }>("SELECT id, ref FROM threads").toArray()) out.set(r.id, this.targetOf(r.ref, aliases));
    return out;
  }

  private toThread(r: ThreadRow, comments: CommentRow[], aliases?: Map<string, AliasRow>): Thread {
    return {
      id: r.id,
      anchor: {
        ref: r.ref,
        point: r.point ? (JSON.parse(r.point) as Vec3) : null,
        normal: r.normal ? (JSON.parse(r.normal) as Vec3) : null,
        camera: r.camera ? (JSON.parse(r.camera) as CameraPose) : null,
        version: r.version,
        facts: r.facts ? (JSON.parse(r.facts) as FactsSnapshot) : null,
      },
      target: this.targetOf(r.ref, aliases),
      status: r.status,
      resolvedBy: r.resolved_by,
      resolvedAt: r.resolved_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      comments: comments.map((c) => ({
        id: c.id,
        authorId: c.author_id,
        authorName: c.author_name,
        authorKind: c.author_kind,
        body: c.body,
        createdAt: c.created_at,
        editedAt: c.edited_at,
      })),
    };
  }

  private thread(threadId: string): Thread {
    const r = this.commentsReady ? this.sql.exec<ThreadRow>("SELECT * FROM threads WHERE id = ?", threadId).toArray()[0] : undefined;
    if (!r) throw new ToolError(`Comment ${threadId} not found in this model.`);
    return this.toThread(r, this.sql.exec<CommentRow>("SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at ASC", threadId).toArray());
  }

  /** Threads oldest first. Reads never create the comment tables. */
  async listThreads(filter: { status?: ThreadStatus } = {}): Promise<Thread[]> {
    this.requireModel();
    if (!this.commentsReady) return [];
    const rows = filter.status
      ? this.sql.exec<ThreadRow>("SELECT * FROM threads WHERE status = ? ORDER BY created_at ASC", filter.status).toArray()
      : this.sql.exec<ThreadRow>("SELECT * FROM threads ORDER BY created_at ASC").toArray();
    if (!rows.length) return [];
    const byThread = new Map<string, CommentRow[]>();
    for (const c of this.sql.exec<CommentRow>("SELECT * FROM comments ORDER BY created_at ASC").toArray()) {
      if (!byThread.has(c.thread_id)) byThread.set(c.thread_id, []);
      byThread.get(c.thread_id)!.push(c);
    }
    const aliases = new Map(this.sql.exec<AliasRow>("SELECT * FROM aliases").toArray().map((a) => [a.old_id, a]));
    return rows.map((r) => this.toThread(r, byThread.get(r.id) ?? [], aliases));
  }

  async getThread(threadId: string): Promise<Thread> {
    this.requireModel();
    return this.thread(threadId);
  }

  private async insertComment(threadId: string, body: string, author: CommentAuthor, now: number) {
    const key = author.kind === "person" && author.secret ? await keyHash(author.secret) : null;
    this.sql.exec(
      "INSERT INTO comments (id, thread_id, author_id, author_name, author_kind, author_key, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      newCommentId(), threadId, author.id, author.name, author.kind, key, body, now,
    );
  }

  /** Start a thread pinned to a ref as it was at `version` (null ref: the whole model). Facts are measured by the Worker. */
  async createThread(input: {
    ref?: string | null;
    point?: unknown;
    normal?: unknown;
    camera?: unknown;
    version: number;
    facts: FactsSnapshot | null;
    body: string;
    author: CommentAuthor;
  }): Promise<Thread> {
    this.requireModel();
    const body = cleanBody(input.body);
    const author = cleanAuthor(input.author);
    const ref = input.ref ? String(input.ref).trim() : null;
    const at = this.requireTree(input.version).tree;
    if (ref) {
      const problem = refProblem(at, ref);
      if (problem) throw new ToolError(`Can't pin a comment to "${ref}": ${problem} in v${input.version}.`);
    }
    this.ensureComments();
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM threads").toArray()[0].n;
    if (count >= MAX_THREADS) throw new ToolError(`This model has reached ${MAX_THREADS} comment threads. Delete some resolved ones first.`);
    const point = cleanPoint(input.point), normal = cleanNormal(input.normal), camera = cleanCamera(input.camera);
    const now = Date.now();
    const id = newThreadId();
    this.sql.exec(
      "INSERT INTO threads (id, ref, point, normal, camera, version, facts, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)",
      id, ref, point && JSON.stringify(point), normal && JSON.stringify(normal), camera && JSON.stringify(camera),
      input.version, ref && input.facts ? JSON.stringify(input.facts) : null, now, now,
    );
    await this.insertComment(id, body, author, now);
    const thread = this.thread(id);
    this.broadcast({ type: "thread", thread });
    return thread;
  }

  /** Reply to a thread. A reply on a resolved thread reopens it: someone still has something to say. */
  async reply(threadId: string, rawBody: string, rawAuthor: CommentAuthor): Promise<Thread> {
    this.requireModel();
    const body = cleanBody(rawBody);
    const author = cleanAuthor(rawAuthor);
    const t = this.thread(threadId);
    if (t.comments.length >= MAX_COMMENTS_PER_THREAD) throw new ToolError(`This thread has reached ${MAX_COMMENTS_PER_THREAD} replies. Start a new one.`);
    const now = Date.now();
    await this.insertComment(threadId, body, author, now);
    this.sql.exec("UPDATE threads SET status = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = ? WHERE id = ?", now, threadId);
    const thread = this.thread(threadId);
    this.broadcast({ type: "thread", thread });
    return thread;
  }

  /** Resolve or reopen. Anyone with the link can, as in other design tools. */
  async setThreadStatus(threadId: string, status: ThreadStatus, byName: string): Promise<Thread> {
    this.requireModel();
    this.thread(threadId);
    const now = Date.now();
    const by = cleanName(byName) || "Someone";
    if (status === "resolved") {
      this.sql.exec("UPDATE threads SET status = 'resolved', resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?", by, now, now, threadId);
    } else {
      this.sql.exec("UPDATE threads SET status = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = ? WHERE id = ?", now, threadId);
    }
    const thread = this.thread(threadId);
    this.broadcast({ type: "thread", thread });
    return thread;
  }

  private async ownComment(threadId: string, commentId: string, secret: string | undefined) {
    this.thread(threadId);
    const c = this.sql.exec<CommentRow>("SELECT * FROM comments WHERE id = ? AND thread_id = ?", commentId, threadId).toArray()[0];
    if (!c) throw new ToolError(`Comment ${commentId} not found in this thread.`);
    if (!c.author_key || !secret || c.author_key !== (await keyHash(secret))) {
      throw new ToolError("That comment was written in another browser. Only its author can change it.");
    }
    return c;
  }

  async editComment(threadId: string, commentId: string, rawBody: string, secret?: string): Promise<Thread> {
    this.requireModel();
    const body = cleanBody(rawBody);
    await this.ownComment(threadId, commentId, secret);
    const now = Date.now();
    this.sql.exec("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?", body, now, commentId);
    this.sql.exec("UPDATE threads SET updated_at = ? WHERE id = ?", now, threadId);
    const thread = this.thread(threadId);
    this.broadcast({ type: "thread", thread });
    return thread;
  }

  /** Delete your own comment. The thread goes with its last comment. */
  async deleteComment(threadId: string, commentId: string, secret?: string): Promise<Thread | null> {
    this.requireModel();
    await this.ownComment(threadId, commentId, secret);
    this.sql.exec("DELETE FROM comments WHERE id = ?", commentId);
    const left = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM comments WHERE thread_id = ?", threadId).toArray()[0].n;
    if (!left) {
      this.sql.exec("DELETE FROM threads WHERE id = ?", threadId);
      this.broadcast({ type: "thread-deleted", id: threadId });
      return null;
    }
    this.sql.exec("UPDATE threads SET updated_at = ? WHERE id = ?", Date.now(), threadId);
    const thread = this.thread(threadId);
    this.broadcast({ type: "thread", thread });
    return thread;
  }

  // ---------- notes ----------

  private ensureNotes() {
    if (this.notesReady) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY CHECK (id = 'model'),
        body TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_by_kind TEXT NOT NULL
      );
    `);
    this.notesReady = true;
  }

  private notes(): ModelNotes {
    const r = this.notesReady ? this.sql.exec<NotesRow>("SELECT * FROM notes WHERE id = 'model'").toArray()[0] : undefined;
    return r
      ? { body: r.body, version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by, updatedByKind: r.updated_by_kind }
      : { body: "", version: 0, updatedAt: null, updatedBy: null, updatedByKind: null };
  }

  /** The model's notes; version 0 and an empty body when there are none. Reads never create the table. */
  async getNotes(): Promise<ModelNotes> {
    this.requireModel();
    return this.notes();
  }

  /** Replace the model's notes. No claim needed: notes are shared, and base_version keeps one editor from overwriting another. */
  async writeNotes(input: { body: string; baseVersion?: number; by: { name: string; kind: AuthorKind } }): Promise<ModelNotes> {
    this.requireModel();
    const body = (input.body ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    if (body.length > MAX_NOTES) throw new ToolError(`Notes too large: ${body.length} characters (limit ${MAX_NOTES}).`);
    const cur = this.notes();
    if (input.baseVersion !== undefined && input.baseVersion !== cur.version) {
      throw new ToolError(
        `Version conflict: the notes are at v${cur.version}${cur.updatedBy ? ` (last edited by ${cur.updatedBy})` : ""}, you edited v${input.baseVersion}. Read them again and reapply your change.`,
      );
    }
    if (body === cur.body) return cur;
    this.ensureNotes();
    const by = cleanName(input.by.name) || "Someone";
    const kind: AuthorKind = input.by.kind === "agent" ? "agent" : "person";
    this.sql.exec(
      `INSERT INTO notes (id, body, version, updated_at, updated_by, updated_by_kind) VALUES ('model', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET body = excluded.body, version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by, updated_by_kind = excluded.updated_by_kind`,
      body, cur.version + 1, Date.now(), by, kind,
    );
    const notes = this.notes();
    this.broadcast({ type: "notes", notes });
    return notes;
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
