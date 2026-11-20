import type { Env } from "./index.ts";

/**
 * Product analytics in Workers Analytics Engine (dataset infinite_cad_events).
 * Every event uses the same columns so one query shape fits all of them:
 *
 *   blob1 event    "tool" | "connect" | "session" | "create" | "trash"
 *   blob2 name     tool name · MCP client name · "viewer" · "web"
 *                  · trash "model-delete" | "model-restore" (people in the viewer)
 *   blob3 model    hashed model id ("" when there is none)
 *   blob4 actor    MCP client (User-Agent product) · anonymous viewer id (sessions)
 *   blob5 detail   tool outcome/variant · device class
 *   blob6 country
 *   double1 ms     tool latency · session length
 *   double2        tree bytes written · ref count resolved · engaged ms
 *   double3        warnings (build errors, unknown refs)
 *   index1         hashed model id, so sampling (if it ever kicks in) is per model
 *
 * Model ids are capability URLs (anyone with one can edit), so they are hashed
 * before they're written. Trees, feature ids and refs are never recorded: ids are
 * descriptive and can say what someone is building.
 */
export interface AnalyticsEvent {
  event: "tool" | "connect" | "session" | "create" | "trash";
  name: string;
  modelId?: string;
  actor?: string;
  detail?: string;
  country?: string;
  ms?: number;
  size?: number;
  warnings?: number;
}

const hashes = new Map<string, string>();

async function hashModelId(modelId: string): Promise<string> {
  let h = hashes.get(modelId);
  if (!h) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ic:${modelId}`));
    h = [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hashes.size > 5000) hashes.clear();
    hashes.set(modelId, h);
  }
  return h;
}

/** Fire and forget. A missing binding (tests, a fork without the dataset) is a no-op. */
export async function track(env: Env, e: AnalyticsEvent): Promise<void> {
  if (!env.EVENTS) return;
  try {
    const model = e.modelId ? await hashModelId(e.modelId) : "";
    env.EVENTS.writeDataPoint({
      blobs: [e.event, e.name, model, (e.actor ?? "").slice(0, 96), e.detail ?? "", e.country ?? ""],
      doubles: [e.ms ?? 0, e.size ?? 0, e.warnings ?? 0],
      indexes: [model],
    });
  } catch {}
}

/** "claude-code/1.2.3 (darwin)" → "claude-code". Good enough to tell clients apart in a stateless server. */
export const clientFromUserAgent = (ua: string | null) =>
  (ua ?? "").trim().split(/[\s/]/)[0].toLowerCase().slice(0, 48) || "unknown";

export const countryOf = (request: Request) => (request.cf?.country as string | undefined) ?? "";
