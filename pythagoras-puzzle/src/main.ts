import './style.css';
import levelsJson from './levels.json';
import { LevelDef, pointsAttr } from './geometry';
import { PuzzleBoard } from './puzzle';
import { qrSvg } from './qr';
import { SERVER_TS, db, listen, online } from './net';
import { sfx } from './sound';

const LEVELS = levelsJson as unknown as LevelDef[];
const HINT_PENALTY = 10_000;
const TOP_N = 5;
const NAME_MAX = 10;
const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

// ---------------------------------------------------------------- utils
const h = (html: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const fmt = (ms: number): string => {
  ms = Math.max(0, ms);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor((ms % 1000) / 100);
  return `${m}:${String(s).padStart(2, '0')}.${t}`;
};
/** "12.3초" (≥ 60 s → "1분 12.3초") – same rounding as the on-screen timer */
const sec = (ms: number): string => {
  const s = Math.floor(Math.max(0, ms) / 100) / 10;
  if (s < 60) return `${s.toFixed(1)}초`;
  const m = Math.floor(s / 60);
  return `${m}분 ${(s - m * 60).toFixed(1)}초`;
};
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const baseUrl = (): string => `${location.origin}${location.pathname}`;
const rid = (): string => Math.random().toString(36).slice(2, 10);
const sKey = (i: number): string => `s${i}`; // non-numeric keys so Firebase never turns them into arrays

const ICON = {
  rotL: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/></svg>',
  rotR: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  hint: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>',
  trophy: '<svg viewBox="0 0 24 24"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
  users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="m7 4 13 8-13 8z"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>',
};

function thumb(level: LevelDef): string {
  const all = [...level.small, ...level.big, ...level.hyp];
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs) - 0.05;
  const y0 = Math.min(...ys) - 0.05;
  const w = Math.max(...xs) - x0 + 0.05;
  const hh = Math.max(...ys) - y0 + 0.05;
  const pieces = level.pieces.map((p) => `<polygon points="${pointsAttr(p.start)}" fill="${p.color}" stroke="#6b4a2a" stroke-width="0.008" stroke-linejoin="round"/>`).join('');
  return `<svg viewBox="${x0} ${y0} ${w} ${hh}" class="thumb"><polygon points="${pointsAttr(level.hyp)}" fill="#f1f1f1" stroke="#c8c8c8" stroke-width="0.008"/>${pieces}</svg>`;
}

// ---------------------------------------------------------------- records
interface Entry { name: string; ms: number; at?: number }
interface PlayerInfo { name?: string; best?: Record<string, number> }
interface Records {
  stages?: Record<string, Record<string, Entry>>; // stage → entryKey → saved (nicknamed) record
  players?: Record<string, PlayerInfo>; // personal bests (saved automatically, no name needed)
}
interface RankRow extends Entry { key: string }

const topOf = (rec: Records, i: number, n = TOP_N): RankRow[] =>
  Object.entries(rec.stages?.[sKey(i)] ?? {})
    .map(([key, e]) => ({ key, ...e }))
    .filter((e) => typeof e.ms === 'number')
    .sort((a, b) => a.ms - b.ms || (a.at ?? 0) - (b.at ?? 0))
    .slice(0, n);

interface OverallRow { key: string; name: string; total: number }
const overallOf = (rec: Records): OverallRow[] =>
  Object.entries(rec.players ?? {})
    .filter(([, p]) => p.best && LEVELS.every((_, i) => typeof p.best![sKey(i)] === 'number'))
    .map(([key, p]) => ({ key, name: p.name || '(이름 없음)', total: LEVELS.reduce((s, _, i) => s + p.best![sKey(i)], 0) }))
    .sort((a, b) => a.total - b.total);

/** Where records live: a Firebase room (class) or this device (solo / no Firebase). */
interface Backend {
  kind: 'room' | 'local';
  label: string;
  pid: string;
  rec: Records;
  subscribe(cb: () => void): () => void;
  /** personal best for this device, saved on every clear */
  recordClear(i: number, ms: number): Promise<void>;
  /** saves a nicknamed record into the stage's top list */
  saveTop(i: number, name: string, ms: number): Promise<void>;
  setName(name: string): Promise<void>;
  /** rank this time would get (1-based) – null if it would not enter the top 5 */
  wouldRank(i: number, ms: number): number | null;
}

