const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Random id from a-z0-9. Model ids are long enough to act as capability URLs pre-auth. */
export function randomId(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const newModelId = () => randomId(14);
export const newLockToken = () => randomId(20);
export const newThreadId = () => randomId(10);
export const newCommentId = () => randomId(10);

export interface ParsedLink {
  modelId: string;
  /** Refs from the #fragment, as written: part | feature | feature:n | feature.role | feature:n.role. */
  refs: string[];
  /** ?v=<n>: the version the person was looking at when they copied the link. */
  version?: number;
  /** ?c=<thread>: a comment thread. */
  commentId?: string;
}

/**
 * Accepts any of:
 *   https://host/m/<model>
 *   https://host/m/<model>?v=<n>#<ref>,<ref>,…
 *   https://host/m/<model>?c=<thread>[#<ref>]
 *   <model>  |  <model>#<ref>,…
 */
export function parseLink(input: string): ParsedLink | null {
  const s = input.trim();
  const m = s.match(/(?:^|\/m\/)([a-z0-9]{14})\/?(\?[^#\s]*)?(?:#(\S*))?$/);
  if (!m) return null;
  const v = m[2]?.match(/[?&]v=(\d+)/)?.[1];
  const c = m[2]?.match(/[?&]c=([a-z0-9]{6,32})/)?.[1];
  let frag = m[3] ?? "";
  try {
    frag = decodeURIComponent(frag);
  } catch {}
  const refs = frag.split(",").map((r) => r.trim()).filter(Boolean);
  return { modelId: m[1], refs, ...(v ? { version: Number(v) } : {}), ...(c ? { commentId: c } : {}) };
}

export const links = (origin: string) => ({
  model: (modelId: string) => `${origin}/m/${modelId}`,
  refs: (modelId: string, refs: string[], version?: number) =>
    `${origin}/m/${modelId}${version ? `?v=${version}` : ""}${refs.length ? `#${refs.join(",")}` : ""}`,
  comment: (modelId: string, threadId: string) => `${origin}/m/${modelId}?c=${threadId}`,
  mcp: () => `${origin}/mcp`,
});
