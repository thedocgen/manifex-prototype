#!/usr/bin/env node
// Manidex runner: fetch the latest manifex_compilations row, write the
// codex_files tree into a fresh temp dir, run npm install + npm run dev
// against a free port, print the URL, and clean up on exit.
//
// Usage:
//   node scripts/manidex-run.mjs                        # latest compilation, local dev
//   node scripts/manidex-run.mjs --sha <hash>           # specific manifest_sha
//   node scripts/manidex-run.mjs --keep-dir             # don't wipe on exit (local only)
//   node scripts/manidex-run.mjs --fly                  # deploy to a per-dev Fly app
//   node scripts/manidex-run.mjs --fly --app <name>     # explicit Fly app name
//
// Local mode (default): write the tree to /tmp, npm install, npx next dev
// on a free port, print localhost URL.
//
// Fly mode (--fly): create Fly app `manifex-dev-<shortsha>` (or --app),
// allocate shared IPv4 via GraphQL, create a machine from the devbox
// image, POST every codex_file to /__write, run setup.sh then run.sh
// detached, print the public fly.dev URL. Same generated code as local,
// just a different runtime. Requires FLY_API_TOKEN in the vault (or env).
//
// Env (loaded from .env.local if present, else process.env):
//   SUPABASE_PROJECT_URL
//   SUPABASE_SERVICE_KEY
//
// The script is standalone ESM — no Next.js dependency, no imports
// from the Manidex codebase itself. Run from any working directory.

import { readFileSync, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

// ───────────────────────────────────────────────────────────────────
// Env loading — pull SUPABASE_* from .env.local in the current
// working directory or the script's own parent dir, without
// clobbering vars already set in process.env.
// ───────────────────────────────────────────────────────────────────
function loadEnvLocal() {
  const candidates = [
    resolve(process.cwd(), '.env.local'),
    resolve(dirname(new URL(import.meta.url).pathname), '..', '.env.local'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf-8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
    return p;
  }
  return null;
}

const envFile = loadEnvLocal();
const SUPABASE_URL = process.env.SUPABASE_PROJECT_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[manidex-run] SUPABASE_PROJECT_URL and SUPABASE_SERVICE_KEY must be set (.env.local or process env)');
  process.exit(1);
}
if (envFile) console.log(`[manidex-run] loaded env from ${envFile}`);

// ───────────────────────────────────────────────────────────────────
// Args
// ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let requestedSha = null;
let keepDir = false;
let flyMode = false;
let flyAppOverride = null;
let watchMode = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sha' && args[i + 1]) { requestedSha = args[++i]; continue; }
  if (args[i] === '--keep-dir') { keepDir = true; continue; }
  if (args[i] === '--fly') { flyMode = true; continue; }
  if (args[i] === '--app' && args[i + 1]) { flyAppOverride = args[++i]; continue; }
  if (args[i] === '--watch') { watchMode = true; continue; }
  if (args[i] === '--help' || args[i] === '-h') {
    console.log('Usage: node scripts/manidex-run.mjs [--sha <manifest_sha>] [--keep-dir] [--watch] [--fly [--app <name>] [--watch]]');
    console.log('');
    console.log('  --watch   LOCAL: poll for new compilation rows, hot-patch changed files into running tmpdir (HMR picks up)');
    console.log('            FLY:   poll + diff-push changed files to devbox via /__write');
    process.exit(0);
  }
}

// ───────────────────────────────────────────────────────────────────
// Fetch all vault secrets for the Manidex spec session's project.
// The CLI uses these to populate the env of the spawned Manifex dev
// server — keys like ANTHROPIC_API_KEY + FLY_API_TOKEN live in
// manifex_secrets only (not .env.local), and the generated Manifex
// needs them to call Anthropic + Fly at runtime.
//
// The flow is: spec session id (from env) → manifex_sessions.project_id
// → manifex_secrets.{key,value} rows. Two sequential PostgREST calls,
// both scoped to the single spec session Manidex knows about.
// ───────────────────────────────────────────────────────────────────
const MANIDEX_SPEC_SESSION_ID = (process.env.NEXT_PUBLIC_MANIFEX_SPEC_SESSION_ID
  || process.env.MANIFEX_SPEC_SESSION_ID
  || 'e1b1fd0a-16be-4dd9-ae45-8657bb46a38a').trim();

