// The seam between the viewer (web/viewer.ts) and the modules built on it (comments, history, compare, notes).
// The viewer implements ViewerHost and hands it to initComments/initHistory; modules never import viewer.ts.
import type * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CadDoc } from "../src/schema.ts";
import type { CameraPose, ServerMessage } from "../src/collab.ts";

/** A ray hit on the model: the face ref, the world point (mm) and the triangle's world normal. */
export interface Hit {
  ref: string;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

/** One exclusive canvas tool at a time ("comment", "compare"). Setting another calls this one's exit(). */
export interface Tool {
  name: string;
  /** A click (not a drag) on the canvas. Return true to consume it: the selection doesn't change. */
  click?(hit: Hit | null, e: PointerEvent): boolean;
  /** false = no hover highlight or tooltip while the tool is on. */
  hover?: boolean;
  /** Canvas cursor while the tool is on. */
  cursor?: string;
  /** Another tool took over, or setTool(null). setTool calls made from here are ignored. */
  exit(): void;
}

/** A button in the selection bar, before Copy link. html() returns "" to hide it; data-act="<act>" runs run(). */
export interface SelAction {
  act: string;
  html(): string;
  run(): void;
}

/** One split-view pass: 0 = old (left / top), 1 = new (right / bottom). Toggle what's visible for that half. */
export interface Split {
  dir: "h" | "v";
  pass(i: 0 | 1): void;
}

export type HostEvent = "selection" | "build" | "tree" | "theme" | "load" | "render" | "claim" | "resize";

export interface ViewerHost {
  modelId: string;
  /** Latest from the server (not necessarily what's on screen). */
  state(): { name: string; version: number } | null;
  /** The version on screen. */
  shownVersion(): number;
  /** Viewing a past version (live updates don't replace it), or null. */
  pinned(): number | null;
  /** The tree on screen. */
  doc(): CadDoc;
  meshes(): THREE.Mesh[];
  claimActive(): boolean;

  // refs: keys are what links say (part, feature, feature:n, feature.role, feature:n.role)
  /** A key to the face refs it covers on screen. */
  expand(key: string): string[];
  exists(key: string): boolean;
  /** One level up: face → instance → feature → part; null at a part. */
  parent(key: string): string | null;
  /** The key if it exists, else its nearest existing ancestor, else null. */
  resolveKey(key: string): string | null;
  /** A face ref's triangles: non-indexed world positions, vertex range [start, start + count). */
  refRange(ref: string): { positions: Float32Array; start: number; count: number } | null;

  selection(): string[];
  setSelection(keys: string[], opts?: { fit?: boolean }): void;
  setHover(key: string | null): void;
  /** Client (CSS px) coordinates to a hit; null over empty space or while bodies are hidden. */
  pickHit(x: number, y: number): Hit | null;
  /** The hit of the last canvas click or tap (phones anchor comments with it). */
  lastHit(): Hit | null;

  three: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera | THREE.OrthographicCamera; controls: OrbitControls; canvas: HTMLCanvasElement };
  cameraPose(): CameraPose;
  /** Fly the camera to a pose's position and target (e.g. the one a comment was made from); up stays +Z. */
  setCameraPose(pose: CameraPose): void;
  fitRefs(refs: string[]): void;
  fitBox(box: THREE.Box3, dir?: THREE.Vector3): void;
  boxOfRefs(refs: string[]): THREE.Box3;
  requestRender(): void;
  palette(): { bg: number; body: number; edge: number; accent: number; flash: number };

  setTool(t: Tool | null): void;
  tool(): Tool | null;
  /** Room a right-side panel covers (px, 0 = none): the model centers in what's left. Sets --right-inset on body. */
  setRightInset(px: number): void;
  insets(): { left: number; right: number };
  /** Two viewports inside the visible area, or null for one. */
  setSplit(s: Split | null): void;
  /** Hide the model's own bodies (compare draws its own); live updates stay hidden. */
  setBodiesHidden(on: boolean): void;
  setMeasuring(on: boolean): void;

  /** Phones: one bottom sheet at a time. Claiming closes every other open sheet with its close(). */
  claimSheet(name: string, close: () => void): void;
  releaseSheet(name: string): void;

  /** Build and show version n pinned (keeps &pin in the URL); null = back to latest. Resolves once it's on screen or failed. */
  showVersion(v: number | null): Promise<void>;
  /** Extra URL params syncUrl keeps: ?v=<shown>[&pin][&cmp=…][&c=…]#sel. "pin" is written bare. null removes. */
  setUrlParam(key: "c" | "pin" | "cmp", value: string | null): void;
  urlParam(key: "c" | "pin" | "cmp"): string | null;

  /** Unmodified keydowns (Shift allowed, not Escape), outside inputs, before the viewer's own keys. Return true = handled. */
  onKey(fn: (e: KeyboardEvent) => boolean): void;
  /** Esc after menus and popovers close, before the viewer clears the selection. Lower priority runs first; true = handled.
   *  Order: 10 comment popover, 20 compare, 30 comment mode, 40 notes/history panel, 50 pinned version. */
  onEscape(priority: number, fn: () => boolean): void;
  addSelAction(a: SelAction): void;
  /** The selection bar's hint while nothing is selected (inner html of .hint); return null for the viewer's own. */
  setSelHint(fn: (() => string | null) | null): void;
  renderSelBar(): void;
  toast(html: string, ms?: number): void;

  /** "render" fires after every rendered frame (pins reproject there; don't requestRender from it every frame). */
  on(ev: HostEvent, fn: () => void): void;
  /** Every WebSocket message, after the viewer handled its own (tree messages too). */
  onMessage(fn: (msg: ServerMessage) => boolean | void): void;
}
