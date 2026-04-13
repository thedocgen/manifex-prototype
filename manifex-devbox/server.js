// Manifex devbox HTTP server.
//
// One of these runs per Manifex session. The editor's render route POSTs the
// compiled HTML to /__sync; the iframe loaded from / subscribes to /__events
// and reloads when it receives a "reload" message.
//
// Phase 2A — Path A: serves a single index.html blob from disk. Path B will
// replace this with a real Next.js dev server.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = '/app/data';
const HTML_PATH = path.join(DATA_DIR, 'index.html');

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// Tiny client-side reload bridge injected into every served page.
const RELOAD_BRIDGE = `<script>
(function(){
  try {
    var es = new EventSource('/__events');
    es.addEventListener('reload', function(){ location.reload(); });
  } catch (e) {}
})();
</script>`;

const STUB_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Waiting for build</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8fafc;color:#475569;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.dot{width:8px;height:8px;border-radius:50%;background:#3b82f6;display:inline-block;margin-right:8px;animation:pulse 1.6s ease-in-out infinite}@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}</style>
</head><body><div><span class="dot"></span>Waiting for the first build…</div>${RELOAD_BRIDGE}</body></html>`;

// SSE subscriber set. Each entry is a ServerResponse we can write to.
const subscribers = new Set();

function broadcastReload() {
  const payload = `event: reload\ndata: {}\n\n`;
  for (const res of subscribers) {
    try { res.write(payload); } catch {}
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function injectBridge(html) {
  if (html.includes('</body>')) return html.replace('</body>', `${RELOAD_BRIDGE}</body>`);
  return html + RELOAD_BRIDGE;
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  if (url === '/__events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    subscribers.add(res);
    req.on('close', () => { subscribers.delete(res); });
    return;
  }

  if (url === '/__sync' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      if (typeof data.html !== 'string' || data.html.length === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'html (string) required' }));
        return;
      }
      fs.writeFileSync(HTML_PATH, data.html, 'utf8');
      broadcastReload();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bytes: data.html.length, subscribers: subscribers.size }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (e && e.message) || String(e) }));
    }
    return;
  }

  if (url === '/__health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, has_html: fs.existsSync(HTML_PATH), subscribers: subscribers.size }));
    return;
  }

  // Default: serve the current html (or stub) with the reload bridge injected.
  if (req.method === 'GET' || req.method === 'HEAD') {
    let html;
    try { html = fs.readFileSync(HTML_PATH, 'utf8'); }
    catch { html = STUB_HTML; }
    if (!html.includes('/__events')) html = injectBridge(html);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[devbox] listening on :${PORT}, data dir ${DATA_DIR}`);
});
