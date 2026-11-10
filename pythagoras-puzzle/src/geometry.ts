export type Pt = [number, number];

export interface PieceDef { start: Pt[]; target: Pt[]; color: string }
export interface LevelDef {
  title: string;
  subtitle: string;
  concept: string;
  a: number;
  b: number;
  small: Pt[];
  big: Pt[];
  hyp: Pt[];
  tri: Pt[];
  pieces: PieceDef[];
}

export const area = (p: Pt[]): number => {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
};

export const centroid = (p: Pt[]): Pt => {
  const A = area(p);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  return [cx / (6 * A), cy / (6 * A)];
};

export const rotPt = ([x, y]: Pt, deg: number): Pt => {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c * x - s * y, s * x + c * y];
};

export const norm360 = (d: number): number => ((d % 360) + 360) % 360;
export const angDiff = (a: number, b: number): number => {
  const d = norm360(a - b);
  return d > 180 ? 360 - d : d;
};

const ang = (a: Pt, b: Pt): number => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;

/**
 * All rotations θ (deg) for which `local` (vertices relative to its centroid),
 * rotated by θ and moved to `slotCentroid`, coincides with `slot`.
 */
export function matchRotations(local: Pt[], slot: Pt[], slotCentroid: Pt, tol = 1e-3): number[] {
  const n = local.length;
  if (slot.length !== n) return [];
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const th = ang(slot[k], slot[(k + 1) % n]) - ang(local[0], local[1]);
    let ok = true;
    for (let m = 0; m < n && ok; m++) {
      const r = rotPt(local[m], th);
      const q = slot[(m + k) % n];
      if (Math.hypot(r[0] + slotCentroid[0] - q[0], r[1] + slotCentroid[1] - q[1]) > tol) ok = false;
    }
    if (ok) out.push(norm360(th));
  }
  return out;
}

export const pointsAttr = (p: Pt[], s = 1): string => p.map(([x, y]) => `${(x * s).toFixed(3)},${(y * s).toFixed(3)}`).join(' ');

export function pointInPoly([x, y]: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