async function pgrestGet(path, params) {
  const base = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${path}`;
  const qs = new URLSearchParams(params || {});
  const res = await fetch(`${base}?${qs}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PostgREST ${path} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchVaultSecrets() {
  // Resolve the spec session's project_id.
  const sessions = await pgrestGet('manifex_sessions', {
    select: 'project_id',
    id: `eq.${MANIDEX_SPEC_SESSION_ID}`,
  });
  if (!Array.isArray(sessions) || sessions.length === 0) {
    console.warn(`[manidex-run] spec session ${MANIDEX_SPEC_SESSION_ID.slice(0, 8)} not found — skipping vault fetch`);
    return { projectId: null, secrets: {} };
  }
  const projectId = sessions[0].project_id;
  // Fetch all vault entries for that project. We pull ALL rows (not
  // just a known set) so any new secret vaulted through the editor
  // modal flows into the spawn env without code changes.
  const rows = await pgrestGet('manifex_secrets', {
    select: 'key,value',
    project_id: `eq.${projectId}`,
  });
  const secrets = {};
  for (const row of rows || []) {
    if (row.key && typeof row.value === 'string') secrets[row.key] = row.value;
  }
  return { projectId, secrets };
}

// ───────────────────────────────────────────────────────────────────
// Fetch the compilation row via PostgREST (avoids the @supabase/supabase-js
// dependency — script stays standalone).
// ───────────────────────────────────────────────────────────────────
async function fetchLatestCompilation() {
  // Accept ANY manidex-claude-agent-sdk-* version (mirrors the cross-version
  // compat fix in generate/route.ts at c0fe975). Compiler version bumps
  // (v1→v2→v3) change the cache key but the codex_files are source code
  // compatible across versions. Without this, the watch loop started under
  // v1 can't see v3 rows and the hot-patch stalls silently.
  const COMPILER_VERSION_LIKE = 'manidex-claude-agent-sdk-%';
  const base = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/manifex_compilations`;
  const params = new URLSearchParams({
    select: 'manifest_sha,compiler_version,created_at,codex_files',
    compiler_version: `like.${COMPILER_VERSION_LIKE}`,
    order: 'created_at.desc',
    limit: '1',
  });
  if (requestedSha) params.set('manifest_sha', `eq.${requestedSha}`);
  const res = await fetch(`${base}?${params}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`manifex_compilations query failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(requestedSha
      ? `No compilation row for manifest_sha=${requestedSha}`
      : `No compilation rows at all. Click Build in Manidex first.`);
  }
  return rows[0];
}

// ───────────────────────────────────────────────────────────────────
// Pick a free TCP port — ephemeral listen + close, grab the assigned
// port number. npm run dev is not bound to any specific port so we
// export PORT for its child process.
// ───────────────────────────────────────────────────────────────────
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ───────────────────────────────────────────────────────────────────
// Fly mode helpers — create a per-dev Manifex app on Fly, provision
// a machine from the devbox image, upload codex_files via /__write,
// and kick setup.sh + run.sh. Mirrors lib/devbox.ts createDevbox.
// ───────────────────────────────────────────────────────────────────
const FLY_API_BASE = 'https://api.machines.dev/v1';
const DEVBOX_IMAGE = 'registry.fly.io/manifex-devbox-image:v3.3-inline-output';

function flyHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function flyCreateApp(token, appName) {
  // Idempotent: if the app already exists, return immediately.
  // Fly's CreateMachineApp auth service sometimes 500s on POST /apps
  // even when the app exists, so checking GET first avoids a false
  // failure when a previous attempt silently succeeded.
  const checkRes = await fetch(`${FLY_API_BASE}/apps/${appName}`, {
    headers: flyHeaders(token),
  });
  if (checkRes.ok) return;
  // Retry POST up to 3 times with 2s backoff.
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${FLY_API_BASE}/apps`, {
      method: 'POST',
      headers: flyHeaders(token),
      body: JSON.stringify({ app_name: appName, org_slug: 'personal' }),
    });
    if (res.status === 201 || res.status === 409) return;
    // 422 "Name has already been taken" = a previous 500-timed-out attempt
    // actually succeeded on Fly's side. Treat as success.
    if (res.status === 422) {
      const body = await res.text();
      if (body.includes('already been taken')) return;
      lastErr = `422 ${body}`;
    } else {
      lastErr = `${res.status} ${await res.text()}`;
    }
    console.warn(`[manidex-run:fly] create app attempt ${attempt} failed: ${lastErr}`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Fly create app failed after 3 attempts: ${lastErr}`);
}

async function flyEnsurePublicIp(token, appName) {
  try {
    await fetch('https://api.fly.io/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        query: `mutation Allocate($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id address } } }`,
        variables: { input: { appId: appName, type: 'shared_v4' } },
      }),
    });
  } catch {}
}

async function flyCreateMachine(token, appName) {
  const body = JSON.stringify({
    config: {
      image: DEVBOX_IMAGE,
      env: {},
      services: [
        { ports: [{ port: 443, handlers: ['tls', 'http'] }, { port: 80, handlers: ['http'] }], protocol: 'tcp', internal_port: 8080 },
      ],
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
      auto_destroy: false,
    },
    region: 'iad',
  });
  let res, lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    res = await fetch(`${FLY_API_BASE}/apps/${appName}/machines`, {
      method: 'POST',
      headers: flyHeaders(token),
      body,
    });
    if (res.ok) break;
    lastErr = `${res.status} ${await res.text()}`;
    console.warn(`[manidex-run:fly] create machine attempt ${attempt} failed: ${lastErr}`);
    if (attempt < 4) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!res || !res.ok) throw new Error(`Fly create machine failed after retries: ${lastErr}`);
  const data = await res.json();
  // Poll machine state directly — Fly's /wait?state=started endpoint can
  // race and return 400 before the first state transition is visible.
  // Poll up to 90s, 2s interval, check .state === 'started'.
  const maxAttempts = 45;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const stateRes = await fetch(`${FLY_API_BASE}/apps/${appName}/machines/${data.id}`, {
      headers: flyHeaders(token),
    });
    if (stateRes.ok) {
      const m = await stateRes.json();
      if (m.state === 'started') return data;
      if (m.state === 'failed' || m.state === 'destroyed') {
        throw new Error(`Fly machine entered terminal state: ${m.state}`);
      }
    }
  }
  throw new Error(`Fly machine did not reach started state within 90s`);
}

async function devboxWrite(devboxUrl, path, content) {
  // Long timeout — Next.js HMR can stall the devbox agent briefly while
  // it recompiles after a previous /__write, and we'd rather wait than
  // false-fail a push mid-recompile.
  const res = await fetch(`${devboxUrl}/__write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`devbox /__write ${path} failed: ${res.status} ${await res.text()}`);
}

