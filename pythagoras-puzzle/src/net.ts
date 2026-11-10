/**
 * Tiny Firebase Realtime Database client using the REST + Server-Sent-Events API.
 * No SDK / no build-time dependency: only the database URL from config.js is needed.
 */

declare global {
  interface Window {
    PUZZLE_CONFIG?: { firebaseDatabaseURL?: string };
  }
}

export const dbUrl = (): string | null => {
  const u = window.PUZZLE_CONFIG?.firebaseDatabaseURL?.trim();
  if (!u || u.includes('YOUR-PROJECT')) return null;
  return u.replace(/\/+$/, '');
};
export const online = (): boolean => dbUrl() !== null;

const url = (path: string): string => `${dbUrl()}/${path.replace(/^\/+/, '')}.json`;

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(url(path), {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Firebase ${method} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const db = {
  get: <T>(path: string) => req<T>('GET', path),
  put: <T>(path: string, v: unknown) => req<T>('PUT', path, v),
  patch: <T>(path: string, v: unknown) => req<T>('PATCH', path, v),
  del: (path: string) => req<null>('DELETE', path),
};

export const SERVER_TS = { '.sv': 'timestamp' };

/** offset (ms) to add to Date.now() to approximate Firebase server time */
export async function serverOffset(): Promise<number> {
  try {
    const t0 = Date.now();
    const key = `clock/${Math.random().toString(36).slice(2, 10)}`;
    const v = await db.put<number>(key, SERVER_TS);
    const t1 = Date.now();
    void db.del(key).catch(() => undefined);
    return typeof v === 'number' ? v - (t0 + t1) / 2 : 0;
  } catch {
    return 0;
  }
}

type Json = unknown;
function setAt(root: Json, path: string, data: Json): Json {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return data;
  const base: Record<string, Json> = root && typeof root === 'object' ? { ...(root as Record<string, Json>) } : {};
  const [head, ...rest] = parts;
  const child = setAt(base[head], rest.join('/'), data);
  if (child === null || child === undefined) delete base[head];
  else base[head] = child;
  return base;
}

/** Live subscription. Calls `cb` with the full (merged) value whenever it changes. */
export function listen<T>(path: string, cb: (v: T | null) => void, onError?: () => void): () => void {
  let state: Json = null;
  const es = new EventSource(url(path));
  const handle = (kind: 'put' | 'patch') => (e: MessageEvent) => {
    const msg = JSON.parse(e.data) as { path: string; data: Json };
    if (kind === 'put') state = setAt(state, msg.path, msg.data);
    else if (msg.data && typeof msg.data === 'object') {
      for (const [k, v] of Object.entries(msg.data as Record<string, Json>)) state = setAt(state, `${msg.path}/${k}`, v);
    }
    cb(state as T | null);
  };
  es.addEventListener('put', handle('put') as EventListener);
  es.addEventListener('patch', handle('patch') as EventListener);
  es.addEventListener('error', () => onError?.());
  return () => es.close();
}