function devicePid(): string {
  let id = store.get('pp-pid');
  if (!id) { id = rid(); store.set('pp-pid', id); }
  return id;
}

function roomBackend(code: string): Backend {
  const pid = devicePid();
  const subs = new Set<() => void>();
  const b: Backend = {
    kind: 'room',
    label: `방 ${code}`,
    pid,
    rec: {},
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    async recordClear(i, ms) {
      const cur = b.rec.players?.[pid]?.best?.[sKey(i)];
      if (cur === undefined || ms < cur) await db.patch(`rooms/${code}/players/${pid}/best`, { [sKey(i)]: ms }).catch(() => undefined);
    },
    async saveTop(i, name, ms) {
      await db.put(`rooms/${code}/stages/${sKey(i)}/${pid}`, { name, ms, at: SERVER_TS });
      await b.setName(name);
    },
    async setName(name) {
      store.set('pp-name', name);
      await db.patch(`rooms/${code}/players/${pid}`, { name }).catch(() => undefined);
    },
    wouldRank(i, ms) {
      const mine = b.rec.stages?.[sKey(i)]?.[pid];
      if (mine && mine.ms <= ms) return null; // already holds an equal or better record here
      const others = topOf(b.rec, i, 999).filter((r) => r.key !== pid);
      const rank = others.filter((r) => r.ms <= ms).length + 1;
      return rank <= TOP_N ? rank : null;
    },
  };
  listen<Records>(`rooms/${code}`, (v) => {
    b.rec = v ?? {};
    subs.forEach((f) => f());
  });
  return b;
}

function localBackend(): Backend {
  const KEY = 'pp-local-records-v2';
  const subs = new Set<() => void>();
  const load = (): Records => { try { return JSON.parse(store.get(KEY) ?? '{}') as Records; } catch { return {}; } };
  const save = (): void => { store.set(KEY, JSON.stringify(b.rec)); subs.forEach((f) => f()); };
  const b: Backend = {
    kind: 'local',
    label: '이 기기',
    pid: 'me',
    rec: load(),
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    async recordClear(i, ms) {
      b.rec.players ??= {};
      const me = (b.rec.players.me ??= {});
      me.best ??= {};
      if (me.best[sKey(i)] === undefined || ms < me.best[sKey(i)]) { me.best[sKey(i)] = ms; save(); }
    },
    async saveTop(i, name, ms) {
      b.rec.stages ??= {};
      const st = (b.rec.stages[sKey(i)] ??= {});
      st[rid()] = { name, ms, at: Date.now() };
      // keep the list small: only the top entries are needed on one device
      const keep = new Set(topOf(b.rec, i, 20).map((r) => r.key));
      for (const k of Object.keys(st)) if (!keep.has(k)) delete st[k];
      await b.setName(name);
      save();
    },
    async setName(name) {
      store.set('pp-name', name);
      b.rec.players ??= {};
      (b.rec.players.me ??= {}).name = name;
      save();
    },
    wouldRank(i, ms) {
      const rank = topOf(b.rec, i, 999).filter((r) => r.ms <= ms).length + 1;
      return rank <= TOP_N ? rank : null;
    },
  };
  return b;
}

const rankList = (rows: RankRow[], highlight?: string, empty = '아직 기록이 없어요'): string =>
  rows.length
    ? `<ol class="top5">${rows.map((r, k) => `<li class="${r.key === highlight ? 'me' : ''} r${k + 1}"><span class="rk">${k + 1}</span><span class="nm">${esc(r.name)}</span><b>${sec(r.ms)}</b></li>`).join('')}</ol>`
    : `<p class="top5-empty">${empty}</p>`;

