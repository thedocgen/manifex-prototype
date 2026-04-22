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
const net = require('net');
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

// ==== /agent/task/* — background task primitives =========================
//
// This box runs a plain Node service — NO LLM, NO Anthropic API, NO Claude
// SDK. All intelligence lives server-side in Manifex; the box service just
// receives task definitions over HTTP and spawns them as child processes.
// The /agent/ URL namespace is naming convention only (agent task = task
// the agent system delegated to this box) — no inference happens here.
//
// Long-running commands (e.g. `npm ci`) can exceed Fly's ~5-min HTTP edge
// proxy ceiling, so /__exec isn't usable end-to-end for slow installs. The
// task protocol decouples the HTTP surface from the child process: every
// call to this service is short, and a spawned command runs independently
// of whichever HTTP request kicked it off.
//
// Lifecycle:
//   POST /agent/task/run           → { task_id, started_at }  (immediate)
//   GET  /agent/task/{id}          → status snapshot
//   GET  /agent/task/{id}/events   → SSE stream of stdout/stderr + terminal
//   POST /agent/task/{id}/cancel   → SIGTERM + SIGKILL-after-5s
//   GET  /agent/tasks              → list of in-memory tasks
//
// Each task dir (/tmp/agent-tasks/<id>/) holds stdout.log, stderr.log,
// meta.json. meta.json is the post-restart source of truth: if the agent
// is restarted mid-task, /agent/task/{id} reads it and reports
// state='unknown' (child process is gone, logs remain). v1 doesn't try to
// resurrect or clean up old task dirs — tasks accumulate until the machine
// is destroyed, which is per-session anyway.

const TASK_ROOT = '/tmp/agent-tasks';
const TASK_ID_RE = /^[a-f0-9]{16}$/;
const TASK_REPLAY_CAP_BYTES = 256 * 1024; // in-memory replay buffer per task

const tasks = new Map(); // task_id → runtime task record (see newTask())

try { fs.mkdirSync(TASK_ROOT, { recursive: true }); } catch {}

function newTaskId() {
  return crypto.randomBytes(8).toString('hex'); // 16 hex chars
}

function appendReplay(task, kind, chunk) {
  task.replay.push({ kind, chunk });
  task.replayBytes += chunk.length;
  while (task.replayBytes > TASK_REPLAY_CAP_BYTES && task.replay.length > 0) {
    const dropped = task.replay.shift();
    task.replayBytes -= dropped.chunk.length;
  }
}

function emitToSubs(task, kind, chunk) {
  const payload = `data: ${JSON.stringify({ kind, chunk })}\n\n`;
  for (const res of task.subs) {
    try { res.write(payload); } catch {}
  }
}

function emitTerminalToSubs(task) {
  const kind = task.state === 'canceled' ? 'canceled' : 'done';
  const payload = `data: ${JSON.stringify({
    kind,
    exit_code: task.exit_code,
    signal: task.signal,
  })}\n\n`;
  for (const res of task.subs) {
    try { res.write(payload); res.end(); } catch {}
  }
  task.subs.clear();
}

