// DXF (R12, the version every laser, waterjet and router tool reads) from 2D outlines in mm.
// Environment-neutral: the outlines come from the exact solid in src/brep.ts.

export type P2 = [number, number];

export type DxfEntity =
  | { kind: "line"; a: P2; b: P2 }
  | { kind: "circle"; c: P2; r: number }
  /** Counter-clockwise from `start` to `end`, degrees, as DXF draws it. */
  | { kind: "arc"; c: P2; r: number; start: number; end: number }
  | { kind: "poly"; pts: P2[]; closed: boolean };

export interface DxfLayer {
  name: string;
  entities: DxfEntity[];
}

const num = (x: number) => {
  const s = (Math.abs(x) < 5e-7 ? 0 : x).toFixed(6).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

/** DXF layer names: letters, digits, - and _ only. */
export const layerName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 31) || "0";

export function bounds(entities: DxfEntity[]): { min: P2; max: P2 } {
  const min: P2 = [Infinity, Infinity], max: P2 = [-Infinity, -Infinity];
  const add = (p: P2) => { min[0] = Math.min(min[0], p[0]); min[1] = Math.min(min[1], p[1]); max[0] = Math.max(max[0], p[0]); max[1] = Math.max(max[1], p[1]); };
  for (const e of entities) {
    if (e.kind === "line") add(e.a), add(e.b);
    else if (e.kind === "poly") e.pts.forEach(add);
    else if (e.kind === "circle") add([e.c[0] - e.r, e.c[1] - e.r]), add([e.c[0] + e.r, e.c[1] + e.r]);
    else {
      // An arc's box: its ends plus any axis extremes it sweeps through.
      const pt = (deg: number): P2 => [e.c[0] + e.r * Math.cos((deg * Math.PI) / 180), e.c[1] + e.r * Math.sin((deg * Math.PI) / 180)];
      add(pt(e.start)); add(pt(e.end));
      const span = (((e.end - e.start) % 360) + 360) % 360 || 360;
      for (let q = Math.ceil(e.start / 90) * 90; q < e.start + span; q += 90) add(pt(q));
    }
  }
  return { min, max };
}

export function moveEntity(e: DxfEntity, dx: number, dy: number): DxfEntity {
  const m = (p: P2): P2 => [p[0] + dx, p[1] + dy];
  if (e.kind === "line") return { ...e, a: m(e.a), b: m(e.b) };
  if (e.kind === "poly") return { ...e, pts: e.pts.map(m) };
  return { ...e, c: m(e.c) };
}

export function dxfOf(layers: DxfLayer[]): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === "number" ? num(value) : value);
  const all = layers.flatMap((l) => l.entities);
  const b = all.length ? bounds(all) : { min: [0, 0] as P2, max: [0, 0] as P2 };

  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$ACADVER"); g(1, "AC1009");
  g(9, "$INSUNITS"); g(70, 4); // millimetres
  g(9, "$MEASUREMENT"); g(70, 1); // metric
  g(9, "$EXTMIN"); g(10, b.min[0]); g(20, b.min[1]); g(30, 0);
  g(9, "$EXTMAX"); g(10, b.max[0]); g(20, b.max[1]); g(30, 0);
  g(0, "ENDSEC");

  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LTYPE"); g(70, 1);
  g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, 0); g(3, "Solid line"); g(72, 65); g(73, 0); g(40, 0);
  g(0, "ENDTAB");
  g(0, "TABLE"); g(2, "LAYER"); g(70, layers.length);
  for (const l of layers) { g(0, "LAYER"); g(2, l.name); g(70, 0); g(62, 7); g(6, "CONTINUOUS"); }
  g(0, "ENDTAB");
  g(0, "ENDSEC");

  g(0, "SECTION"); g(2, "ENTITIES");
  for (const l of layers) {
    for (const e of l.entities) {
      if (e.kind === "line") {
        g(0, "LINE"); g(8, l.name); g(10, e.a[0]); g(20, e.a[1]); g(30, 0); g(11, e.b[0]); g(21, e.b[1]); g(31, 0);
      } else if (e.kind === "circle") {
        g(0, "CIRCLE"); g(8, l.name); g(10, e.c[0]); g(20, e.c[1]); g(30, 0); g(40, e.r);
      } else if (e.kind === "arc") {
        g(0, "ARC"); g(8, l.name); g(10, e.c[0]); g(20, e.c[1]); g(30, 0); g(40, e.r); g(50, e.start); g(51, e.end);
      } else {
        g(0, "POLYLINE"); g(8, l.name); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, e.closed ? 1 : 0);
        for (const p of e.pts) { g(0, "VERTEX"); g(8, l.name); g(10, p[0]); g(20, p[1]); g(30, 0); }
        g(0, "SEQEND"); g(8, l.name);
      }
    }
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return out.join("\r\n") + "\r\n";
}

/** Lays outlines out left to right with a gap, each moved so its lower-left corner sits on the X axis. */
export function layoutOutlines(outlines: { name: string; entities: DxfEntity[] }[], gap = 10): DxfLayer[] {
  let x = 0;
  const used = new Set<string>();
  return outlines.map((o) => {
    const b = bounds(o.entities);
    const entities = o.entities.map((e) => moveEntity(e, x - b.min[0], -b.min[1]));
    x += b.max[0] - b.min[0] + gap;
    let name = layerName(o.name), k = 2;
    while (used.has(name)) name = `${layerName(o.name)}_${k++}`;
    used.add(name);
    return { name, entities };
  });
}