// ---------------------------------------------------------------- home
function home(): void {
  app.innerHTML = '';
  app.appendChild(h(`
  <main class="home">
    <header class="home-head">
      <div class="logo">a² + b² = c²</div>
      <h1>피타고라스 퍼즐 챌린지</h1>
      <p>두 정사각형의 조각을 옮겨 빗변 위의 정사각형을 채워 보세요. 10개의 라운드마다 가장 빠른 5명이 기록판에 올라갑니다!</p>
    </header>
    <div class="home-actions">
      <a class="btn big primary" href="?teacher">${ICON.users}<span>교사 화면 (QR 띄우기)</span></a>
      <a class="btn big" href="?play">${ICON.play}<span>혼자 연습하기</span></a>
    </div>
    <section class="thumbs">${LEVELS.map((l, i) => `<figure><span class="num">${i + 1}</span>${thumb(l)}<figcaption>${esc(l.title)}</figcaption></figure>`).join('')}</section>
  </main>`));
}

// ---------------------------------------------------------------- teacher
async function teacher(): Promise<void> {
  app.innerHTML = '';
  if (!online()) {
    const url = `${baseUrl()}?play`;
    app.appendChild(h(`
    <main class="teacher">
      <aside class="t-side">
        <section class="qr-panel">
          <h2>QR을 찍어 입장하세요</h2>
          <div class="qr">${qrSvg(url)}</div>
          <div class="url">${esc(url)}</div>
        </section>
      </aside>
      <section class="board-panel">
        <h2>${ICON.trophy} 라운드별 TOP 5</h2>
        <div class="notice">
          <b>현재 ‘이 기기 기록’ 모드입니다.</b><br/>
          학생들은 각자 태블릿에서 라운드를 골라 도전하고, 기록은 그 기기에만 저장됩니다.
          교사 화면에서 반 전체의 라운드별 TOP 5를 실시간으로 보려면 <code>config.js</code>에 Firebase Realtime Database 주소를 넣어 주세요 (README 참고).
        </div>
      </section>
    </main>`));
    return;
  }

  let code = store.get('pp-teacher-room');
  let exists = false;
  if (code) exists = !!(await db.get<unknown>(`rooms/${code}/meta`).catch(() => null));
  if (!code || !exists) {
    code = String(Math.floor(1000 + Math.random() * 9000));
    await db.put(`rooms/${code}/meta`, { createdAt: SERVER_TS });
    store.set('pp-teacher-room', code);
  }
  const joinUrl = `${baseUrl()}?room=${code}`;

  const root = h(`
  <main class="teacher">
    <aside class="t-side">
      <section class="qr-panel">
        <h2>QR을 찍어 입장하세요</h2>
        <div class="qr">${qrSvg(joinUrl)}</div>
        <div class="room-code">방 번호 <b>${code}</b></div>
        <div class="url">${esc(joinUrl)}</div>
        <div class="t-actions">
          <button class="btn" id="reset">기록 초기화</button>
          <button class="btn ghost" id="newroom">새 방 만들기</button>
        </div>
        <div class="t-status" id="status"></div>
      </section>
      <section class="overall-panel">
        <h3>${ICON.trophy} 10라운드 완주 순위 <small>각 라운드 최고 기록의 합</small></h3>
        <ol class="overall" id="overall"></ol>
      </section>
    </aside>
    <section class="board-panel">
      <div class="lb-head"><h2>${ICON.trophy} 라운드별 TOP 5</h2><span id="count" class="pill"></span></div>
      <div class="stage-grid" id="grid"></div>
    </section>
  </main>`);
  app.appendChild(root);
  const $ = (s: string) => root.querySelector(s) as HTMLElement;

  const prevTop = new Map<number, string>();
  let rec: Records = {};
  const render = (): void => {
    const players = Object.keys(rec.players ?? {}).length;
    $('#count').textContent = `${players}명 참여`;
    const grid = $('#grid');
    grid.innerHTML = LEVELS.map((L, i) => {
      const rows = topOf(rec, i);
      const sig = rows.map((r) => r.key + r.ms).join('|');
      const changed = prevTop.has(i) && prevTop.get(i) !== sig;
      prevTop.set(i, sig);
      return `<article class="stage-card ${changed ? 'flash' : ''}">
        <header><span class="sn">${i + 1}</span><span class="st">${esc(L.title)}</span>${thumb(L)}</header>
        ${rankList(rows, undefined, '아직 기록 없음')}
      </article>`;
    }).join('');
    const ov = overallOf(rec).slice(0, 10);
    $('#overall').innerHTML = ov.length
      ? ov.map((r, k) => `<li class="r${k + 1}"><span class="rk">${k + 1}</span><span class="nm">${esc(r.name)}</span><b>${sec(r.total)}</b></li>`).join('')
      : '<li class="empty">10라운드를 모두 깬 학생이 생기면 표시됩니다.</li>';
  };
  render();
  const stop = listen<Records>(`rooms/${code}`, (v) => {
    rec = v ?? {};
    render();
  });

  let armed = 0;
  $('#reset').onclick = async () => {
    const btn = $('#reset');
    if (Date.now() - armed > 4000) {
      armed = Date.now();
      btn.textContent = '한 번 더 누르면 삭제';
      btn.classList.add('danger');
      setTimeout(() => { btn.textContent = '기록 초기화'; btn.classList.remove('danger'); }, 4000);
      return;
    }
    armed = 0;
    await Promise.all([db.del(`rooms/${code}/stages`), db.del(`rooms/${code}/players`)]);
    btn.textContent = '기록 초기화';
    btn.classList.remove('danger');
    $('#status').textContent = '모든 기록을 지웠어요.';
    setTimeout(() => ($('#status').textContent = ''), 3000);
  };
  $('#newroom').onclick = () => {
    stop();
    store.set('pp-teacher-room', '');
    void teacher();
  };
}