async function writeTaskMeta(task) {
  const meta = {
    id: task.id,
    pid: task.pid,
    state: task.state,
    cmd: task.cmd,
    workdir: task.workdir,
    env: task.env,
    started_at: task.started_at,
    finished_at: task.finished_at,
    exit_code: task.exit_code,
    signal: task.signal,
  };
  try {
    await fsp.writeFile(task.metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  } catch {}
}

async function loadTaskMetaFromDisk(id) {
  try {
    const raw = await fsp.readFile(path.join(TASK_ROOT, id, 'meta.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function cancelTask(task) {
  if (task.state !== 'running') return;
  try { task.child.kill('SIGTERM'); } catch {}
  // If the child hasn't died in 5s, escalate. We do NOT change state to
  // 'canceled' yet — the exit handler does that when the process actually
  // exits, so status/events reflect reality rather than intent.
  task.killTimeout = setTimeout(() => {
    try { task.child.kill('SIGKILL'); } catch {}
  }, 5000);
}

async function handleTaskRun(req, res) {
  let payload;
  try {
    const body = await readBody(req, 256 * 1024);
    payload = JSON.parse(body);
  } catch (e) {
    return jsonResponse(res, 400, { error: `invalid body: ${e.message}` });
  }
  const { cmd, workdir, env, timeout_s } = payload || {};
  if (typeof cmd !== 'string' || !cmd.trim()) {
    return jsonResponse(res, 400, { error: 'cmd (non-empty string) required' });
  }
  const childCwd = workdir || WORKSPACE;
  const childEnv = { ...process.env, ...(env || {}) };

  const id = newTaskId();
  const dir = path.join(TASK_ROOT, id);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    return jsonResponse(res, 500, { error: `mkdir task dir: ${e.message}` });
  }
  const stdoutPath = path.join(dir, 'stdout.log');
  const stderrPath = path.join(dir, 'stderr.log');
  const metaPath = path.join(dir, 'meta.json');
  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'w' });
  const stderrStream = fs.createWriteStream(stderrPath, { flags: 'w' });

  const started_at = new Date().toISOString();
  const child = spawn('bash', ['-lc', cmd], {
    cwd: childCwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const task = {
    id,
    pid: child.pid,
    state: 'running',
    cmd,
    workdir: childCwd,
    env: env || {},
    started_at,
    finished_at: null,
    exit_code: null,
    signal: null,
    child,
    subs: new Set(),
    replay: [],
    replayBytes: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutStream,
    stderrStream,
    metaPath,
    timeoutHandle: null,
    killTimeout: null,
  };
  tasks.set(id, task);

  child.stdout.on('data', d => {
    const s = d.toString('utf8');
    task.stdoutBytes += s.length;
    appendReplay(task, 'stdout', s);
    try { stdoutStream.write(s); } catch {}
    emitToSubs(task, 'stdout', s);
  });
  child.stderr.on('data', d => {
    const s = d.toString('utf8');
    task.stderrBytes += s.length;
    appendReplay(task, 'stderr', s);
    try { stderrStream.write(s); } catch {}
    emitToSubs(task, 'stderr', s);
  });

  child.on('exit', (code, signal) => {
    task.finished_at = new Date().toISOString();
    task.exit_code = code;
    task.signal = signal;
    // If we SIGTERM'd/SIGKILL'd via cancelTask (killTimeout set), mark
    // canceled. Otherwise mark done regardless of exit code — a non-zero
    // exit is still "done", the caller reads exit_code.
    if (task.killTimeout) {
      task.state = 'canceled';
      clearTimeout(task.killTimeout);
      task.killTimeout = null;
    } else {
      task.state = 'done';
    }
    try { stdoutStream.end(); } catch {}
    try { stderrStream.end(); } catch {}
    if (task.timeoutHandle) {
      clearTimeout(task.timeoutHandle);
      task.timeoutHandle = null;
    }
    writeTaskMeta(task);
    emitTerminalToSubs(task);
  });

  if (Number.isFinite(timeout_s) && timeout_s > 0) {
    task.timeoutHandle = setTimeout(() => {
      if (task.state === 'running') cancelTask(task);
    }, timeout_s * 1000);
  }

  await writeTaskMeta(task);
  return jsonResponse(res, 200, { task_id: id, started_at });
}

async function handleTaskStatus(req, res, id) {
  const task = tasks.get(id);
  if (task) {
    return jsonResponse(res, 200, {
      id: task.id,
      state: task.state,
      pid: task.pid,
      exit_code: task.exit_code,
      signal: task.signal,
      started_at: task.started_at,
      finished_at: task.finished_at,
      stdout_bytes: task.stdoutBytes,
      stderr_bytes: task.stderrBytes,
    });
  }
  const meta = await loadTaskMetaFromDisk(id);
  if (!meta) return jsonResponse(res, 404, { error: 'task not found' });
  // Agent was restarted; the child process is gone. Report 'unknown' for
  // tasks that were 'running' at meta write time — caller shouldn't
  // interpret that as in-progress.
  return jsonResponse(res, 200, {
    id: meta.id,
    state: meta.state === 'running' ? 'unknown' : meta.state,
    pid: meta.pid,
    exit_code: meta.exit_code,
    signal: meta.signal,
    started_at: meta.started_at,
    finished_at: meta.finished_at,
    stdout_bytes: 0,
    stderr_bytes: 0,
  });
}

async function handleTaskEvents(req, res, id) {
  const task = tasks.get(id);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  if (!task) {
    // Agent restart case or unknown id — replay from disk if it exists.
    const stdoutBuf = await fsp.readFile(path.join(TASK_ROOT, id, 'stdout.log'), 'utf8').catch(() => null);
    const stderrBuf = await fsp.readFile(path.join(TASK_ROOT, id, 'stderr.log'), 'utf8').catch(() => null);
    const meta = await loadTaskMetaFromDisk(id);
    if (stdoutBuf === null && stderrBuf === null && !meta) {
      res.write(`data: ${JSON.stringify({ kind: 'error', message: 'task not found' })}\n\n`);
      try { res.end(); } catch {}
      return;
    }
    if (stdoutBuf) res.write(`data: ${JSON.stringify({ kind: 'stdout', chunk: stdoutBuf })}\n\n`);
    if (stderrBuf) res.write(`data: ${JSON.stringify({ kind: 'stderr', chunk: stderrBuf })}\n\n`);
    if (meta) {
      const kind = meta.state === 'canceled' ? 'canceled' : 'done';
      res.write(`data: ${JSON.stringify({ kind, exit_code: meta.exit_code, signal: meta.signal })}\n\n`);
    }
    try { res.end(); } catch {}
    return;
  }

  // In-memory task: replay the bounded in-memory log (synchronous), then
  // subscribe for live chunks. Synchronous sequencing guarantees no child
  // 'data' handler fires between snapshot and subscribe — the event loop
  // delivers both on future ticks. A new sub therefore sees every byte
  // from the replay snapshot forward with no duplicates or gaps.
  for (const entry of task.replay) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  if (task.state !== 'running') {
    // Task already finished before SSE arrived — send terminal and close.
    const kind = task.state === 'canceled' ? 'canceled' : 'done';
    res.write(`data: ${JSON.stringify({ kind, exit_code: task.exit_code, signal: task.signal })}\n\n`);
    try { res.end(); } catch {}
    return;
  }
  task.subs.add(res);
  req.on('close', () => task.subs.delete(res));
}

async function handleTaskCancel(req, res, id) {
  const task = tasks.get(id);
  if (!task) return jsonResponse(res, 404, { error: 'task not found' });
  if (task.state !== 'running') {
    return jsonResponse(res, 200, { ok: true, already: task.state });
  }
  cancelTask(task);
  return jsonResponse(res, 200, { ok: true, state: 'canceling' });
}

function handleTaskList(req, res) {
  const out = [];
  for (const task of tasks.values()) {
    out.push({
      id: task.id,
      pid: task.pid,
      state: task.state,
      cmd: task.cmd,
      started_at: task.started_at,
      finished_at: task.finished_at,
      exit_code: task.exit_code,
      signal: task.signal,
      stdout_bytes: task.stdoutBytes,
      stderr_bytes: task.stderrBytes,
    });
  }
  return jsonResponse(res, 200, { tasks: out });
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

// Probe 127.0.0.1:<port> with a short TCP connect. Resolves true when the
// socket accepts, false on any error or timeout. Used as the authoritative
// dev-server signal — the user's dev server is typically a nohup grandchild
// of a run.sh task and is NOT tracked in `runningProc` or the task map, so
// neither of those signals reflects whether the dev server is actually up.
function portListening(port, timeoutMs = 500) {
  return new Promise(resolve => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch {}
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

async function handleHealth(req, res) {
  const devPort = readDevPort();
  // dev_running is TRUE when any of:
  //   (a) something is listening on dev_port — authoritative proof the dev
  //       server is up and accepting connections. The dev server is usually
  //       a nohup-detached grandchild of a run.sh task (next dev via
  //       `nohup bash -c "npm run dev" & disown`), so it doesn't appear in
  //       runningProc OR the task map. Port check is the only reliable
  //       signal once run.sh has exited and the grandchild is flying solo.
  //   (b) runningProc != null — legacy path for /__exec detach:true.
  //   (c) any /agent/task/run task is currently state='running' — covers
  //       the narrow window between task spawn and (a) becoming true, so
  //       /__health doesn't flicker false during startup.
  let portActive = false;
  try { portActive = await portListening(devPort); } catch {}
  let anyTaskRunning = false;
  for (const t of tasks.values()) {
    if (t.state === 'running') { anyTaskRunning = true; break; }
  }
  return jsonResponse(res, 200, {
    ok: true,
    dev_running: portActive || runningProc != null || anyTaskRunning,
    dev_port: devPort,
    last_exit: lastExit,
    log_bytes: logBuffer.length,
    // Breakdown for diagnostics — lets callers distinguish "port actually
    // open" from "a task is spawning".
    dev_port_active: portActive,
    task_running: anyTaskRunning,
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

  // Strip query string for path-based matching; preserves req.url for
  // downstream proxy use.
  const pathOnly = url.split('?')[0];

  try {
    if (pathOnly === '/__files' && method === 'POST') return await handleFiles(req, res);
    if (pathOnly === '/__write' && method === 'POST') return await handleWrite(req, res);
    if (pathOnly === '/__read' && method === 'POST') return await handleRead(req, res);
    if (pathOnly === '/__ls' && method === 'POST') return await handleLs(req, res);
    if (pathOnly === '/__exec' && method === 'POST') return await handleExec(req, res);
    if (pathOnly === '/__logs' && method === 'GET') return handleLogs(req, res);
    if (pathOnly === '/__events' && method === 'GET') return handleEvents(req, res);
    if (pathOnly === '/__reload' && method === 'POST') return handleEventTrigger(req, res);
    if (pathOnly === '/__health' && method === 'GET') return await handleHealth(req, res);

    // /agent/task/* — see task protocol block above.
    if (pathOnly === '/agent/task/run' && method === 'POST') return await handleTaskRun(req, res);
    if (pathOnly === '/agent/tasks' && method === 'GET') return handleTaskList(req, res);
    let tm;
    tm = /^\/agent\/task\/([a-f0-9]{16})$/.exec(pathOnly);
    if (tm && method === 'GET') return await handleTaskStatus(req, res, tm[1]);
    tm = /^\/agent\/task\/([a-f0-9]{16})\/events$/.exec(pathOnly);
    if (tm && method === 'GET') return await handleTaskEvents(req, res, tm[1]);
    tm = /^\/agent\/task\/([a-f0-9]{16})\/cancel$/.exec(pathOnly);
    if (tm && method === 'POST') return await handleTaskCancel(req, res, tm[1]);
    // Unknown /agent/* — return 404 rather than fall through to the proxy.
    // Gives clear errors when a client targets a path the agent doesn't
    // implement instead of silently hitting the user's dev server.
    if (pathOnly.startsWith('/agent/') || pathOnly === '/agent') {
      return jsonResponse(res, 404, { error: `agent route not found: ${method} ${pathOnly}` });
    }

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
