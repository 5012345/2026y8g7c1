"""Generate & verify 10 Pythagorean dissection puzzles.

Output: src/levels.json  (coordinates normalised so hypotenuse c = 1, SVG y-down,
small leg square on the left, hypotenuse square below the triangle).

Every level is verified:
  * start pieces tile each leg square exactly (sampling + area)
  * target pieces tile the hypotenuse square exactly
  * every piece's start is congruent to its target by a proper rigid motion
"""
import json, math, random, sys

EPS = 1e-9

# ---------- basic geometry ----------
def area(p):
    s = 0.0
    for i in range(len(p)):
        x1, y1 = p[i]; x2, y2 = p[(i + 1) % len(p)]
        s += x1 * y2 - x2 * y1
    return s / 2

def ccw(p):
    return p if area(p) > 0 else p[::-1]

def clean(p, tol=1e-9):
    """remove duplicate & collinear vertices"""
    p = [tuple(map(float, v)) for v in p]
    changed = True
    while changed and len(p) > 3:
        changed = False
        n = len(p)
        for i in range(n):
            a, b, c = p[i - 1], p[i], p[(i + 1) % n]
            if math.dist(a, b) < 1e-9:
                p.pop(i); changed = True; break
            cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
            if abs(cr) < tol:
                p.pop(i); changed = True; break
    return p