// ---------------------------------------------------------------- student: stage select
async function enterRoom(code: string): Promise<void> {
  if (!online()) return stageSelect(localBackend());
  const meta = await db.get<unknown>(`rooms/${code}/meta`).catch(() => null);
  if (!meta) {
    app.innerHTML = '';
    app.appendChild(h(`<main class="join"><div class="card"><h1>방을 찾을 수 없어요</h1><p>방 번호 <b>${esc(code)}</b>를 확인하고 선생님 화면의 QR을 다시 찍어 주세요.</p></div></main>`));
    return;
  }
  stageSelect(roomBackend(code));
}

function stageSelect(be: Backend): void {
  app.innerHTML = '';
  const root = h(`
  <main class="select">
    <header class="sel-head">
      <div>
        <div class="logo">a² + b² = c²</div>
        <h1>라운드를 골라 도전하세요</h1>
        <p>라운드마다 시간을 따로 재요. 가장 빠른 <b>5명</b> 안에 들면 닉네임을 남길 수 있어요!</p>
      </div>
      <div class="sel-meta"><span class="pill">${esc(be.label)}</span><span id="me"></span></div>
    </header>
    <section class="sel-grid" id="grid"></section>
  </main>`);
  app.appendChild(root);
  const grid = root.querySelector('#grid') as HTMLElement;
  const render = (): void => {
    const me = be.rec.players?.[be.pid];
    const best = me?.best ?? {};
    const done = LEVELS.filter((_, i) => typeof best[sKey(i)] === 'number').length;
    const total = done === LEVELS.length ? LEVELS.reduce((s, _, i) => s + best[sKey(i)], 0) : null;
    (root.querySelector('#me') as HTMLElement).innerHTML =
      `<span class="pill soft">${done}/${LEVELS.length} 라운드 완료${total !== null ? ` · 합계 ${sec(total)}` : ''}</span>`;
    grid.innerHTML = LEVELS.map((L, i) => {
      const my = best[sKey(i)];
      const top = topOf(be.rec, i, 1)[0];
      return `<button class="sel-card ${my !== undefined ? 'cleared' : ''}" data-i="${i}">
        <span class="sn">${i + 1}</span>
        ${my !== undefined ? `<span class="done">${ICON.check}</span>` : ''}
        ${thumb(L)}
        <span class="st">${esc(L.title)}</span>
        <span class="info">
          <span>내 기록 <b>${my !== undefined ? sec(my) : '-'}</b></span>
          <span>1위 <b>${top ? `${sec(top.ms)}` : '-'}</b>${top ? ` <small>${esc(top.name)}</small>` : ''}</span>
        </span>
      </button>`;
    }).join('');
  };
  render();
  const unsub = be.subscribe(render);
  grid.addEventListener('click', (e) => {
    const card = (e.target as Element).closest('.sel-card') as HTMLElement | null;
    if (!card) return;
    unsub();
    playStage(be, Number(card.dataset.i));
  });
}

