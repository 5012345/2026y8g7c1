import { LevelDef, Pt, angDiff, centroid, matchRotations, norm360, pointInPoly, pointsAttr } from './geometry';

const S = 100; // hypotenuse length in SVG units
const NS = 'http://www.w3.org/2000/svg';
const POS_TOL = 0.06 * S;
const ROT_TOL = 14;
const ROT_SNAP = 9;
const MAG_DIST = 6; // magnet reach (hypotenuse = 100)
const MAG_ANG = 8; // max angle difference (deg) for edge magnet

interface Match { slot: number; th: number }
interface Piece {
  idx: number;
  color: string;
  local: Pt[];
  home: Pt;
  x: number;
  y: number;
  rot: number;
  placed: boolean;
  matches: Match[];
  g: SVGGElement;
  inner: SVGGElement;
  poly: SVGPolygonElement;
  radius: number;
}
interface Slot { poly: Pt[]; c: Pt; filled: boolean }

export interface BoardEvents {
  onPlace?: (placed: number, total: number) => void;
  onComplete?: () => void;
  onWrong?: () => void;
  onMagnet?: () => void;
  onSelect?: (selected: boolean) => void;
}

const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
};

export class PuzzleBoard {
  readonly svg: SVGSVGElement;
  private pieces: Piece[] = [];
  private slots: Slot[] = [];
  private snapAngles: number[] = [];
  private selected: Piece | null = null;
  private layers: Record<'back' | 'hint' | 'placed' | 'free' | 'over', SVGGElement>;
  private handle: SVGGElement;
  private hyp: Pt[];
  private bounds: { x0: number; y0: number; x1: number; y1: number };
  private pointers = new Map<number, Pt>();
  private mode: 'none' | 'drag' | 'rotate' | 'pinch' = 'none';
  private dragOff: Pt = [0, 0];
  private rotStart = { pointerAng: 0, rot: 0 };
  private pinchStart = { ang: 0, rot: 0, mid: [0, 0] as Pt, pos: [0, 0] as Pt };
  private hintTimer = 0;
  private knobLocal = -90; // knob angle relative to the piece's rotation
  private destroyed = false;