async function devboxExec(devboxUrl, cmd, { detach = false } = {}) {
  const res = await fetch(`${devboxUrl}/__exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, detach }),
  });
  if (!res.ok) throw new Error(`devbox /__exec failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function runOnFly(row, vaultSecrets) {
  const token = vaultSecrets.FLY_API_TOKEN || process.env.FLY_API_TOKEN;
  if (!token) {
    console.error('[manidex-run] --fly requires FLY_API_TOKEN in vault or process.env');
    process.exit(1);
  }
  const shortSha = row.manifest_sha.slice(0, 8);
  const appName = flyAppOverride || `manifex-dev-${shortSha}`;
  console.log(`[manidex-run:fly] target app: ${appName}`);

  console.log('[manidex-run:fly] creating Fly app…');
  await flyCreateApp(token, appName);

  console.log('[manidex-run:fly] allocating shared IPv4…');
  await flyEnsurePublicIp(token, appName);

  const devboxUrl = `https://${appName}.fly.dev`;

  // Detect prior deploy: a machine that's already started AND has an
  // existing dev server on .manifex-port is an idempotent re-push.
  // A fresh started-but-unprovisioned machine still needs setup.sh + run.sh.
  // Probe via /__health — dev_running=true means the dev server is bound.
  const machinesRes = await fetch(`${FLY_API_BASE}/apps/${appName}/machines`, {
    headers: flyHeaders(token),
  });
  let skipMachineProvision = false;
  let skipDevServerLaunch = false;
  if (machinesRes.ok) {
    const machines = await machinesRes.json();
    const started = machines.find((m) => m.state === 'started');
    if (started) {
      console.log(`[manidex-run:fly] existing started machine ${started.id} detected — skipping provision`);
      skipMachineProvision = true;
      // Probe dev server via /__health
      try {
        const healthRes = await fetch(`https://${appName}.fly.dev/__health`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (healthRes.ok) {
          const h = await healthRes.json();
          if (h.dev_running === true) {
            console.log(`[manidex-run:fly] dev server already bound (port ${h.dev_port}) — idempotent re-push, will skip setup/run`);
            skipDevServerLaunch = true;
          } else {
            console.log(`[manidex-run:fly] machine up but dev server not running — will run setup.sh + run.sh`);
          }
        }
      } catch {
        console.log(`[manidex-run:fly] /__health probe failed — will run setup.sh + run.sh`);
      }
    }
  }

  if (!skipMachineProvision) {
    console.log('[manidex-run:fly] creating machine + waiting for started (up to 90s)…');
    const machine = await flyCreateMachine(token, appName);
    console.log(`[manidex-run:fly] machine ${machine.id} started`);
    // Machine state=started doesn't mean the Fly proxy has routed the
    // public hostname to the devbox agent yet. Poll /__health (up to 60s)
    // until the devbox agent is network-reachable before the first /__write.
    console.log('[manidex-run:fly] waiting for devbox agent /__health (up to 60s)…');
    const healthDeadline = Date.now() + 60_000;
    let reachable = false;
    while (Date.now() < healthDeadline) {
      try {
        const r = await fetch(`${devboxUrl}/__health`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) { reachable = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!reachable) {
      throw new Error('Devbox agent not reachable within 60s after machine started');
    }
    console.log('[manidex-run:fly] devbox agent reachable');
  }

  const files = row.codex_files || {};
  const uploadable = Object.entries(files).filter(([p, c]) => {
    if (p.startsWith('__manidex_')) return false;
    if (typeof c !== 'string') return false;
    if (c.startsWith('__MANIDEX_ELIDED__')) return false;
    return true;
  });
  console.log(`[manidex-run:fly] uploading ${uploadable.length} files to ${devboxUrl}…`);
  for (const [path, content] of uploadable) {
    await devboxWrite(devboxUrl, path, content);
  }
  console.log(`[manidex-run:fly] upload complete`);

  // Write .env.local with vault secrets PLUS MANIFEX_RUN_MODE.
  // Default to prod for Fly (production is what you want on a 1GB box);
  // caller can override via process.env.MANIFEX_RUN_MODE.
  const runMode = process.env.MANIFEX_RUN_MODE || 'prod';
  const envEntries = Object.entries(vaultSecrets).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  envEntries.push(`MANIFEX_RUN_MODE=${JSON.stringify(runMode)}`);
  const envLocal = envEntries.join('\n') + '\n';
  await devboxWrite(devboxUrl, '.env.local', envLocal);
  console.log(`[manidex-run:fly] wrote .env.local: ${Object.keys(vaultSecrets).length} vault keys + MANIFEX_RUN_MODE=${runMode}`);

  if (!skipDevServerLaunch) {
    if (files['setup.sh']) {
      console.log('[manidex-run:fly] running setup.sh…');
      const setupRes = await devboxExec(devboxUrl, 'cd /app/workspace && set -a && source .env.local && set +a && bash setup.sh 2>&1 | tail -30');
      if (setupRes.exit_code !== 0) {
        console.error('[manidex-run:fly] setup.sh failed:');
        console.error(setupRes.stdout);
        console.error(setupRes.stderr);
        process.exit(1);
      }
      console.log(`[manidex-run:fly] setup.sh ok (${setupRes.duration_ms}ms)`);
    }

    if (files['run.sh']) {
      console.log('[manidex-run:fly] launching dev server via run.sh (detached)…');
      // run.sh reads MANIFEX_RUN_MODE from .env.local to pick dev vs prod.
      // We exec in the background so CLI can return; run.sh does its own
      // nohup+disown for the actual dev/start process.
      await devboxExec(devboxUrl, 'cd /app/workspace && set -a && source .env.local && set +a && bash run.sh', { detach: true });
    } else {
      console.warn('[manidex-run:fly] no run.sh — dev server will not start automatically');
    }
  } else {
    console.log('[manidex-run:fly] existing dev server — skipped setup.sh/run.sh');
  }

  console.log('');
  console.log(`[manidex-run:fly] DONE → ${devboxUrl}`);
  console.log(`[manidex-run:fly] (first page load may take 10-30s while the dev server binds)`);

  // Remember the initially-deployed sha for diff-push. Watch mode below
  // polls Supabase for new compilation rows and pushes only the files
  // that differ vs this baseline.
  return { devboxUrl, initialSha: row.manifest_sha, initialFiles: uploadable };
}

// ───────────────────────────────────────────────────────────────────
// Watch mode: poll manifex_compilations for new rows, diff against
// the last-pushed row, and POST /__write for each changed file so
// Next.js HMR picks them up live. Runs forever until SIGINT.
// ───────────────────────────────────────────────────────────────────
async function watchAndPush({ devboxUrl, initialSha, initialFiles }) {
  const POLL_INTERVAL_MS = 5000;
  let lastSha = initialSha;
  let lastFiles = new Map(initialFiles); // path → content
  console.log('');
  console.log(`[manidex-run:watch] polling manifex_compilations every ${POLL_INTERVAL_MS / 1000}s for changes to push to ${devboxUrl}`);
  console.log(`[manidex-run:watch] baseline sha=${lastSha.slice(0, 12)} files=${lastFiles.size}`);

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const row = await fetchLatestCompilation();
      if (row.manifest_sha === lastSha) continue;

      const files = row.codex_files || {};
      const uploadable = new Map();
      for (const [p, c] of Object.entries(files)) {
        if (p.startsWith('__manidex_')) continue;
        if (typeof c !== 'string') continue;
        if (c.startsWith('__MANIDEX_ELIDED__')) continue;
        uploadable.set(p, c);
      }

      // Compute added + changed + removed
      const added = [];
      const changed = [];
      const removed = [];
      for (const [p, c] of uploadable) {
        if (!lastFiles.has(p)) added.push(p);
        else if (lastFiles.get(p) !== c) changed.push(p);
      }
      for (const p of lastFiles.keys()) {
        if (!uploadable.has(p)) removed.push(p);
      }

      const touched = added.length + changed.length;
      console.log('');
      console.log(`[manidex-run:watch] NEW sha=${row.manifest_sha.slice(0, 12)} +${added.length} ~${changed.length} -${removed.length}`);

      if (touched === 0 && removed.length === 0) {
        console.log('[manidex-run:watch] no file-level changes, skipping push');
        lastSha = row.manifest_sha;
        lastFiles = uploadable;
        continue;
      }

      // Push added + changed via /__write
      let okCount = 0;
      let failCount = 0;
      for (const path of [...added, ...changed]) {
        try {
          await devboxWrite(devboxUrl, path, uploadable.get(path));
          okCount++;
        } catch (e) {
          failCount++;
          console.error(`  push FAIL ${path}: ${e.message}`);
        }
      }
      console.log(`[manidex-run:watch] pushed ${okCount}/${touched} files ok, ${failCount} failed`);
      if (removed.length > 0) {
        console.log(`[manidex-run:watch] NOTE: ${removed.length} file${removed.length === 1 ? '' : 's'} removed in new row but /__write has no delete primitive (ignored): ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? '…' : ''}`);
      }

      lastSha = row.manifest_sha;
      lastFiles = uploadable;
    } catch (e) {
      console.warn(`[manidex-run:watch] poll error (will retry): ${e?.message || e}`);
    }
  }
}

// ───────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────
async function run() {
  console.log('[manidex-run] fetching latest compilation…');
  const row = await fetchLatestCompilation();
  const files = row.codex_files || {};
  const fileCount = Object.keys(files).length;
  const totalBytes = Object.values(files).reduce((a, s) => a + (typeof s === 'string' ? s.length : 0), 0);
  console.log(`[manidex-run] manifest_sha=${row.manifest_sha.slice(0, 12)} created=${row.created_at} files=${fileCount} bytes=${totalBytes}`);

  // Fly mode: skip the whole local tempdir/npm install/next-dev path.
  // The generated Manifex runs on a per-dev Fly machine using the
  // devbox image, identical to how Layer-0 customer apps run.
  if (flyMode) {
    let vaultSecrets = {};
    try {
      const { projectId, secrets } = await fetchVaultSecrets();
      vaultSecrets = secrets;
      const keys = Object.keys(secrets);
      if (keys.length > 0) {
        console.log(`[manidex-run] merged ${keys.length} vault secret${keys.length === 1 ? '' : 's'} for Fly deploy: ${keys.join(', ')}${projectId ? ` (project=${String(projectId).slice(0, 8)})` : ''}`);
      }
    } catch (e) {
      console.warn(`[manidex-run] vault fetch failed, trying process.env: ${e?.message || e}`);
    }
    const deployHandle = await runOnFly(row, vaultSecrets);
    if (watchMode && deployHandle) {
      await watchAndPush(deployHandle);
    }
    return;
  }

  const ts = Date.now().toString(36);
  const outDir = `/tmp/manidex-run-${ts}`;
  await mkdir(outDir, { recursive: true });
  console.log(`[manidex-run] writing tree to ${outDir}`);

  for (const [relPath, content] of Object.entries(files)) {
    // Magic metadata keys injected by the Manidex /generate route to
    // carry incremental-compilation state across builds. They are
    // NOT real files — never write them to disk.
    if (relPath.startsWith('__manidex_')) continue;
    if (typeof content !== 'string') continue;
    if (content.startsWith('__MANIDEX_ELIDED__')) {
      console.warn(`[manidex-run] skipping elided file: ${relPath}`);
      continue;
    }
    const absPath = join(outDir, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, 'utf-8');
  }

  // Install deps. Manidex compilations are Next.js projects so npm
  // install is the expected path — skip if the row doesn't include
  // a package.json at all.
  if (!files['package.json']) {
    console.error('[manidex-run] compilation row has no package.json — nothing to install. Aborting.');
    process.exit(1);
  }

  console.log('[manidex-run] npm install --no-audit --no-fund (first run can be slow)…');
  await new Promise((resolveInstall, reject) => {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: outDir,
      stdio: 'inherit',
    });
    child.on('exit', (code) => code === 0 ? resolveInstall() : reject(new Error(`npm install exited ${code}`)));
    child.on('error', reject);
  });

  // Fetch vault secrets for the spec session's project and merge them
  // into the spawn env. The generated Manifex needs ANTHROPIC_API_KEY,
  // FLY_API_TOKEN, etc. at runtime — none of those live in .env.local,
  // only in manifex_secrets. Straight passthrough (option B from the
  // closure brief). Vault-gate resolution at serve time is a later pass.
  let vaultSecrets = {};
  try {
    const { projectId, secrets } = await fetchVaultSecrets();
    vaultSecrets = secrets;
    const keys = Object.keys(secrets);
    if (keys.length > 0) {
      console.log(`[manidex-run] merged ${keys.length} vault secret${keys.length === 1 ? '' : 's'} into spawn env: ${keys.join(', ')}${projectId ? ` (project=${String(projectId).slice(0, 8)})` : ''}`);
    } else {
      console.warn(`[manidex-run] vault is empty for spec session project — spawned Manifex will boot with no runtime credentials`);
    }
  } catch (e) {
    console.warn(`[manidex-run] vault fetch failed, spawning without vault secrets: ${e?.message || e}`);
  }

  // Stable port for local Manidex: 4000 (the canonical Manidex URL).
  // The retiring manifex-prototype bootstrap also binds 4000 today, so
  // during the transition we fall back to 4001 if 4000 is taken. Once
  // manifex-prototype is gone, Manidex automatically claims 4000.
  // Override with MANIDEX_PORT env var.
  const candidatePorts = process.env.MANIDEX_PORT
    ? [Number(process.env.MANIDEX_PORT)]
    : [4000, 4001];
  let port = null;
  for (const candidate of candidatePorts) {
    try {
      await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(candidate, '127.0.0.1', () => srv.close(() => resolve()));
      });
      port = candidate;
      break;
    } catch {}
  }
  if (port === null) {
    port = await pickFreePort();
    console.warn(`[manidex-run] ${candidatePorts.join('/')} in use, falling back to free port ${port}`);
  } else if (port !== candidatePorts[0]) {
    console.warn(`[manidex-run] ${candidatePorts[0]} in use, using ${port}`);
  }
  const url = `http://localhost:${port}`;
  // Bypass `npm run dev` and invoke next directly with an explicit
  // -p flag. The generated package.json's dev script often hardcodes
  // `next dev -p 4000`, which overrides the PORT env var and conflicts
  // with the Manidex dev tool (also on 4000). Spawning next directly
  // via npx keeps this CLI independent of whatever port the spec
  // happens to bake in.
  console.log(`[manidex-run] starting: npx next dev -H 0.0.0.0 -p ${port}`);
  console.log(`[manidex-run]   → ${url}`);
  const dev = spawn('npx', ['next', 'dev', '-H', '0.0.0.0', '-p', String(port)], {
    cwd: outDir,
    stdio: 'inherit',
    // Vault secrets LAST so they override anything inherited from
    // process.env — the vault is authoritative for runtime creds.
    env: { ...process.env, ...vaultSecrets, PORT: String(port) },
  });

  // ─── Local watch mode ──────────────────────────────────────────
  // Poll manifex_compilations for new rows, diff against the running
  // tree, write only changed files so Next.js HMR picks them up
  // instantly. No kill, no npm install, no cold compile.
  if (watchMode) {
    let lastSha = row.manifest_sha;
    let lastFiles = new Map();
    for (const [p, c] of Object.entries(files)) {
      if (p.startsWith('__manidex_')) continue;
      if (typeof c !== 'string') continue;
      if (c.startsWith('__MANIDEX_ELIDED__')) continue;
      lastFiles.set(p, c);
    }
    const POLL_MS = 1000;
    console.log('');
    console.log(`[manidex-run:watch] LOCAL hot-patch mode — polling every ${POLL_MS / 1000}s`);
    console.log(`[manidex-run:watch] baseline sha=${lastSha.slice(0, 12)} files=${lastFiles.size}`);
    console.log(`[manidex-run:watch] changed files write directly to ${outDir} → Next.js HMR`);

    (async () => {
      while (true) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        try {
          const newRow = await fetchLatestCompilation();
          if (newRow.manifest_sha === lastSha) continue;

          const newFiles = new Map();
          for (const [p, c] of Object.entries(newRow.codex_files || {})) {
            if (p.startsWith('__manidex_')) continue;
            if (typeof c !== 'string') continue;
            if (c.startsWith('__MANIDEX_ELIDED__')) continue;
            newFiles.set(p, c);
          }

          const added = [];
          const changed = [];
          const removed = [];
          for (const [p, c] of newFiles) {
            if (!lastFiles.has(p)) added.push(p);
            else if (lastFiles.get(p) !== c) changed.push(p);
          }
          for (const p of lastFiles.keys()) {
            if (!newFiles.has(p)) removed.push(p);
          }

          const touched = added.length + changed.length;
          console.log('');
          console.log(`[manidex-run:watch] NEW sha=${newRow.manifest_sha.slice(0, 12)} +${added.length} ~${changed.length} -${removed.length}`);

          if (touched === 0 && removed.length === 0) {
            console.log('[manidex-run:watch] no file-level changes, skipping');
            lastSha = newRow.manifest_sha;
            lastFiles = newFiles;
            continue;
          }

          // Write changed files directly to tmpdir — HMR picks them up
          let okCount = 0;
          for (const path of [...added, ...changed]) {
            const absPath = join(outDir, path);
            await mkdir(dirname(absPath), { recursive: true });
            await writeFile(absPath, newFiles.get(path), 'utf-8');
            okCount++;
          }

          // Delete removed files
          for (const path of removed) {
            try {
              const { unlink } = await import('node:fs/promises');
              await unlink(join(outDir, path));
            } catch {}
          }

          console.log(`[manidex-run:watch] hot-patched ${okCount} files to ${outDir}`);
          if (removed.length > 0) {
            console.log(`[manidex-run:watch] removed ${removed.length} file${removed.length === 1 ? '' : 's'}`);
          }

          lastSha = newRow.manifest_sha;
          lastFiles = newFiles;
        } catch (e) {
          console.warn(`[manidex-run:watch] poll error (will retry): ${e?.message || e}`);
        }
      }
    })();
  }

  // Graceful cleanup on SIGINT / SIGTERM / child exit.
  const cleanup = async (exitCode) => {
    try { dev.kill('SIGTERM'); } catch {}
    if (!keepDir) {
      try {
        await rm(outDir, { recursive: true, force: true });
        console.log(`[manidex-run] cleaned up ${outDir}`);
      } catch {}
    } else {
      console.log(`[manidex-run] kept ${outDir} (--keep-dir)`);
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', () => cleanup(0));
  dev.on('exit', (code) => cleanup(code ?? 0));
}

run().catch((err) => {
  console.error('[manidex-run] failed:', err?.message || err);
  process.exit(1);
});
