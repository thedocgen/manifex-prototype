// Manifex devbox agent (Phase 2B).
//
// One per Manifex session. Runs on a blank Ubuntu 24.04 box. Node is present
// only to host this file. Everything else (frameworks, dev servers, package
// managers if not preinstalled, databases) gets installed by the setup.sh the
// editor's compiler emits and POSTs to /__exec.
//
// Endpoints:
//   POST /__files   { "path/in/workspace": "content", ... }
//                   Atomic full overwrite of /app/workspace. Wipes the
//                   workspace first so stale files from a previous build
//                   never linger.
//   POST /__exec    { cmd, cwd?, env?, detach? }
//                   Runs cmd via bash -lc. Streams stdout/stderr into the
//                   in-memory log ring AND broadcasts to /__logs SSE
//                   subscribers in real time. Synchronous response (waits
//                   for exit) unless detach=true, in which case it returns
//                   immediately with a process id.
//   GET  /__logs    SSE stream of build output. Replays the current ring
//                   buffer on connect, then live-tails new lines.
//   GET  /__events  SSE reload bridge — editor's iframe subscribes and the
//                   render route fires { event: "reload" } when a new
//                   build is ready.
//   GET  /__health  { ok, dev_running, dev_port, last_exit }
//   GET  /*         Proxy to localhost:<dev_port> where dev_port is read
//                   live from /app/workspace/.manifex-port (default 3000).
//                   On ECONNREFUSED, returns the stub "Building your app…"
//                   page with the reload bridge so the iframe auto-recovers
//                   once the dev server comes up.
//
// Zero npm deps on purpose. Everything is stdlib so the image stays small
// and the agent has no install step beyond `apt-get install -y nodejs`.

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.AGENT_PORT || process.env.PORT || '8080', 10);
const WORKSPACE = '/app/workspace';
const PORT_FILE = path.join(WORKSPACE, '.manifex-port');
const DEFAULT_DEV_PORT = 3000;

// ---- Log ring buffer + SSE subscribers ----------------------------------
const LOG_RING_BYTES = 1_000_000; // ~1MB cap
let logBuffer = ''; // simple append-then-trim; cheap enough at this size
const logSubs = new Set();
const reloadSubs = new Set();
let lastExit = null;
let runningProc = null;

function pushLog(line) {
  logBuffer += line;
  if (logBuffer.length > LOG_RING_BYTES) {
    logBuffer = logBuffer.slice(logBuffer.length - LOG_RING_BYTES);
  }
  const payload = `data: ${JSON.stringify(line)}\n\n`;
  for (const res of logSubs) {
    try { res.write(payload); } catch {}
  }
}

function resetLogs() {
  logBuffer = '';
  for (const res of logSubs) {
    try { res.write(`event: reset\ndata: {}\n\n`); } catch {}
  }
}

function broadcastReload() {
  const payload = `event: reload\ndata: {}\n\n`;
  for (const res of reloadSubs) {
    try { res.write(payload); } catch {}
  }
}

