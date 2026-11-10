// Born Scope — Railway server (Node 18+)
// Shared storage: every visitor reads/writes the same data on the server.
// Env vars:
//   DATABASE_URL       Postgres connection (add Railway Postgres and reference it). Recommended.
//   DATA_DIR           Fallback file storage folder (use a Railway volume). Without either, data is lost on redeploy.
//   ANTHROPIC_API_KEY  optional — enables AI via /api/ai
//   APP_PASSWORD       optional — password-protects the whole site
//   AI_MODELS          optional — comma-separated model allowlist
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PASS = process.env.APP_PASSWORD || '';
const MODELS = (process.env.AI_MODELS || 'claude-sonnet-5-5,claude-haiku-5-5,claude-opus-5-5').split(',').map(s => s.trim());
const KINDS = new Set(['config', 'scope', 'past']);

/* ---------------- storage ---------------- */
let clock = 0;
const tick = () => (clock = Math.max(clock + 1, Date.now()));
let store;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const ssl = /localhost|127\.0\.0\.1|\/tmp|railway\.internal/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  store = {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS scope_records (
        kind TEXT NOT NULL, id TEXT NOT NULL, data JSONB, deleted BOOLEAN NOT NULL DEFAULT FALSE,
        updated BIGINT NOT NULL, PRIMARY KEY (kind, id))`);
      await pool.query('CREATE INDEX IF NOT EXISTS scope_records_updated ON scope_records(updated)');
      const r = await pool.query('SELECT COALESCE(MAX(updated),0) AS m FROM scope_records');
      clock = Math.max(clock, +r.rows[0].m);
    },
    async since(ts) {
      const r = await pool.query('SELECT kind,id,data,deleted,updated FROM scope_records WHERE updated > $1 ORDER BY updated', [ts]);
      return r.rows.map(x => ({ ...x, updated: +x.updated }));
    },
    async write(upserts, deletes) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        for (const u of upserts) await c.query(`INSERT INTO scope_records(kind,id,data,deleted,updated) VALUES($1,$2,$3,false,$4)
          ON CONFLICT (kind,id) DO UPDATE SET data=EXCLUDED.data, deleted=false, updated=EXCLUDED.updated`, [u.kind, u.id, JSON.stringify(u.data), tick()]);
        for (const d of deletes) await c.query(`INSERT INTO scope_records(kind,id,data,deleted,updated) VALUES($1,$2,NULL,true,$3)
          ON CONFLICT (kind,id) DO UPDATE SET data=NULL, deleted=true, updated=EXCLUDED.updated`, [d.kind, d.id, tick()]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    },
  };
} else {
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const file = path.join(dir, 'scope-data.json');
  let recs = {};
  const persist = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(recs)); fs.renameSync(tmp, file); };
  store = {
    kind: process.env.DATA_DIR ? 'file' : 'file-temporary',
    async init() {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file)) recs = JSON.parse(fs.readFileSync(file, 'utf8'));
      clock = Math.max(clock, ...Object.values(recs).map(r => r.updated), 0);
      if (!process.env.DATA_DIR) console.warn('WARNING: no DATABASE_URL or DATA_DIR — data will be lost on redeploy.');
    },
    async since(ts) { return Object.values(recs).filter(r => r.updated > ts).sort((a, b) => a.updated - b.updated); },
    async write(upserts, deletes) {
      for (const u of upserts) recs[u.kind + ':' + u.id] = { kind: u.kind, id: u.id, data: u.data, deleted: false, updated: tick() };
      for (const d of deletes) recs[d.kind + ':' + d.id] = { kind: d.kind, id: d.id, data: null, deleted: true, updated: tick() };
      persist();
    },
  };
}

/* ---------------- http ---------------- */
function authed(req) {
  if (!PASS) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  return Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') === PASS;
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req, limit) => new Promise((ok, bad) => { let b = ''; req.on('data', c => { b += c; if (b.length > limit) { bad(new Error('too large')); req.destroy(); } }); req.on('end', () => ok(b)); req.on('error', bad); });
const validRec = r => r && KINDS.has(r.kind) && typeof r.id === 'string' && r.id.length < 100;

const server = http.createServer(async (req, res) => {
  if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Born Scope"' }); return res.end('Password required'); }
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const since = +url.searchParams.get('since') || 0;
      return json(res, 200, { now: clock, storage: store.kind, records: await store.since(since) });
    }
    if (req.method === 'POST' && url.pathname === '/api/records') {
      const body = JSON.parse(await readBody(req, 25e6));
      const ups = (body.upserts || []).filter(validRec), dels = (body.deletes || []).filter(validRec);
      await store.write(ups, dels);
      return json(res, 200, { now: clock, storage: store.kind });
    }
    if (req.method === 'POST' && url.pathname === '/api/ai') {
      if (!process.env.ANTHROPIC_API_KEY) return json(res, 501, { error: 'ANTHROPIC_API_KEY not set on server' });
      const j = JSON.parse(await readBody(req, 2e6));
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODELS.includes(j.model) ? j.model : MODELS[0], max_tokens: Math.min(+j.max_tokens || 2000, 8000), system: j.system, messages: j.messages }),
      });
      res.writeHead(r.status, { 'content-type': 'application/json' });
      return res.end(await r.text());
    }
    if (req.method === 'GET') {
      return fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
        if (err) { res.writeHead(500); return res.end('index.html missing'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(data);
      });
    }
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
});

store.init().then(() => server.listen(PORT, () => console.log(`Born Scope on :${PORT} (storage: ${store.kind})`)))
  .catch(e => { console.error('Storage init failed:', e); process.exit(1); });