def clip(subject, clipper):
    """Sutherland-Hodgman: subject polygon clipped by convex CCW clipper."""
    out = subject
    n = len(clipper)
    for i in range(n):
        a, b = clipper[i], clipper[(i + 1) % n]
        inp, out = out, []
        if not inp:
            break
        def inside(p):
            return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-12
        def inter(p, q):
            x1, y1 = p; x2, y2 = q; x3, y3 = a; x4, y4 = b
            den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
            t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
            return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))
        for j in range(len(inp)):
            cur, prev = inp[j], inp[j - 1]
            if inside(cur):
                if not inside(prev):
                    out.append(inter(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(inter(prev, cur))
    return out

def rot(p, th):
    c, s = math.cos(th), math.sin(th)
    return (c * p[0] - s * p[1], s * p[0] + c * p[1])

class Rigid:
    def __init__(self, th, t):
        self.th, self.t = th, t
    def __call__(self, poly):
        return [(rot(p, self.th)[0] + self.t[0], rot(p, self.th)[1] + self.t[1]) for p in poly]
    def inv(self):
        t = rot((-self.t[0], -self.t[1]), -self.th)
        return Rigid(-self.th, t)

def rigid_from(src, dst):
    """proper rigid map sending src[0]->dst[0], src[1]->dst[1]; asserts all others match"""
    th = math.atan2(dst[1][1] - dst[0][1], dst[1][0] - dst[0][0]) - \
         math.atan2(src[1][1] - src[0][1], src[1][0] - src[0][0])
    r = rot(src[0], th)
    m = Rigid(th, (dst[0][0] - r[0], dst[0][1] - r[1]))
    for p, q in zip(m(src), dst):
        assert math.dist(p, q) < 1e-7, ("rigid mismatch", p, q)
    return m

def translate(poly, v):
    return [(x + v[0], y + v[1]) for x, y in poly]

def rotate_about(poly, th, c):
    return [(rot((x - c[0], y - c[1]), th)[0] + c[0], rot((x - c[0], y - c[1]), th)[1] + c[1]) for x, y in poly]

def point_in(p, poly):
    x, y = p; inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if xi > x:
                inside = not inside
    return inside

def dist_to_boundary(p, poly):
    best = 1e9
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = dx * dx + dy * dy
        t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
        best = min(best, math.dist(p, (a[0] + t * dx, a[1] + t * dy)))
    return best

def proper_match(P, Q, tol=1e-6):
    """True if polygon P maps onto Q by a rotation+translation"""
    if len(P) != len(Q):
        return False
    n = len(P)
    for k in range(n):
        Qs = Q[k:] + Q[:k]
        try:
            rigid_from(P, Qs)
            return True
        except AssertionError:
            pass
    return False

# ---------- game frame ----------
def game_frame(a, b):
    c = math.hypot(a, b)
    u = (b / c, a / c); v = (-a / c, b / c)
    A = (0.0, 0.0); B = (c, 0.0)
    C = (b * u[0], b * u[1])
    big = [A, C, (C[0] + b * v[0], C[1] + b * v[1]), (b * v[0], b * v[1])]           # on AC (length b)
    small = [C, B, (B[0] + a * u[0], B[1] + a * u[1]), (C[0] + a * u[0], C[1] + a * u[1])]  # on CB (length a)
    hyp = [A, (0.0, -c), (c, -c), B]
    for sq in (big, small, hyp):
        assert area(sq) > 0
    return dict(a=a, b=b, c=c, u=u, v=v, A=A, B=B, C=C, big=big, small=small, hyp=hyp)

def sq_corners(x0, y0, s):
    return [(x0, y0), (x0 + s, y0), (x0 + s, y0 + s), (x0, y0 + s)]

def rolled(lst, k):
    return lst[k:] + lst[:k]

# ---------- level builders (each returns list of (start, target) in game math frame) ----------
def lvl_grid(G):
    a, b, c = int(round(G['a'])), int(round(G['b'])), int(round(G['c']))
    Ms = rigid_from(sq_corners(0, 0, a), G['small'])
    Mb = rigid_from(sq_corners(0, 0, b), G['big'])
    Mh = rigid_from(sq_corners(0, 0, c), G['hyp'])
    starts = [Ms(sq_corners(i, j, 1)) for i in range(a) for j in range(a)] + \
             [Mb(sq_corners(i, j, 1)) for i in range(b) for j in range(b)]
    targets = [Mh(sq_corners(i, j, 1)) for i in range(c) for j in range(c)]
    random.Random(1).shuffle(targets)
    return list(zip(starts, targets))

def lvl_tess(G, o, rotk=0):
    a, b, c, u, v = G['a'], G['b'], G['c'], G['u'], G['v']
    uv = lambda p: (p[0] * u[0] + p[1] * v[0], p[0] * u[1] + p[1] * v[1])
    B0 = G['big']
    S0p = [uv(p) for p in [(b, b - a), (b + a, b - a), (b + a, b), (b, b)]]  # small square in the tiling
    w = (-b * v[0], -b * v[1])  # S0' + w = game small square
    chk = translate(S0p, w)
    for p, q in zip(chk, rolled(G['small'], 1)):
        assert math.dist(p, q) < 1e-9, (p, q)
    pieces = []
    H0 = (0.0, -c)
    hc = (c / 2, -c / 2)
    for sq, shift in ((B0, (0, 0)), (S0p, w)):
        for i in range(-4, 5):
            for j in range(-4, 5):
                cell = sq_corners(o[0] + i * c, o[1] + j * c, c)
                P = clip(sq, cell)
                if len(P) < 3 or area(P) < 1e-7:
                    continue
                P = clean(ccw(P))
                tgt = translate(P, (-i * c - o[0] + H0[0], -j * c - o[1] + H0[1]))
                if rotk:
                    tgt = rotate_about(tgt, rotk * math.pi / 2, hc)
                pieces.append((translate(P, shift), tgt))
    return pieces

def lvl_iso8(G):
    a = G['a']; c = G['c']
    Ms = rigid_from(sq_corners(0, 0, a), G['small'])
    Mb = rigid_from(sq_corners(0, 0, a), rolled(G['big'], 1))
    Mh = rigid_from(sq_corners(0, 0, c), G['hyp'])
    m = [(a / 2, 0), (a, a / 2), (a / 2, a), (0, a / 2)]; O = (a / 2, a / 2)
    corners = sq_corners(0, 0, a)
    smalls = [[corners[k], m[k], m[k - 1]] for k in range(4)] + [[O, m[k], m[(k + 1) % 4]] for k in range(4)]
    starts = [Ms(sq_corners(0, 0, a))] + [Mb(ccw(t)) for t in smalls]
    H = sq_corners(0, 0, c); hm = [(c / 2, 0), (c, c / 2), (c / 2, c), (0, c / 2)]
    tg = [Mh(hm)]
    for k in range(4):
        V = H[k]; p1 = hm[k]; p2 = hm[k - 1]
        mid = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
        tg += [Mh(ccw([V, p1, mid])), Mh(ccw([V, mid, p2]))]
    return list(zip(starts, tg))

def lvl_bride(G):
    a, b = G['a'], G['b']
    Ms = rigid_from(sq_corners(0, 0, a), rolled(G['small'], 2))
    Mb = rigid_from(sq_corners(a, 0, b), rolled(G['big'], 3))
    Q = [(0, a), (b, 0), (a + b, b), (a, a + b)]
    Mh = rigid_from(Q, rolled(G['hyp'], 0))
    y1 = a * (b - a) / b
    T1s = [(0, 0), (a, 0), (a, y1), (0, a)]
    T1b = [(a, 0), (b, 0), (a, y1)]
    T2 = [(b, 0), (a + b, 0), (a + b, b)]
    Rs = [(0, a), (a, y1), (a, a)]
    Rb = [(a, y1), (b, 0), (a + b, b), (a, b)]
    R1 = lambda P: rotate_about(P, math.pi / 2, (0, a))
    R2 = lambda P: rotate_about(P, -math.pi / 2, (a + b, b))
    return [
        (Ms(T1s), Mh(R1(T1s))), (Ms(Rs), Mh(Rs)),
        (Mb(T1b), Mh(R1(T1b))), (Mb(T2), Mh(R2(T2))), (Mb(Rb), Mh(Rb)),
    ]

def lvl_iso_halves(G):
    a, c = G['a'], G['c']
    Ms = rigid_from(sq_corners(0, 0, a), G['small'])
    Mb = rigid_from(sq_corners(0, 0, a), G['big'])
    Mh = rigid_from(sq_corners(0, 0, c), G['hyp'])
    S = sq_corners(0, 0, a); O = (a / 2, a / 2)
    starts = [Ms([S[0], S[1], S[2]]), Ms([S[0], S[2], S[3]])] + [Mb([O, S[k], S[(k + 1) % 4]]) for k in range(4)]
    H = sq_corners(0, 0, c); M = (c / 2, c / 2)
    tg = [Mh([H[0], H[1], M]), Mh([H[2], H[3], M])]
    for k in (1, 3):
        p, q = H[k], H[(k + 1) % 4]
        mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
        tg += [Mh([p, mid, M]), Mh([mid, q, M])]
    return list(zip(starts, tg))

def lvl_bhaskara(G):
    a, b, c = G['a'], G['b'], G['c']
    Ms = rigid_from(sq_corners(0, 0, a), rolled(G['small'], 1))
    Mb = rigid_from(sq_corners(0, 0, b), rolled(G['big'], 2))
    Mh = rigid_from(sq_corners(0, 0, c), G['hyp'])
    k = a * a / b
    sqT = [(0, 0), (a, 0), (a, k)]
    sqQ = [(0, 0), (a, k), (a, a), (0, a)]
    rectQ = [(a, 0), (b, 0), (b, a), (a, k)]
    rectT = [(a, k), (b, a), (a, a)]
    rect_map = rigid_from([(a, 0), (b, 0), (b, a), (a, a)], [(b, a), (b, b), (b - a, b), (b - a, a)])
    BT1 = [(0, 0), (b, 0), (b, a)]
    BT2 = [(0, 0), (b, a), (0, a)]
    Ssq = [(0, a), (b - a, a), (b - a, b), (0, b)]
    V = sq_corners(0, 0, c); ctr = (c / 2, c / 2)
    R0 = (a * a / c, a * b / c)
    R = [rotate_about([R0], kk * math.pi / 2, ctr)[0] for kk in range(4)]
    Tk = lambda kk: (V[(kk + 1) % 4], R[kk], V[kk])           # (b-vertex, right, a-vertex)
    Tlow = [(0, 0), (b, 0), (b, a)]                            # b-vertex, right, a-vertex
    Tup = [(b, a), (0, a), (0, 0)]
    M0 = rigid_from(Tlow, list(Tk(0)))
    M2 = rigid_from(Tup, list(Tk(2)))
    BT1map = rigid_from(Tlow, list(Tk(1)))
    BT2map = rigid_from(Tup, list(Tk(3)))
    inner = rigid_from(Ssq, R)
    return [
        (Ms(sqT), Mh(M0(sqT))), (Ms(sqQ), Mh(M2(sqQ))),
        (Mb(rect_map(rectQ)), Mh(M0(rectQ))), (Mb(rect_map(rectT)), Mh(M2(rectT))),
        (Mb(BT1), Mh(BT1map(BT1))), (Mb(BT2), Mh(BT2map(BT2))), (Mb(Ssq), Mh(inner(Ssq))),
    ]

# ---------- verification ----------
def verify(G, pieces, name):
    rng = random.Random(7)
    for i, (s, t) in enumerate(pieces):
        assert proper_match(clean(ccw(s)), clean(ccw(t))), f"{name}: piece {i} not congruent"
    starts = [clean(ccw(s)) for s, _ in pieces]
    targets = [clean(ccw(t)) for _, t in pieces]
    def tiles(region, polys, label):
        tot = sum(area(p) for p in polys)
        assert abs(tot - area(region)) < 1e-6, f"{name}/{label}: area {tot} vs {area(region)}"
        xs = [p[0] for p in region]; ys = [p[1] for p in region]
        cnt = 0
        while cnt < 6000:
            p = (rng.uniform(min(xs), max(xs)), rng.uniform(min(ys), max(ys)))
            if not point_in(p, region) or dist_to_boundary(p, region) < 1e-6:
                continue
            hits = [k for k, q in enumerate(polys) if point_in(p, q) and dist_to_boundary(p, q) > 1e-6]
            near = any(dist_to_boundary(p, q) <= 1e-6 for q in polys)
            if not near:
                assert len(hits) == 1, f"{name}/{label}: point {p} covered {len(hits)}x"
            cnt += 1
    inside = lambda poly, sq: all(point_in(((poly[0][0]*0.5+cx*0.5), (poly[0][1]*0.5+cy*0.5)), sq) for cx, cy in [centroid(poly)])
    sm = [s for s in starts if point_in(centroid(s), G['small'])]
    bg = [s for s in starts if point_in(centroid(s), G['big'])]
    assert len(sm) + len(bg) == len(starts), f"{name}: stray start piece"
    tiles(G['small'], sm, 'small'); tiles(G['big'], bg, 'big'); tiles(G['hyp'], targets, 'hyp')
    return len(sm), len(bg)

def centroid(p):
    A = area(p); cx = cy = 0
    for i in range(len(p)):
        x1, y1 = p[i]; x2, y2 = p[(i + 1) % len(p)]
        f = x1 * y2 - x2 * y1
        cx += (x1 + x2) * f; cy += (y1 + y2) * f
    return (cx / (6 * A), cy / (6 * A))

def min_quality(pieces, c):
    """smallest piece area (relative) and shortest edge (relative)"""
    ma = min(area(clean(ccw(s))) for s, _ in pieces) / (c * c)
    me = min(math.dist(p[i], p[(i + 1) % len(p)]) for s, _ in pieces for p in [clean(ccw(s))] for i in range(len(p))) / c
    return ma, me

PALETTE = ['#FFD84D', '#FF4B2B', '#3D9BFF', '#B6EE6A', '#FFA24C', '#7FDDF5', '#34B94A', '#FFC9EC', '#F06FC6', '#A98BFF', '#FFE9A8', '#2EC4B6']

def export(G, pieces, meta):
    c = G['c']
    f = lambda p: [round((c - p[0]) / c, 6), round(-p[1] / c, 6)]
    tf = lambda poly: [f(q) for q in clean(ccw(poly))]
    out_pieces = []
    for i, (s, t) in enumerate(pieces):
        out_pieces.append({'start': tf(s), 'target': tf(t), 'color': PALETTE[(i * 5 + meta.get('colorShift', 0)) % len(PALETTE)]})
    if meta.get('uniformColor'):
        for k, p in enumerate(out_pieces):
            p['color'] = meta['uniformColor'][0] if point_in(centroid([tuple(q) for q in p['start']]), [tuple(f(q)) for q in G['small']][::-1]) else meta['uniformColor'][1]
    return {
        **{k: v for k, v in meta.items() if k not in ('colorShift', 'uniformColor')},
        'a': G['a'], 'b': G['b'],
        'small': [f(p) for p in G['small']], 'big': [f(p) for p in G['big']],
        'hyp': [f(p) for p in G['hyp']], 'tri': [f(G['A']), f(G['B']), f(G['C'])],
        'pieces': out_pieces,
    }

def search_offsets(a, b, want_small, want_big, seed):
    G = game_frame(a, b); c = G['c']
    rng = random.Random(seed); best = None
    for _ in range(4000):
        o = (rng.uniform(0, c), rng.uniform(0, c))
        P = lvl_tess(G, o)
        ns = sum(1 for s, _ in P if point_in(centroid(s), G['small']))
        nb = len(P) - ns
        if (ns, nb) != (want_small, want_big):
            continue
        ma, me = min_quality(P, c)
        score = ma + 0.05 * me
        if best is None or score > best[0]:
            best = (score, o, ma, me)
    return best

if __name__ == '__main__':
    levels = []
    def add(G, pieces, meta):
        ns, nb = verify(G, pieces, meta['title'])
        ma, me = min_quality(pieces, G['c'])
        print(f"{meta['title']:<24} a={G['a']:.3g} b={G['b']:.3g} small={ns} big={nb} minArea={ma:.3f} minEdge={me:.3f}")
        levels.append(export(G, pieces, meta))

    # 1 grid
    G = game_frame(3, 4)
    add(G, lvl_grid(G), dict(title='격자 세기', subtitle='3² + 4² = 5²', concept='작은 정사각형(넓이 1)을 하나씩 세어 옮겨 보세요. 9 + 16 = 25', uniformColor=['#FFD84D', '#FF4B2B']))
    # 2 Perigal
    G = game_frame(3, 5)
    o = ((G['big'][0][0] + G['big'][2][0]) / 2, (G['big'][0][1] + G['big'][2][1]) / 2)
    add(G, lvl_tess(G, o), dict(title='페리갈의 바람개비', subtitle='Perigal (1830)', concept='큰 정사각형을 중심을 지나는 두 직선으로 자른 4조각과 작은 정사각형으로 빗변 위의 정사각형을 채웁니다.', colorShift=3))
    # 3 iso 8
    G = game_frame(1, 1)
    add(G, lvl_iso8(G), dict(title='직각이등변삼각형 ①', subtitle='a = b', concept='두 직각변이 같을 때, 한 정사각형은 통째로, 다른 하나는 8개의 삼각형으로 옮겨요.', colorShift=0))
    # 4 bride's chair
    G = game_frame(2.5, 4)
    add(G, lvl_bride(G), dict(title='신부의 의자', subtitle='Thābit ibn Qurra', concept='두 직각삼각형 조각을 90° 돌려 붙이면 빗변 위의 정사각형이 됩니다.', colorShift=4))
    # 5 iso halves
    G = game_frame(1, 1)
    add(G, lvl_iso_halves(G), dict(title='직각이등변삼각형 ②', subtitle='반쪽과 4분의 1', concept='빗변 위의 정사각형을 대각선으로 4등분해서 생각해 보세요.', colorShift=1))
    # 6,7,8 tessellations
    plan = [((3.5, 4.5), (2, 4), 11, 0, '평면 채우기 ①', 2), ((3, 4), (2, 4), 12, 1, '평면 채우기 ②', 6), ((3.5, 4.5), (3, 4), 13, 2, '평면 채우기 ③', 9)]
    tess_meta = '두 정사각형을 빗변 길이 간격의 격자로 자른 조각들입니다. 조각을 회전해야 할 수도 있어요!'
    chosen = []
    for (ab, want, seed, rk, title, cs) in plan:
        G = game_frame(*ab)
        best = search_offsets(*ab, *want, seed)
        assert best, title
        add(G, lvl_tess(G, best[1], rk), dict(title=title, subtitle='Tessellation', concept=tess_meta, colorShift=cs))
    # 9 Bhaskara
    G = game_frame(2.2, 4.2)
    add(G, lvl_bhaskara(G), dict(title='바스카라의 바람개비', subtitle='Bhāskara II', concept='합동인 직각삼각형 4개와 가운데 작은 정사각형으로 빗변 위의 정사각형을 만들어요.', colorShift=5))
    # 10 tessellation hard
    G = game_frame(2, 4)
    best = search_offsets(2, 4, 4, 4, 21)
    assert best
    add(G, lvl_tess(G, best[1], 3), dict(title='평면 채우기 ④', subtitle='최종 단계', concept=tess_meta, colorShift=7))

    with open(sys.argv[1] if len(sys.argv) > 1 else 'levels.json', 'w') as fp:
        json.dump(levels, fp, ensure_ascii=False)
    print('levels:', len(levels))
