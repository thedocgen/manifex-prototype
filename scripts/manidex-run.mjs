#!/usr/bin/env node
// Manidex runner: fetch the latest manifex_compilations row, write the
// codex_files tree into a fresh temp dir, run npm install + npm run dev
// against a free port, print the URL, and clean up on exit.
//
// Usage:
//   node scripts/manidex-run.mjs                # latest compilation
//   node scripts/manidex-run.mjs --sha <hash>   # specific manifest_sha
//   node scripts/manidex-run.mjs --keep-dir     # don't wipe on exit
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
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sha' && args[i + 1]) { requestedSha = args[++i]; continue; }
  if (args[i] === '--keep-dir') { keepDir = true; continue; }
  if (args[i] === '--help' || args[i] === '-h') {
    console.log('Usage: node scripts/manidex-run.mjs [--sha <manifest_sha>] [--keep-dir]');
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
  const COMPILER_VERSION = 'manidex-claude-agent-sdk-v1';
  const base = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/manifex_compilations`;
  const params = new URLSearchParams({
    select: 'manifest_sha,compiler_version,created_at,codex_files',
    compiler_version: `eq.${COMPILER_VERSION}`,
    order: 'created_at.desc',
    limit: requestedSha ? '1' : '1',
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
      ? `No compilation row for manifest_sha=${requestedSha} (compiler_version=${COMPILER_VERSION})`
      : `No compilation rows at all (compiler_version=${COMPILER_VERSION}). Click Build in Manidex first.`);
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
// Main
// ───────────────────────────────────────────────────────────────────
async function run() {
  console.log('[manidex-run] fetching latest compilation…');
  const row = await fetchLatestCompilation();
  const files = row.codex_files || {};
  const fileCount = Object.keys(files).length;
  const totalBytes = Object.values(files).reduce((a, s) => a + (typeof s === 'string' ? s.length : 0), 0);
  console.log(`[manidex-run] manifest_sha=${row.manifest_sha.slice(0, 12)} created=${row.created_at} files=${fileCount} bytes=${totalBytes}`);

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

  const port = await pickFreePort();
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