// ---------------------------------------------------------------- play one stage
function playStage(be: Backend, i: number): void {
  app.innerHTML = '';
  const L = LEVELS[i];
  let board: PuzzleBoard | null = null;
  let raf = 0;
  let penalty = 0;
  let t0 = Date.now() + 3200; // clock starts after the 3-2-1 countdown
  let stoppedAt: number | null = null;
  let left = false;
  const timers: number[] = [];
  const now = (): number => (stoppedAt ?? Date.now()) - t0 + penalty;

  const root = h(`
  <main class="game">
    <header class="hud">
      <button class="icon-btn" id="back" aria-label="라운드 선택으로">${ICON.grid}</button>
      <div class="stage-badge"><small>ROUND</small><b>${i + 1}</b><small>/ ${LEVELS.length}</small></div>
      <div class="title-box"><h2>${esc(L.title)} <small>${esc(L.subtitle)}</small></h2><p>${esc(L.concept)}</p></div>
      <div class="best-mini" id="bestmini"></div>
      <div class="timer" id="timer">0:00.0</div>
      <button class="icon-btn" id="snd" aria-label="소리 켜기/끄기">${sfx.muted ? ICON.mute : ICON.sound}</button>
    </header>
    <section class="stage" id="stage"></section>
    <footer class="toolbar">
      <div class="pcount"><b id="pc">0</b> / <span id="pt">0</span> 조각</div>
      <div class="tools">
        <button class="tool" id="rl" disabled>${ICON.rotL}<span>왼쪽 회전</span></button>
        <button class="tool" id="rr" disabled>${ICON.rotR}<span>오른쪽 회전</span></button>
        <button class="tool" id="hint">${ICON.hint}<span>힌트 +10초</span></button>
        <button class="tool" id="undo">${ICON.undo}<span>조각 제자리</span></button>
      </div>
    </footer>
    <div class="overlay" id="ov" hidden></div>
  </main>`);
  app.appendChild(root);
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const ov = $('#ov');

  const showBestMini = (): void => {
    const top = topOf(be.rec, i, TOP_N);
    const fifth = top.length >= TOP_N ? top[TOP_N - 1].ms : null;
    $('#bestmini').innerHTML = top.length ? `<span>1위 <b>${sec(top[0].ms)}</b></span>${fifth !== null ? `<span>5위 <b>${sec(fifth)}</b></span>` : `<span class="open">TOP 5 빈자리 있음</span>`}` : '<span class="open">첫 기록에 도전!</span>';
  };
  showBestMini();
  const unsub = be.subscribe(showBestMini);

  const leave = (to: () => void): void => {
    left = true;
    cancelAnimationFrame(raf);
    timers.forEach(clearTimeout);
    unsub();
    board?.destroy();
    to();
  };

  $('#back').onclick = () => leave(() => stageSelect(be));
  $('#snd').onclick = () => {
    sfx.muted = !sfx.muted;
    $('#snd').innerHTML = sfx.muted ? ICON.mute : ICON.sound;
  };
  $('#rl').onclick = () => board?.rotateStep(-1);
  $('#rr').onclick = () => board?.rotateStep(1);
  $('#undo').onclick = () => board?.resetLoose();
  $('#hint').onclick = () => {
    if (stoppedAt === null && Date.now() >= t0 && board?.hint()) {
      penalty += HINT_PENALTY;
      sfx.hint();
      const t = $('#timer');
      t.classList.remove('penalty');
      void t.offsetWidth;
      t.classList.add('penalty');
    }
  };

  const loop = (): void => {
    if (left) return;
    $('#timer').textContent = Date.now() < t0 ? '0:00.0' : fmt(now());
    raf = requestAnimationFrame(loop);
  };

  board = new PuzzleBoard($('#stage'), L, {
    onSelect: (s) => {
      $('#rl').toggleAttribute('disabled', !s);
      $('#rr').toggleAttribute('disabled', !s);
    },
    onPlace: (n, tot) => {
      $('#pc').textContent = String(n);
      $('#pt').textContent = String(tot);
      if (n < tot) sfx.place();
    },
    onWrong: () => sfx.wrong(),
    onMagnet: () => sfx.magnet(),
    onComplete: () => cleared(),
  });
  $('#pt').textContent = String(board.total);
  if (DEBUG) (window as unknown as { __pp: unknown }).__pp = { board, stage: i, skip: () => { while (board?.autoPlaceOne()); } };

  const cleared = (): void => {
    const ms = now();
    stoppedAt = Date.now();
    $('#timer').classList.add('paused');
    sfx.clear();
    burst($('#stage'));
    const prevBest = be.rec.players?.[be.pid]?.best?.[sKey(i)];
    const rank = be.wouldRank(i, ms);
    void be.recordClear(i, ms);
    const isPB = prevBest === undefined || ms < prevBest;
    const savedName = store.get('pp-name') ?? '';

    const top = topOf(be.rec, i);
    const fifth = top.length >= TOP_N ? top[TOP_N - 1].ms : null;
    let msg: string;
    if (rank) msg = '';
    else if (be.kind === 'room' && be.rec.stages?.[sKey(i)]?.[be.pid] && be.rec.stages[sKey(i)][be.pid].ms <= ms)
      msg = `이미 TOP 5에 더 좋은 기록(<b>${sec(be.rec.stages[sKey(i)][be.pid].ms)}</b>)이 올라가 있어요.`;
    else if (fifth !== null) msg = `TOP 5까지 <b>${sec(ms - fifth + 100)}</b> 더 빨라야 해요. 다시 도전해 볼까요?`;
    else msg = '';

    ov.hidden = false;
    ov.innerHTML = `
      <div class="clear-card">
        <div class="clear-title">ROUND ${i + 1} CLEAR!</div>
        <div class="eq">${eqText(L)}</div>
        <div class="clear-total">이번 기록 <b>${sec(ms)}</b></div>
        <div class="clear-time">${penalty ? `힌트 벌점 +${penalty / 1000}초 포함 · ` : ''}${isPB ? (prevBest === undefined ? '첫 기록이에요!' : `🎉 내 최고 기록 경신! (이전 ${sec(prevBest)})`) : `내 최고 기록 ${sec(prevBest!)}`}</div>
        ${rank ? `
        <form class="save-top" id="save">
          <div class="rank-badge">🏆 TOP 5 진입! <b>${rank}위</b> 기록이에요</div>
          <label for="nm">닉네임을 입력하고 기록을 남기세요</label>
          <div class="save-row">
            <input id="nm" maxlength="${NAME_MAX}" autocomplete="off" placeholder="예) 3번 김민준" value="${esc(savedName)}" required />
            <button class="btn primary" type="submit">저장</button>
          </div>
        </form>` : msg ? `<p class="clear-msg">${msg}</p>` : ''}
        <div class="clear-top" id="toplist">${rankList(top)}</div>
        <div class="clear-actions">
          <button class="btn" id="again">${ICON.retry}<span>다시 도전</span></button>
          <button class="btn" id="menu">${ICON.grid}<span>라운드 선택</span></button>
          ${i < LEVELS.length - 1 ? `<button class="btn primary" id="next"><span>다음 라운드 →</span></button>` : ''}
        </div>
      </div>`;
    const form = ov.querySelector('#save') as HTMLFormElement | null;
    if (form) {
      const input = form.querySelector('input') as HTMLInputElement;
      setTimeout(() => { if (!savedName) input.focus(); }, 60);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = input.value.trim().slice(0, NAME_MAX);
        if (!name) return;
        const btn = form.querySelector('button') as HTMLButtonElement;
        // others may have saved faster times meanwhile – check again with the latest list
        if (!be.wouldRank(i, ms)) {
          void be.setName(name);
          form.outerHTML = `<div class="saved late">😢 그사이 친구들이 더 빠른 기록을 남겨서 TOP 5 밖으로 밀렸어요. 다시 도전해 보세요!</div>`;
          (ov.querySelector('#toplist') as HTMLElement).innerHTML = rankList(topOf(be.rec, i));
          return;
        }
        btn.disabled = true;
        btn.textContent = '저장 중…';
        try {
          await be.saveTop(i, name, ms);
          sfx.place();
          const key = be.kind === 'room' ? be.pid : topOf(be.rec, i, 999).find((r) => r.name === name && r.ms === ms)?.key;
          // wait a moment for the live update, then redraw the list with my row highlighted
          setTimeout(() => {
            const rows = topOf(be.rec, i);
            const realRank = rows.findIndex((r) => r.key === key) + 1;
            form.outerHTML = `<div class="saved">✅ <b>${esc(name)}</b> 이름으로 ${realRank > 0 ? `<b>${realRank}위</b>에 ` : ''}저장했어요!</div>`;
            (ov.querySelector('#toplist') as HTMLElement).innerHTML = rankList(rows, key);
          }, be.kind === 'room' ? 400 : 0);
        } catch {
          btn.disabled = false;
          btn.textContent = '다시 저장';
        }
      });
    }
    (ov.querySelector('#again') as HTMLElement).onclick = () => leave(() => playStage(be, i));
    (ov.querySelector('#menu') as HTMLElement).onclick = () => leave(() => stageSelect(be));
    const next = ov.querySelector('#next') as HTMLElement | null;
    if (next) next.onclick = () => leave(() => playStage(be, i + 1));
  };

  // countdown
  const countdown = (): void => {
    if (left) return;
    const rem = t0 - Date.now();
    if (rem > 0) {
      ov.hidden = false;
      const n = Math.min(3, Math.ceil(rem / 1000));
      if (ov.dataset.n !== String(n)) {
        ov.dataset.n = String(n);
        ov.innerHTML = `<div class="count">${n}</div>`;
        sfx.tick();
      }
      timers.push(window.setTimeout(countdown, 50));
    } else {
      ov.hidden = true;
      ov.innerHTML = '';
      ov.dataset.n = '';
      t0 = Date.now();
      sfx.go();
    }
  };
  countdown();
  loop();
}

