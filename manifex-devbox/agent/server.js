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

// ---- /__write (single-file write, non-destructive) ---------------------
//
// Phase 2B pivot-back: the Manifex-side Claude agent's write_file tool
// lands here. Unlike /__files (stage+swap whole workspace), /__write
// touches exactly one path and leaves everything else intact, so the
// agent can build the project incrementally without wiping its own
// progress.
async function handleWrite(req, res) {
  let payload;
  try {
    const body = await readBody(req, 16 * 1024 * 1024);
    payload = JSON.parse(body);
  } catch (e) {
    return jsonResponse(res, 400, { error: `invalid body: ${e.message}` });
  }
  const relPath = payload && typeof payload.path === 'string' ? payload.path : '';
  const content = payload && typeof payload.content === 'string' ? payload.content : null;
  if (!relPath) return jsonResponse(res, 400, { error: 'path required' });
  if (content === null) return jsonResponse(res, 400, { error: 'content (string) required' });

  const norm = path.posix.normalize(relPath);
  if (norm.startsWith('..') || path.isAbsolute(norm)) {
    return jsonResponse(res, 400, { error: `unsafe path: ${relPath}` });
  }
  const full = path.join(WORKSPACE, norm);
  try {
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    return jsonResponse(res, 200, { ok: true, path: norm, bytes });
  } catch (e) {
    return jsonResponse(res, 500, { error: (e && e.message) || String(e) });
  }
}

// ---- /__read (single-file read) ----------------------------------------
async function handleRead(req, res) {
  let payload;
  try {
    const body = await readBody(req, 64 * 1024);
    payload = JSON.parse(body);
  } catch (e) {
    return jsonResponse(res, 400, { error: `invalid body: ${e.message}` });
  }
  const relPath = payload && typeof payload.path === 'string' ? payload.path : '';
  const maxBytes = payload && Number.isFinite(payload.max_bytes) ? Math.max(1, Math.min(4 * 1024 * 1024, payload.max_bytes)) : 1024 * 1024;
  if (!relPath) return jsonResponse(res, 400, { error: 'path required' });

  const norm = path.posix.normalize(relPath);
  if (norm.startsWith('..') || path.isAbsolute(norm)) {
    return jsonResponse(res, 400, { error: `unsafe path: ${relPath}` });
  }
  const full = path.join(WORKSPACE, norm);
  try {
    const st = await fsp.stat(full).catch(() => null);
    if (!st) return jsonResponse(res, 200, { exists: false, content: '', bytes: 0 });
    if (!st.isFile()) return jsonResponse(res, 200, { exists: true, is_file: false, content: '', bytes: 0 });
    const fd = await fsp.open(full, 'r');
    try {
      const size = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(size);
      await fd.read(buf, 0, size, 0);
      return jsonResponse(res, 200, {
        exists: true,
        is_file: true,
        content: buf.toString('utf8'),
        bytes: size,
        truncated: st.size > maxBytes,
        total_size: st.size,
      });
    } finally {
      await fd.close();
    }
  } catch (e) {
    return jsonResponse(res, 500, { error: (e && e.message) || String(e) });
  }
}

// ---- /__ls (list files) ------------------------------------------------
async function handleLs(req, res) {
  let payload;
  try {
    const body = await readBody(req, 64 * 1024);
    payload = JSON.parse(body);
  } catch (e) {
    return jsonResponse(res, 400, { error: `invalid body: ${e.message}` });
  }
  const relPath = payload && typeof payload.path === 'string' ? payload.path : '.';
  const norm = path.posix.normalize(relPath);
  if (norm.startsWith('..') || path.isAbsolute(norm)) {
    return jsonResponse(res, 400, { error: `unsafe path: ${relPath}` });
  }
  const full = path.join(WORKSPACE, norm === '.' ? '' : norm);
  try {
    const st = await fsp.stat(full).catch(() => null);
    if (!st) return jsonResponse(res, 200, { exists: false, entries: [] });
    if (!st.isDirectory()) return jsonResponse(res, 200, { exists: true, is_dir: false, entries: [] });
    const names = await fsp.readdir(full);
    const entries = await Promise.all(names.sort().map(async name => {
      const full2 = path.join(full, name);
      const s = await fsp.stat(full2).catch(() => null);
      if (!s) return { name, type: 'unknown', size: 0 };
      return {
        name,
        type: s.isDirectory() ? 'dir' : (s.isFile() ? 'file' : 'other'),
        size: s.size,
      };
    }));
    return jsonResponse(res, 200, { exists: true, is_dir: true, entries });
  } catch (e) {
    return jsonResponse(res, 500, { error: (e && e.message) || String(e) });
  }
}

// ---- /__exec -------------------------------------------------------------
//
// Phase 2C fix: each exec captures stdout/stderr into a per-call buffer
// and returns them INLINE in the response JSON. The ring buffer is still
// fed (so /__logs SSE viewers see live progress) but the build route's
// bash tool no longer has to tail it after the fact — which previously
// leaked prior commands' output into the current command's tool_result
// and made Claude think "bash output is corrupted with file listings".
// Per-call buffers are bounded to keep response sizes sane.