// ---- HTTP body helper ----------------------------------------------------
function readBody(req, capBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > capBytes) {
        req.destroy();
        reject(new Error(`body too large (>${capBytes} bytes)`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonResponse(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---- /__files ------------------------------------------------------------
async function handleFiles(req, res) {
  let payload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body);
  } catch (e) {
    return jsonResponse(res, 400, { error: `invalid body: ${e.message}` });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse(res, 400, { error: 'body must be a JSON object of {path: content}' });
  }

  // Stage in a sibling dir then atomically swap. This guarantees the dev
  // server never sees a half-written workspace if the request is interrupted.
  const stageId = crypto.randomBytes(8).toString('hex');
  const stage = `/app/.stage-${stageId}`;
  await fsp.mkdir(stage, { recursive: true });

  let written = 0;
  for (const [relPath, content] of Object.entries(payload)) {
    if (typeof content !== 'string') {
      return jsonResponse(res, 400, { error: `value for ${relPath} must be a string` });
    }
    const norm = path.posix.normalize(relPath);
    if (norm.startsWith('..') || path.isAbsolute(norm)) {
      return jsonResponse(res, 400, { error: `unsafe path: ${relPath}` });
    }
    const full = path.join(stage, norm);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, 'utf8');
    written++;
  }

  // Swap. Remove old workspace then rename stage in. Cheap because both are
  // on the same filesystem.
  await fsp.rm(WORKSPACE, { recursive: true, force: true });
  await fsp.rename(stage, WORKSPACE);

  resetLogs();
  return jsonResponse(res, 200, { ok: true, files: written });
}

// ---- /__exec -------------------------------------------------------------
async function handleExec(req, res) {
  let payload;
  try {
    const body = await readBody(req, 256 * 1024);
    payload = JSON.parse(body);
  } catch (e) {
    return jsonResponse(res, 400, { error: `invalid body: ${e.message}` });
  }
  const { cmd, cwd, env, detach } = payload || {};
  if (typeof cmd !== 'string' || !cmd.trim()) {
    return jsonResponse(res, 400, { error: 'cmd (non-empty string) required' });
  }

  const childCwd = cwd || WORKSPACE;
  const childEnv = { ...process.env, ...(env || {}) };
  pushLog(`\n$ ${cmd}\n`);

  const child = spawn('bash', ['-lc', cmd], {
    cwd: childCwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', d => pushLog(d.toString('utf8')));
  child.stderr.on('data', d => pushLog(d.toString('utf8')));

  if (detach) {
    // Long-running command (e.g. `bash run.sh` for the dev server). Don't
    // wait for exit — return immediately. Track it so /__health can report.
    runningProc = child;
    child.on('exit', (code, signal) => {
      lastExit = { code, signal, at: new Date().toISOString(), cmd };
      pushLog(`\n[exit ${code}${signal ? ' ' + signal : ''}]\n`);
      if (runningProc === child) runningProc = null;
    });
    child.unref();
    return jsonResponse(res, 200, { ok: true, detached: true, pid: child.pid });
  }

  const started = Date.now();
  const exit = await new Promise(resolve => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const duration_ms = Date.now() - started;
  lastExit = { code: exit.code, signal: exit.signal, at: new Date().toISOString(), cmd };
  pushLog(`\n[exit ${exit.code}${exit.signal ? ' ' + exit.signal : ''} in ${duration_ms}ms]\n`);
  return jsonResponse(res, 200, { ok: exit.code === 0, exit_code: exit.code, signal: exit.signal, duration_ms });
}

// ---- /__logs (SSE) -------------------------------------------------------
function handleLogs(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  if (logBuffer) {
    res.write(`data: ${JSON.stringify(logBuffer)}\n\n`);
  }
  logSubs.add(res);
  req.on('close', () => logSubs.delete(res));
}

// ---- /__events (reload SSE) ---------------------------------------------
function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  reloadSubs.add(res);
  req.on('close', () => reloadSubs.delete(res));
}

// ---- /__events trigger (POST) -------------------------------------------
function handleEventTrigger(req, res) {
  // Tiny convenience for the editor's render route to fire a reload without
  // having to manage its own SSE channel. POST /__reload -> broadcast.
  broadcastReload();
  return jsonResponse(res, 200, { ok: true, subscribers: reloadSubs.size });
}

// ---- /__health -----------------------------------------------------------
function readDevPort() {
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf8').trim();
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return DEFAULT_DEV_PORT;
}

function handleHealth(req, res) {
  return jsonResponse(res, 200, {
    ok: true,
    dev_running: runningProc != null,
    dev_port: readDevPort(),
    last_exit: lastExit,
    log_bytes: logBuffer.length,
  });
}

// ---- Stub HTML for "dev server not up yet" ------------------------------
const RELOAD_BRIDGE = `<script>(function(){try{var es=new EventSource('/__events');es.addEventListener('reload',function(){location.reload();});}catch(e){}})();</script>`;
const STUB_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Building…</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8fafc;color:#475569;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{text-align:center}.dot{width:8px;height:8px;border-radius:50%;background:#3b82f6;display:inline-block;margin-right:8px;animation:pulse 1.6s ease-in-out infinite}@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}.hint{margin-top:1em;font-size:13px;color:#94a3b8}</style>
</head><body><div class="box"><div><span class="dot"></span>Building your app…</div><div class="hint">Watching for the dev server. This page reloads automatically.</div></div>${RELOAD_BRIDGE}</body></html>`;

// ---- Proxy ---------------------------------------------------------------
function proxyToDevServer(req, res) {
  const devPort = readDevPort();
  const opts = {
    hostname: '127.0.0.1',
    port: devPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${devPort}` },
  };
  const proxyReq = http.request(opts, proxyRes => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', err => {
    if (err && (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENOTFOUND')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(STUB_HTML);
      return;
    }
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`devbox proxy error: ${err.message}`);
  });
  req.pipe(proxyReq);
}

// ---- Router --------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  try {
    if (url === '/__files' && method === 'POST') return await handleFiles(req, res);
    if (url === '/__exec' && method === 'POST') return await handleExec(req, res);
    if (url === '/__logs' && method === 'GET') return handleLogs(req, res);
    if (url === '/__events' && method === 'GET') return handleEvents(req, res);
    if (url === '/__reload' && method === 'POST') return handleEventTrigger(req, res);
    if (url === '/__health' && method === 'GET') return handleHealth(req, res);

    // Anything else proxies to the user's dev server.
    return proxyToDevServer(req, res);
  } catch (e) {
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: (e && e.message) || String(e) });
    } else {
      try { res.end(); } catch {}
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[devbox-agent] listening on :${PORT}, workspace ${WORKSPACE}`);
});