function eqText(L: LevelDef): string {
  const a = Math.round(L.a * 100) / 100;
  const b = Math.round(L.b * 100) / 100;
  if (L.a === 3 && L.b === 4) return '3² + 4² = 9 + 16 = 25 = 5²';
  if (L.a === L.b) return 'a² + a² = 2a² = c²  (c = √2·a)';
  return `a² + b² = c² &nbsp;<small>(a : b = ${a} : ${b})</small>`;
}

function burst(host: HTMLElement): void {
  const colors = ['#FFD84D', '#FF4B2B', '#3D9BFF', '#34B94A', '#F06FC6', '#7FDDF5'];
  const wrap = document.createElement('div');
  wrap.className = 'burst';
  for (let k = 0; k < 28; k++) {
    const s = document.createElement('i');
    const ang = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 180;
    s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
    s.style.setProperty('--dy', `${Math.sin(ang) * dist}px`);
    s.style.background = colors[k % colors.length];
    s.style.animationDelay = `${Math.random() * 80}ms`;
    wrap.appendChild(s);
  }
  host.appendChild(wrap);
  setTimeout(() => wrap.remove(), 1200);
}

// ---------------------------------------------------------------- router
if (params.has('teacher')) void teacher();
else if (params.get('room')) void enterRoom(params.get('room')!.replace(/\D/g, '').slice(0, 6));
else if (params.has('play')) stageSelect(localBackend());
else home();