const EXEC_BUFFER_CAP = 128 * 1024; // 128 KB per call — plenty for sane shell

function appendBounded(current, chunk) {
  const next = current + chunk;
  return next.length > EXEC_BUFFER_CAP ? next.slice(next.length - EXEC_BUFFER_CAP) : next;
}

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

  let stdoutBuf = '';
  let stderrBuf = '';

  child.stdout.on('data', d => {
    const s = d.toString('utf8');
    stdoutBuf = appendBounded(stdoutBuf, s);
    pushLog(s);
  });
  child.stderr.on('data', d => {
    const s = d.toString('utf8');
    stderrBuf = appendBounded(stderrBuf, s);
    pushLog(s);
  });

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
  return jsonResponse(res, 200, {
    ok: exit.code === 0,
    exit_code: exit.code,
    signal: exit.signal,
    duration_ms,
    stdout: stdoutBuf,
    stderr: stderrBuf,
  });
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

// ---- CORS ---------------------------------------------------------------
// Phase 2B Path A: the manifex-wip editor orchestrates provisioning from
// the browser (POST /__files, POST /__exec, poll /__health, SSE /__logs
// and /__events) so the editor's own Fly Machine can go idle during a
// long apt + npm build without dropping the request. The agent therefore
// has to accept cross-origin requests from https://manifex-wip.fly.dev
// (and localhost during dev). Open Origin; this box is ephemeral per
// session and only ever serves one project.
function applyCors(res, req) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, accept');
  res.setHeader('access-control-max-age', '86400');
  res.setHeader('vary', 'origin');
}

// ---- Router --------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // Apply CORS headers on every response before we branch into handlers.
  // The /* proxy path strips them back out so user-app responses don't
  // inherit wide-open CORS from the agent — only agent endpoints expose it.
  applyCors(res, req);

  // Preflight: short-circuit every OPTIONS to a 204 with the CORS headers.
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (url === '/__files' && method === 'POST') return await handleFiles(req, res);
    if (url === '/__write' && method === 'POST') return await handleWrite(req, res);
    if (url === '/__read' && method === 'POST') return await handleRead(req, res);
    if (url === '/__ls' && method === 'POST') return await handleLs(req, res);
    if (url === '/__exec' && method === 'POST') return await handleExec(req, res);
    if (url === '/__logs' && method === 'GET') return handleLogs(req, res);
    if (url === '/__events' && method === 'GET') return handleEvents(req, res);
    if (url === '/__reload' && method === 'POST') return handleEventTrigger(req, res);
    if (url === '/__health' && method === 'GET') return handleHealth(req, res);

    // Anything else proxies to the user's dev server. Strip the agent CORS
    // headers first so user-app responses don't pretend to be CORS-open.
    res.removeHeader('access-control-allow-origin');
    res.removeHeader('access-control-allow-methods');
    res.removeHeader('access-control-allow-headers');
    res.removeHeader('access-control-max-age');
    res.removeHeader('vary');
    return proxyToDevServer(req, res);
  } catch (e) {
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: (e && e.message) || String(e) });
    } else {
      try { res.end(); } catch {}
    }
  }
});

// ---- Bootstrap hook (volume-backed dev-server restart) -----------------
// Phase 2B pivot-back: Fly's auto_stop_machines setting stops idle
// devboxes to save cost. The volume at /app/workspace keeps every file
// the Claude agent wrote, but the next-dev / rails s / uvicorn / whatever
// process dies with the machine. On machine start, we re-exec whatever
// the last successful build recorded in /app/workspace/.manifex/bootstrap.sh
// so the user's iframe comes back to life in seconds without needing
// another full Claude rebuild.
//
// The build agent's system prompt instructs Claude to write this file
// at the end of a successful build, containing the exact nohup command
// it used to launch the dev server. We just bash it, detached, and
// stream its stdout into the ring buffer so the editor log panel can
// tail the restart.
function runBootstrap() {
  const bootstrap = path.join(WORKSPACE, '.manifex', 'bootstrap.sh');
  if (!fs.existsSync(bootstrap)) {
    console.log('[devbox-agent] no bootstrap.sh — waiting for first build');
    return;
  }
  console.log('[devbox-agent] running .manifex/bootstrap.sh');
  pushLog('\n[agent] machine started — running .manifex/bootstrap.sh\n');
  try {
    const child = spawn('bash', [bootstrap], {
      cwd: WORKSPACE,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout.on('data', d => pushLog(d.toString('utf8')));
    child.stderr.on('data', d => pushLog(d.toString('utf8')));
    child.on('exit', (code, signal) => {
      pushLog(`\n[agent] bootstrap.sh exit ${code}${signal ? ' ' + signal : ''}\n`);
    });
    child.unref();
  } catch (e) {
    pushLog(`[agent] bootstrap failed: ${e && e.message}\n`);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[devbox-agent] listening on :${PORT}, workspace ${WORKSPACE}`);
  // Fire-and-forget on startup. Bootstrap should be a background launcher,
  // not a blocking script — if Claude wrote something that blocks, the
  // agent stays up anyway because this is detached.
  setTimeout(runBootstrap, 200);
});
