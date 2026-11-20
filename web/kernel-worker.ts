// Builds feature trees off the main thread with the same kernel the server uses.
// In: { seq, doc }. Out: { seq, ok, issues, errors, bodies, ms } with mesh buffers transferred,
// or { seq, fatal } when the kernel itself couldn't load or threw.
import Module from "manifold-3d";
import { build, type BodyMesh } from "../src/geometry.ts";
import type { CadDoc, Issue } from "../src/schema.ts";

export type BuildRequest = { seq: number; doc: CadDoc };
export type BuildReply =
  | { seq: number; ok: boolean; issues: Issue[]; errors: { featureId: string; message: string }[]; bodies: BodyMesh[]; ms: number }
  | { seq: number; fatal: string };

const ready = Module({ locateFile: () => "/js/manifold.wasm" }).then((w) => {
  w.setup();
  return w;
});

self.onmessage = async (e: MessageEvent<BuildRequest>) => {
  const { seq, doc } = e.data;
  try {
    const w = await ready;
    const res = build(w, doc);
    const reply: BuildReply = { seq, ok: res.ok, issues: res.issues, errors: res.errors, bodies: res.bodies, ms: res.ms };
    const transfer = res.bodies.flatMap((b) => [b.positions.buffer, b.indices.buffer, b.triRef.buffer, b.backside.buffer]) as ArrayBuffer[];
    self.postMessage(reply, { transfer });
  } catch (err) {
    self.postMessage({ seq, fatal: err instanceof Error ? err.message : String(err) } satisfies BuildReply);
  }
};