  constructor(container: HTMLElement, level: LevelDef, private ev: BoardEvents = {}) {
    const sc = (p: Pt[]): Pt[] => p.map(([x, y]) => [x * S, y * S] as Pt);
    const small = sc(level.small);
    const big = sc(level.big);
    this.hyp = sc(level.hyp);
    const tri = sc(level.tri);

    const all = [...small, ...big, ...this.hyp];
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const pad = 0.14 * S;
    this.bounds = { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad * 0.6 };
    const { x0, y0, x1, y1 } = this.bounds;

    this.svg = el('svg', { viewBox: `${x0} ${y0} ${x1 - x0} ${y1 - y0}`, class: 'board', preserveAspectRatio: 'xMidYMid meet' });
    const defs = el('defs', {}, this.svg);
    defs.innerHTML = `
      <pattern id="grid" width="${S / 10}" height="${S / 10}" patternUnits="userSpaceOnUse">
        <path d="M ${S / 10} 0 L 0 0 0 ${S / 10}" fill="none" stroke="var(--grid)" stroke-width="0.25"/>
      </pattern>
      <filter id="lift" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="1.6" stdDeviation="1.6" flood-color="#000" flood-opacity="0.28"/>
      </filter>`;
    el('rect', { x: x0 - 3 * S, y: y0 - 3 * S, width: x1 - x0 + 6 * S, height: y1 - y0 + 6 * S, fill: 'url(#grid)' }, this.svg);
    this.layers = {
      back: el('g', {}, this.svg),
      hint: el('g', {}, this.svg),
      placed: el('g', {}, this.svg),
      free: el('g', {}, this.svg),
      over: el('g', {}, this.svg),
    };

    // background: leg-square outlines, triangle, hypotenuse square
    el('polygon', { points: pointsAttr(small), class: 'leg-outline' }, this.layers.back);
    el('polygon', { points: pointsAttr(big), class: 'leg-outline' }, this.layers.back);
    el('polygon', { points: pointsAttr(this.hyp), class: 'hyp-square' }, this.layers.back);
    el('polygon', { points: pointsAttr(tri), class: 'triangle' }, this.layers.back);
    // right-angle marker at C (tri[2])
    const [A, B, C] = tri;
    const u = norm(sub(A, C));
    const v = norm(sub(B, C));
    const m = 2.6;
    const p1 = add(C, mul(u, m));
    const p2 = add(add(C, mul(u, m)), mul(v, m));
    const p3 = add(C, mul(v, m));
    el('polyline', { points: pointsAttr([p1, p2, p3]), class: 'right-mark' }, this.layers.back);

    // slots
    this.slots = level.pieces.map((p) => {
      const poly = sc(p.target);
      return { poly, c: centroid(poly), filled: false };
    });

    // pieces
    const snapSet = new Set<number>([0, 90, 180, 270]);
    level.pieces.forEach((p, idx) => {
      const start = sc(p.start);
      const home = centroid(start);
      const local = start.map(([x, y]) => [x - home[0], y - home[1]] as Pt);
      const matches: Match[] = [];
      this.slots.forEach((s, j) => {
        for (const th of matchRotations(local, s.poly, s.c, 0.05)) {
          matches.push({ slot: j, th });
          snapSet.add(Math.round(th * 100) / 100);
          for (const k of [90, 180, 270]) snapSet.add(Math.round(norm360(th + k) * 100) / 100);
        }
      });
      if (!matches.length) console.warn('piece without slot', idx);
      const g = el('g', { class: 'piece' }, this.layers.free);
      const inner = el('g', {}, g);
      const poly = el('polygon', { points: pointsAttr(local), fill: p.color, class: 'piece-poly' }, inner);
      poly.dataset.idx = String(idx);
      const radius = Math.max(...local.map(([x, y]) => Math.hypot(x, y)));
      const piece: Piece = { idx, color: p.color, local, home, x: home[0], y: home[1], rot: 0, placed: false, matches, g, inner, poly, radius };
      this.pieces.push(piece);
      this.applyTransform(piece);
    });
    this.snapAngles = dedupe([...snapSet].map(norm360).sort((a, b) => a - b));

    // rotation handle
    this.handle = el('g', { class: 'rot-handle', visibility: 'hidden' }, this.layers.over);
    el('line', { class: 'rot-stem', x1: 0, y1: 0, x2: 0, y2: 0 }, this.handle);
    const knob = el('g', { class: 'rot-knob' }, this.handle);
    el('circle', { r: 5.2, class: 'rot-knob-bg' }, knob);
    el('path', { d: 'M -2.4 -1.2 A 2.7 2.7 0 1 1 -1.4 2.2', class: 'rot-icon' }, knob);
    el('path', { d: 'M -3.6 -2.6 L -2.3 -0.6 L -0.6 -2.2', class: 'rot-icon' }, knob);
    el('circle', { r: 9, class: 'rot-hit' }, knob);

    this.bindEvents();
    container.appendChild(this.svg);
  }

  // ---------- public API ----------
  get total(): number { return this.pieces.length; }
  get placedCount(): number { return this.pieces.filter((p) => p.placed).length; }
  hasSelection(): boolean { return !!this.selected && !this.selected.placed; }

  rotateStep(dir: 1 | -1): void {
    const p = this.selected;
    if (!p || p.placed) return;
    const cur = norm360(p.rot);
    const list = this.snapAngles;
    let next: number;
    if (dir > 0) next = list.find((a) => a > cur + 0.5) ?? list[0] + 360;
    else next = [...list].reverse().find((a) => a < cur - 0.5) ?? list[list.length - 1] - 360;
    const delta = next - cur;
    this.animate(p, [p.x, p.y], p.rot + delta, 160, () => this.tryPlace(p, false));
  }

