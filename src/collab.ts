// Shapes shared by the Worker, the CadModel Durable Object and the viewer: history, comments, notes and
// WebSocket messages. Environment-neutral (types only, plus constants): the viewer imports this file.
import type { CadDoc, Vec3 } from "./schema.ts";

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

// ---------- history ----------

export interface VersionDetail {
  /** Part and feature ids. */
  added: string[];
  /** Modified ids only. */
  changed: string[];
  /** Removed and not renamed. */
  removed: string[];
  /** Old id -> new id in this version. */
  renames: Record<string, string>;
  restoredFrom: number | null;
}

export interface VersionInfo {
  version: number;
  summary: string;
  /** "agent:<client>" | "person" | "person:<name>" */
  by: string;
  /** ms epoch */
  at: number;
  /** Every id added, changed or removed. */
  changed: string[];
  /** null for versions saved before details were recorded. */
  detail: VersionDetail | null;
}

export interface VersionPage {
  /** Newest first. */
  versions: VersionInfo[];
  current: number;
  /** Oldest kept version (every version is kept; older models may have pruned ones). */
  oldest: number;
  /** Pass as ?before= for the next, older page; null when there are no more. */
  next: number | null;
}

export interface VersionTree extends VersionInfo {
  tree: CadDoc;
}

/** Path relative to the item: "diameter", "size", "pattern.grid.count", "at"; "part" when moved between parts.
 *  `from` absent = prop added; `to` absent = prop removed. */
export interface PropertyChange {
  path: string;
  from?: unknown;
  to?: unknown;
}

export interface ItemDiff {
  /** Id in the `to` tree (removed: id in `from`). */
  id: string;
  /** Id in the `from` tree when renamed. */
  was?: string;
  kind: "part" | "feature";
  /** Owning part in `to` (removed: in `from`); for parts, itself. */
  part: string;
  /** "renamed" may also carry props. */
  change: "added" | "removed" | "changed" | "renamed";
  /** Empty for added/removed. */
  props: PropertyChange[];
  /** Full JSON for added (to) / removed (from). */
  value?: unknown;
}

export interface VersionDiff {
  from: number;
  to: number;
  /** from-id -> to-id, composed across the range. */
  renames: Record<string, string>;
  /** false when a version in the range has no detail: renames then show as removed + added. */
  renamesComplete: boolean;
  /** Tree order of `to`, then removed items. */
  changes: ItemDiff[];
  /** Part ids whose surviving features changed relative order. */
  reordered: string[];
}

// ---------- facts snapshots (comment anchors) ----------

export interface FactsSnapshot {
  kind: "part" | "feature" | "face";
  source: "kernel" | "none";
  presence?: "present" | "consumed" | "error";
  // face
  surface?: string;
  area?: number;
  centroid?: Vec3;
  normal?: Vec3 | null;
  planeOffset?: number;
  // feature
  type?: string;
  part?: string;
  op?: string;
  instances?: number;
  /** e.g. "5/6" */
  facesPresent?: string;
  // part
  volume?: number;
  surfaceArea?: number;
  genus?: number;
  // all, when built
  bbox?: { min: Vec3; max: Vec3 } | null;
  size?: Vec3;
}

export interface FactChange {
  field: string;
  then: unknown;
  now: unknown;
}

export interface RestoreResult {
  version: number;
  tree: CadDoc;
  restoredFrom: number;
  unchanged: boolean;
  added: string[];
  changed: string[];
  removed: string[];
  renames: Record<string, string>;
  warnings: string[];
  orphaned: OrphanedComment[];
}

// ---------- comments ----------

export type AuthorKind = "person" | "agent";
export type ThreadStatus = "open" | "resolved";

/** What the viewer sends; the secret is never returned. */
export interface CommentAuthorIn {
  id: string;
  name: string;
  secret: string;
}

/** Perspective camera, mm, Z-up. */
export interface CameraPose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  fov: number;
}

export interface CommentAnchor {
  /** As pinned: part | feature | feature:n | feature.role | feature:n.role; null = whole model. */
  ref: string | null;
  /** World mm at `version`. */
  point: Vec3 | null;
  normal: Vec3 | null;
  camera: CameraPose | null;
  /** Model version the commenter was looking at. */
  version: number;
  /** Facts of `ref` at `version`, computed in the Worker. null for whole-model threads. */
  facts: FactsSnapshot | null;
}

export type RefTargetStatus = "ok" | "renamed" | "removed" | "unknown";

export interface RefTarget {
  /** Whole-model thread: "ok" with ref null. */
  status: RefTargetStatus;
  /** Current ref: same as the anchor (ok), the new form (renamed), null (removed). */
  ref: string | null;
  /** Version of the rename or removal. */
  since?: number;
  /** unknown only, e.g. "mount-holes has 2 instances now". */
  message?: string;
}

export interface ThreadComment {
  id: string;
  authorId: string;
  authorName: string;
  authorKind: AuthorKind;
  body: string;
  createdAt: number;
  editedAt: number | null;
}

export interface Thread {
  id: string;
  anchor: CommentAnchor;
  target: RefTarget;
  status: ThreadStatus;
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Oldest first; [0] is the opener. */
  comments: ThreadComment[];
}

export interface OrphanedComment {
  threadId: string;
  ref: string;
  excerpt: string;
}

// ---------- notes ----------

/** version 0 = no notes yet. */
export interface ModelNotes {
  body: string;
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
  updatedByKind: AuthorKind | null;
}

// ---------- WebSocket (server -> viewer) ----------

export type ServerMessage =
  | { type: "tree"; version: number; tree: CadDoc; summary: string; changed: string[]; by: string; renames: Record<string, string>; restoredFrom: number | null }
  | { type: "claim"; status: ClaimStatus; task: string | null; scope: string[]; lockExpiresAt: number | null }
  | { type: "model"; name: string }
  | ({ type: "model-deleted" } & TrashedModel)
  | { type: "model-restored" }
  | { type: "thread"; thread: Thread }
  | { type: "thread-deleted"; id: string }
  /** Only threads whose target changed. */
  | { type: "thread-targets"; version: number; targets: Record<string, RefTarget> }
  | { type: "notes"; notes: ModelNotes };

export const LIMITS_COLLAB = { commentChars: 4000, notesChars: 20000, repliesPerThread: 200, threads: 2000 };
