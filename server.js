// Born Scope Lab — tiny Railway server (no dependencies, Node 18+)
// Env vars:
//   ANTHROPIC_API_KEY  optional — enables the "Use AI" features via /api/ai
//   APP_PASSWORD       optional — if set, the whole app sits behind a browser password prompt
//   AI_MODELS          optional — comma-separated allowlist (default: claude-sonnet-5-5,claude-haiku-5-5,claude-opus-5-5)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PASS = process.env.APP_PASSWORD || '';
const MODELS = (process.env.AI_MODELS || 'claude-sonnet-5-5,claude-haiku-5-5,claude-opus-5-5').split(',').map(s => s.trim());

function authed(req) {
  if (!PASS) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pw] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return pw === PASS;
}

http.createServer((req, res) => {
  if (!authed(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Scope Lab"' });
    return res.end('Password required');
  }

  if (req.method === 'POST' && req.url === '/api/ai') {
    if (!process.env.ANTHROPIC_API_KEY) {
      res.writeHead(501, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set on server' }));
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body);
        const payload = {
          model: MODELS.includes(j.model) ? j.model : MODELS[0],
          max_tokens: Math.min(+j.max_tokens || 2000, 4000),
          system: j.system,
          messages: j.messages,
        };
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(payload),
        });
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(await r.text());
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET') {
    return fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(data);
    });
  }

  res.writeHead(405); res.end();
}).listen(PORT, () => console.log('Scope Lab on :' + PORT));