  hint(): boolean {
    const p = this.selected && !this.selected.placed ? this.selected : this.pieces.find((q) => !q.placed);
    if (!p) return false;
    const m = p.matches.find((mm) => !this.slots[mm.slot].filled);
    if (!m) return false;
    this.select(p);
    this.layers.hint.innerHTML = '';
    const s = this.slots[m.slot];
    el('polygon', { points: pointsAttr(s.poly), class: 'hint-slot', style: `--c:${p.color}` }, this.layers.hint);
    p.poly.classList.add('hinted');
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => {
      this.layers.hint.innerHTML = '';
      p.poly.classList.remove('hinted');
    }, 2600);
    return true;
  }

  resetLoose(): void {
    for (const p of this.pieces) if (!p.placed) this.animate(p, p.home, 0, 260);
    this.select(null);
  }

  destroy(): void {
    this.destroyed = true;
    window.clearTimeout(this.hintTimer);
    this.svg.remove();
  }

  /** testing helper: solve one piece instantly */
  autoPlaceOne(): boolean {
    for (const p of this.pieces) {
      if (p.placed) continue;
      const m = p.matches.find((mm) => !this.slots[mm.slot].filled);
      if (!m) continue;
      this.place(p, m);
      return true;
    }
    return false;
  }

  // ---------- internals ----------
  private applyTransform(p: Piece): void {
    p.g.setAttribute('transform', `translate(${p.x.toFixed(3)} ${p.y.toFixed(3)}) rotate(${p.rot.toFixed(3)})`);
    if (p === this.selected) this.updateHandle();
  }

  private handlePos(p: Piece): Pt {
    const R = p.radius + 7;
    const a = ((p.rot + this.knobLocal) * Math.PI) / 180;
    return [p.x + R * Math.cos(a), p.y + R * Math.sin(a)];
  }

  private updateHandle(): void {
    const p = this.selected;
    if (!p || p.placed) {
      this.handle.setAttribute('visibility', 'hidden');
      return;
    }
    const [hx, hy] = this.handlePos(p);
    this.handle.setAttribute('visibility', 'visible');
    const stem = this.handle.querySelector('.rot-stem')!;
    stem.setAttribute('x1', p.x.toFixed(2));
    stem.setAttribute('y1', p.y.toFixed(2));
    stem.setAttribute('x2', hx.toFixed(2));
    stem.setAttribute('y2', hy.toFixed(2));
    this.handle.querySelector('.rot-knob')!.setAttribute('transform', `translate(${hx.toFixed(2)} ${hy.toFixed(2)}) rotate(${(p.rot + this.knobLocal + 90).toFixed(1)})`);
  }

  private select(p: Piece | null): void {
    if (this.selected) this.selected.poly.classList.remove('selected');
    this.selected = p && !p.placed ? p : null;
    if (this.selected) {
      this.selected.poly.classList.add('selected');
      this.layers.free.appendChild(this.selected.g); // bring to front
      // place the rotation knob where it stays on screen
      const p0 = this.selected;
      const R = p0.radius + 7;
      const { x0, y0, x1, y1 } = this.bounds;
      const m = 7;
      const world = [-90, 0, 180, 90, -45, -135, 45, 135].find((w) => {
        const hx = p0.x + R * Math.cos((w * Math.PI) / 180);
        const hy = p0.y + R * Math.sin((w * Math.PI) / 180);
        return hx > x0 + m && hx < x1 - m && hy > y0 + m && hy < y1 - m;
      }) ?? -90;
      this.knobLocal = world - p0.rot;
    }
    this.updateHandle();
    this.ev.onSelect?.(!!this.selected);
  }

  private toSvg(e: PointerEvent): Pt {
    const m = this.svg.getScreenCTM();
    if (!m) return [0, 0];
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [pt.x, pt.y];
  }

  private clamp(p: Piece): void {
    const { x0, y0, x1, y1 } = this.bounds;
    p.x = Math.min(x1 - 2, Math.max(x0 + 2, p.x));
    p.y = Math.min(y1 - 2, Math.max(y0 + 2, p.y));
  }

  private bindEvents(): void {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (e) => {
      const pt = this.toSvg(e);
      this.pointers.set(e.pointerId, pt);
      svg.setPointerCapture(e.pointerId);
      const target = e.target as Element;

      // second finger → pinch-rotate selected piece
      if (this.pointers.size === 2 && this.selected && !this.selected.placed) {
        const [a, b] = [...this.pointers.values()];
        this.mode = 'pinch';
        this.pinchStart = { ang: angleOf(a, b), rot: this.selected.rot, mid: mid(a, b), pos: [this.selected.x, this.selected.y] };
        e.preventDefault();
        return;
      }
      if (this.pointers.size > 1) return;

      if (target.closest('.rot-knob') && this.selected) {
        const p = this.selected;
        this.mode = 'rotate';
        this.rotStart = { pointerAng: angleOf([p.x, p.y], pt), rot: p.rot };
        e.preventDefault();
        return;
      }
      const idx = (target as SVGElement).dataset?.idx;
      if (idx !== undefined) {
        const p = this.pieces[Number(idx)];
        if (p.placed) return;
        this.select(p);
        this.mode = 'drag';
        this.dragOff = [p.x - pt[0], p.y - pt[1]];
        p.g.classList.add('dragging');
        e.preventDefault();
        return;
      }
      this.mode = 'none';
      this.select(null);
    });

    svg.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const pt = this.toSvg(e);
      this.pointers.set(e.pointerId, pt);
      const p = this.selected;
      if (!p) return;
      if (this.mode === 'drag') {
        p.x = pt[0] + this.dragOff[0];
        p.y = pt[1] + this.dragOff[1];
        this.clamp(p);
        this.applyTransform(p);
      } else if (this.mode === 'rotate') {
        p.rot = this.rotStart.rot + (angleOf([p.x, p.y], pt) - this.rotStart.pointerAng);
        this.applyTransform(p);
      } else if (this.mode === 'pinch' && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const m = mid(a, b);
        p.rot = this.pinchStart.rot + (angleOf(a, b) - this.pinchStart.ang);
        p.x = this.pinchStart.pos[0] + (m[0] - this.pinchStart.mid[0]);
        p.y = this.pinchStart.pos[1] + (m[1] - this.pinchStart.mid[1]);
        this.clamp(p);
        this.applyTransform(p);
      }
    });

    const end = (e: PointerEvent): void => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      const p = this.selected;
      const mode = this.mode;
      if (mode === 'pinch' && this.pointers.size === 1 && p) {
        // continue as a drag with the remaining finger
        const rest = [...this.pointers.values()][0];
        this.snapRotation(p);
        this.mode = 'drag';
        this.dragOff = [p.x - rest[0], p.y - rest[1]];
        return;
      }
      if (this.pointers.size > 0) return;
      this.mode = 'none';
      if (!p) return;
      p.g.classList.remove('dragging');
      if (mode === 'rotate' || mode === 'pinch') this.snapRotation(p);
      if (mode === 'drag' || mode === 'rotate' || mode === 'pinch') this.tryPlace(p, mode === 'drag', mode !== 'rotate');
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  private worldPoly(p: Piece, rot = p.rot, x = p.x, y = p.y): Pt[] {
    const t = (rot * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    return p.local.map(([lx, ly]) => [c * lx - s * ly + x, s * lx + c * ly + y] as Pt);
  }

  /** Edges a dropped piece can stick to: hypotenuse-square border, leg-square borders, other pieces. */
  private magnetEdges(self: Piece): [Pt, Pt][] {
    const segs: [Pt, Pt][] = [];
    const addPoly = (poly: Pt[]): void => poly.forEach((a, i) => segs.push([a, poly[(i + 1) % poly.length]]));
    addPoly(this.hyp);
    for (const q of this.pieces) if (q !== self) addPoly(this.worldPoly(q));
    return segs;
  }

  /**
   * Magnetic snap: if one of the piece's edges lies close to (and almost parallel with) a nearby edge,
   * rotate it exactly parallel, slide it flush against that edge, and line up nearby corners.
   */
  private magnet(p: Piece): boolean {
    const segs = this.magnetEdges(p);
    const poly = this.worldPoly(p);
    let best: { d: number; dRot: number; seg: [Pt, Pt]; edge: number } | null = null;
    poly.forEach((a, i) => {
      const b = poly[(i + 1) % poly.length];
      const la = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (la < 1) return;
      const alpha = angleOf(a, b);
      for (const seg of segs) {
        const [c, d] = seg;
        const lt = Math.hypot(d[0] - c[0], d[1] - c[1]);
        if (lt < 1) continue;
        let dRot = norm360(angleOf(c, d) - alpha);
        dRot = ((dRot + 90) % 180) - 90; // parallel either way → (-90, 90]
        if (Math.abs(dRot) > MAG_ANG) continue;
        const u: Pt = [(d[0] - c[0]) / lt, (d[1] - c[1]) / lt];
        const m = mid(a, b);
        const dist = Math.abs(u[0] * (m[1] - c[1]) - u[1] * (m[0] - c[0]));
        if (dist > MAG_DIST) continue;
        // the two edges must overlap along the line
        const pa = (a[0] - c[0]) * u[0] + (a[1] - c[1]) * u[1];
        const pb = (b[0] - c[0]) * u[0] + (b[1] - c[1]) * u[1];
        const overlap = Math.min(Math.max(pa, pb), lt) - Math.max(Math.min(pa, pb), 0);
        if (overlap < 1.5) continue;
        const score = dist + Math.abs(dRot) * 0.25;
        if (!best || score < best.d) best = { d: score, dRot, seg, edge: i };
      }
    });
    if (!best) return false;
    const { dRot, seg, edge } = best as { dRot: number; seg: [Pt, Pt]; edge: number };

    // 1) rotate exactly parallel
    const rot = p.rot + dRot;
    let poly2 = this.worldPoly(p, rot);
    const [c, d] = seg;
    const lt = Math.hypot(d[0] - c[0], d[1] - c[1]);
    const u: Pt = [(d[0] - c[0]) / lt, (d[1] - c[1]) / lt];
    const n: Pt = [-u[1], u[0]];
    // 2) slide flush onto the line
    const em = mid(poly2[edge], poly2[(edge + 1) % poly2.length]);
    const off = (c[0] - em[0]) * n[0] + (c[1] - em[1]) * n[1];
    let x = p.x + n[0] * off;
    let y = p.y + n[1] * off;
    poly2 = this.worldPoly(p, rot, x, y);
    // 3) slide along the line so a corner meets a nearby corner
    const corners: Pt[] = [];
    for (const [s0, s1] of segs) corners.push(s0, s1);
    let bestSlide = MAG_DIST + 0.001;
    let slide = 0;
    for (const v of poly2) {
      for (const k of corners) {
        const perp = Math.abs((k[0] - v[0]) * n[0] + (k[1] - v[1]) * n[1]);
        if (perp > 0.6) continue;
        const along = (k[0] - v[0]) * u[0] + (k[1] - v[1]) * u[1];
        if (Math.abs(along) < Math.abs(bestSlide)) { bestSlide = along; slide = along; }
      }
    }
    x += u[0] * slide;
    y += u[1] * slide;
    if (Math.hypot(x - p.x, y - p.y) < 0.05 && Math.abs(dRot) < 0.05) return true;
    p.x = x;
    p.y = y;
    p.rot = rot;
    this.clamp(p);
    this.applyTransform(p);
    p.inner.classList.remove('snap');
    void p.inner.getBoundingClientRect();
    p.inner.classList.add('snap');
    this.ev.onMagnet?.();
    return true;
  }

  private snapRotation(p: Piece): void {
    const cur = norm360(p.rot);
    let best = 999;
    let bestA = cur;
    for (const a of this.snapAngles) {
      const d = angDiff(a, cur);
      if (d < best) { best = d; bestA = a; }
    }
    if (best <= ROT_SNAP) {
      const delta = signedDiff(bestA, cur);
      p.rot += delta;
      this.applyTransform(p);
    }
  }

  private tryPlace(p: Piece, fromDrag: boolean, allowMagnet = fromDrag): void {
    if (p.placed || this.destroyed) return;
    let best: { m: Match; d: number } | null = null;
    for (const m of p.matches) {
      const s = this.slots[m.slot];
      if (s.filled) continue;
      const d = Math.hypot(p.x - s.c[0], p.y - s.c[1]);
      if (d < POS_TOL && angDiff(p.rot, m.th) < ROT_TOL && (!best || d < best.d)) best = { m, d };
    }
    if (best) {
      this.place(p, best.m);
      return;
    }
    // magnet: align to a nearby edge (square border or other pieces), then re-check for an exact fit
    if (allowMagnet && this.magnet(p)) {
      for (const m of p.matches) {
        const s = this.slots[m.slot];
        if (!s.filled && Math.hypot(p.x - s.c[0], p.y - s.c[1]) < POS_TOL && angDiff(p.rot, m.th) < ROT_TOL) {
          this.place(p, m);
          return;
        }
      }
    }
    if (fromDrag && pointInPoly([p.x, p.y], this.hyp)) {
      p.inner.classList.remove('shake');
      void p.inner.getBoundingClientRect();
      p.inner.classList.add('shake');
      this.ev.onWrong?.();
    }
  }

  private place(p: Piece, m: Match): void {
    const s = this.slots[m.slot];
    s.filled = true;
    p.placed = true;
    if (this.selected === p) this.select(null);
    const targetRot = p.rot + signedDiff(m.th, norm360(p.rot));
    this.layers.hint.innerHTML = '';
    p.poly.classList.remove('hinted', 'selected');
    this.animate(p, s.c, targetRot, 140, () => {
      this.layers.placed.appendChild(p.g);
      p.g.classList.add('placed');
      p.inner.classList.add('pop');
    });
    const placed = this.placedCount;
    this.ev.onPlace?.(placed, this.total);
    if (placed === this.total) window.setTimeout(() => !this.destroyed && this.ev.onComplete?.(), 380);
  }

  private animate(p: Piece, to: Pt, rot: number, ms: number, done?: () => void): void {
    const from: Pt = [p.x, p.y];
    const r0 = p.rot;
    const t0 = performance.now();
    const step = (now: number): void => {
      if (this.destroyed) return;
      const t = Math.min(1, (now - t0) / ms);
      const k = 1 - Math.pow(1 - t, 3);
      p.x = from[0] + (to[0] - from[0]) * k;
      p.y = from[1] + (to[1] - from[1]) * k;
      p.rot = r0 + (rot - r0) * k;
      this.applyTransform(p);
      if (t < 1) requestAnimationFrame(step);
      else done?.();
    };
    requestAnimationFrame(step);
  }
}

// ---------- small vector helpers ----------
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
const norm = (a: Pt): Pt => mul(a, 1 / Math.hypot(a[0], a[1]));
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const angleOf = (a: Pt, b: Pt): number => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
const signedDiff = (to: number, from: number): number => {
  let d = norm360(to - from);
  if (d > 180) d -= 360;
  return d;
};
const dedupe = (arr: number[]): number[] => arr.filter((a, i) => i === 0 || Math.abs(a - arr[i - 1]) > 0.5);
