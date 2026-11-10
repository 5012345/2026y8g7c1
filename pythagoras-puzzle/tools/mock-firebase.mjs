// Local mock of the Firebase Realtime Database REST + SSE API (for offline testing).
// Usage: node tools/mock-firebase.mjs 9000   → set config.js URL to http://localhost:9000
import http from 'node:http';

const port = Number(process.argv[2] || 9000);
let root = {};
const subs = new Set(); // {path, res}

const parts = (p) => p.split('/').filter(Boolean);
const getAt = (p) => parts(p).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), root) ?? null;
const resolveTs = (v) => {
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return Date.now();
    const o = Array.isArray(v) ? [] : {};
    for (const [k, x] of Object.entries(v)) o[k] = resolveTs(x);
    return o;
  }
  return v;
};
const setAt = (p, v) => {
  const ks = parts(p);
  if (!ks.length) { root = v ?? {}; return; }
  let o = root;
  for (const k of ks.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  const last = ks[ks.length - 1];
  if (v === null || v === undefined) delete o[last]; else o[last] = v;
};
const notify = (changed) => {
  for (const s of subs) {
    const sp = '/' + parts(s.path).join('/');
    const cp = '/' + parts(changed).join('/');
    if (cp.startsWith(sp)) {
      const rel = cp.slice(sp.length) || '/';
      s.res.write(`event: put\ndata: ${JSON.stringify({ path: rel, data: getAt(changed) })}\n\n`);
    } else if (sp.startsWith(cp)) {
      s.res.write(`event: put\ndata: ${JSON.stringify({ path: '/', data: getAt(s.path) })}\n\n`);
    }
  }
};

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/\.json$/, ''));
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/event-stream')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: put\ndata: ${JSON.stringify({ path: '/', data: getAt(path) })}\n\n`);
    const s = { path, res };
    subs.add(s);
    req.on('close', () => subs.delete(s));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify(getAt(path)));
    const v = body ? resolveTs(JSON.parse(body)) : null;
    if (req.method === 'PUT') { setAt(path, v); notify(path); return res.end(JSON.stringify(v)); }
    if (req.method === 'PATCH') { for (const [k, x] of Object.entries(v)) { setAt(`${path}/${k}`, x); notify(`${path}/${k}`); } return res.end(JSON.stringify(v)); }
    if (req.method === 'DELETE') { setAt(path, null); notify(path); return res.end('null'); }
    res.statusCode = 405; res.end();
  });
}).listen(port, () => console.log('mock firebase on', port));
