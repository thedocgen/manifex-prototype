#!/usr/bin/env node
// seed-compilation.mjs — write a manifex_compilations row from the live prototype tree.
//
// Phase B of the back-in-docs drive: the mirror's docs describe prototype behavior,
// so a compilation row at the current manifest_sha should serve the REAL prototype
// code. Seeding satisfies that — /generate then cache-hits and Build deploys the
// prototype byte-for-byte.
//
// Usage:
//   node scripts/seed-compilation.mjs --session <uuid> [--compiler-version <str>]
//   node scripts/seed-compilation.mjs --help
//
// Flags:
//   --session <uuid>           Session UUID to seed (required). Script reads its current
//                              manifest_state.sha + pages from Supabase.
//   --compiler-version <str>   Defaults to 'manidex-claude-agent-sdk-v3'.
//   --purge-prior              Delete all prior rows at this compiler_version before
//                              inserting. Default: true. Ensures /generate's
//                              previous-compilation lookup returns nothing so the cache
//                              probe fires the COLD path (matching the hash shape we
//                              write). Disable with --no-purge-prior if the chain of
//                              prior rows matters.
//   --dry-run                  Print what would be written; don't write.
//   --help                     Show this help.
//
// Exit codes: 0 success, 1 runtime error, 2 invocation error.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '/workspace/manifex-prototype/node_modules/@supabase/supabase-js/dist/index.mjs';

const HELP = `seed-compilation.mjs — seed manifex_compilations row from prototype tree
(See header comment in this script for full docs.)
`;

// ── args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(args.length === 0 ? 2 : 0);
}

let sessionId = null;
let compilerVersion = 'manidex-claude-agent-sdk-v3';
let purgePrior = true;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--session') { sessionId = args[++i]; continue; }
  if (a === '--compiler-version') { compilerVersion = args[++i]; continue; }
  if (a === '--purge-prior') { purgePrior = true; continue; }
  if (a === '--no-purge-prior') { purgePrior = false; continue; }
  if (a === '--dry-run') { dryRun = true; continue; }
  die(`unknown flag: ${a}`, 2);
}
if (!sessionId) die('--session <uuid> is required', 2);

// ── env load ─────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const protoRoot = path.resolve(__dirname, '..');
const envPath = path.join(protoRoot, '.env.local');
if (!fs.existsSync(envPath)) die(`.env.local not found at ${envPath}`, 2);

const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  env[m[1]] = v;
}
const SUPA_URL = env.SUPABASE_PROJECT_URL;
const SUPA_KEY = env.SUPABASE_SERVICE_KEY;
if (!SUPA_URL || !SUPA_KEY) die('SUPABASE_PROJECT_URL or SUPABASE_SERVICE_KEY missing', 1);

const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

// ── hash helpers — mirror lib/llm-backend.ts:631-672 exactly ─────

function deterministicStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '[' + value.map(deterministicStringify).join(',') + ']';
  if (typeof value === 'object') {
    const sorted = Object.keys(value).sort();
    return '{' + sorted.map(k => JSON.stringify(k) + ':' + deterministicStringify(value[k])).join(',') + '}';
  }
  return String(value);
}
function sha256(s) {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}
function computePromptVersionHash(systemPrompt, requiredRoutes, pageFilesMap) {
  return sha256(deterministicStringify({
    systemPrompt,
    requiredRoutes,
    pageFilesMap: pageFilesMap || {},
  }));
}

// ── parse REQUIRED ROUTES out of the current session pages ──────
// Mirrors the shape of lib/manifest-services.ts parseRequiredRoutesFromPages.
// Mirror-phase docs deliberately contain no REQUIRED ROUTES blocks (Jesse rule:
// "spec describes behavior, not code"), so this should return [].

function parseRequiredRoutesFromPages(pages) {
  const seen = new Set();
  const all = [];
  const PATH_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|sh|sql|css|html|json|md)$/;
  for (const page of Object.values(pages || {})) {
    const content = typeof page === 'string' ? page : (page && page.content);
    if (!content) continue;
    const lines = content.split('\n');
    let inRequiredRoutes = false;
    for (const ln of lines) {
      const heading = ln.match(/^(#{1,6})\s+(.+?)\s*$/);
      if (heading) {
        inRequiredRoutes = /REQUIRED\s+ROUTES/i.test(heading[2]);
        continue;
      }
      if (!inRequiredRoutes) continue;
      const bm = ln.match(/^\s*[-*]\s+([^\s—–:-]+)/);
      if (!bm) continue;
      const p = bm[1];
      if (!PATH_EXT_RE.test(p)) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      const descMatch = ln.match(/^\s*[-*]\s+\S+\s*[—–:\-]\s*(.+?)\s*$/);
      all.push({ path: p, description: descMatch ? descMatch[1] : '' });
    }
  }
  return { routes: all };
}

// ── walk prototype tree — mirror CODEX_ALWAYS_SKIP_DIRS etc. ─────

const ALWAYS_SKIP = new Set([
  'node_modules', '.next', '.git', '.cache', '.turbo', '.vercel', '.manifex', '.manidex',
]);
const ROOT_ONLY_SKIP = new Set(['dist', 'build', 'out']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', '.manifex-port']);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB cap — matches route-side safety

function isBinary(buf) {
  // Crude heuristic: if any NUL byte in first 8 KB, treat as binary and skip.
  const head = buf.subarray(0, Math.min(8192, buf.length));
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return true;
  return false;
}

function walk(codexFiles, absDir, relDir, depth = 0) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const e of entries) {
    const absPath = path.join(absDir, e.name);
    const relPath = relDir === '' ? e.name : `${relDir}/${e.name}`;
    if (e.isDirectory()) {
      if (ALWAYS_SKIP.has(e.name)) continue;
      if (depth === 0 && ROOT_ONLY_SKIP.has(e.name)) continue;
      walk(codexFiles, absPath, relPath, depth + 1);
      continue;
    }
    if (!e.isFile()) continue;
    if (SKIP_FILES.has(e.name)) continue;
    if (e.name.startsWith('.env')) continue; // secrets — never seed
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > MAX_FILE_BYTES) {
        console.warn(`skip oversized (${stat.size} B): ${relPath}`);
        continue;
      }
      const buf = fs.readFileSync(absPath);
      if (isBinary(buf)) {
        console.warn(`skip binary: ${relPath}`);
        continue;
      }
      codexFiles[relPath] = buf.toString('utf-8');
    } catch (err) {
      console.warn(`skip unreadable: ${relPath} (${err.message})`);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────

(async () => {
  // 1. Fetch session
  const { data: sessions, error: sessErr } = await supa
    .from('manifex_sessions')
    .select('id,manifest_state')
    .eq('id', sessionId)
    .maybeSingle();
  if (sessErr) die(`session lookup failed: ${sessErr.message}`, 1);
  if (!sessions) die(`session not found: ${sessionId}`, 1);
  const manifestState = sessions.manifest_state;
  if (!manifestState || !manifestState.sha) die('session has no manifest_state.sha', 1);
  const manifestSha = manifestState.sha;
  const pages = manifestState.pages || {};
  console.log(`session ${sessionId} @ manifest_sha ${manifestSha.slice(0, 16)}…`);
  console.log(`page count: ${Object.keys(pages).length}`);

  // 2. Walk prototype tree
  const codexFiles = {};
  walk(codexFiles, protoRoot, '', 0);
  let totalBytes = 0;
  for (const v of Object.values(codexFiles)) totalBytes += v.length;
  console.log(`codex_files: ${Object.keys(codexFiles).length} files, ${totalBytes} bytes`);

  // 3. Inject metadata keys
  //   __manidex_state_snapshot__ = JSON of manifest_state.pages (so the NEXT
  //   /generate's previous-compilation path has a snapshot to parse).
  codexFiles['__manidex_state_snapshot__'] = JSON.stringify(pages);

  // 3b. v7 CompiledProject reserved keys — consumed by getCachedProject and
  // /build. Without these, /build sees empty setup/run and the port-polling
  // loop stalls for 10+ min. Values sourced from the Environment doc's
  // REQUIRED SHAPE for run.sh (mirror extension of env doc) plus the
  // canonical 'npm ci' for setup.sh.
  // setup.sh — idempotent installer. Guard npm ci with a node_modules
  // presence check so re-running setup.sh on every machine restart (via
  // bootstrap.sh's setup-then-run chain — see below) is a near-zero no-op
  // when the volume already has a populated node_modules. First-ever
  // build still pays the full ~3-4 min npm ci on a 1GB shared machine.
  // Every call runs under Fly's ~5-min HTTP proxy window end-to-end when
  // invoked via /agent/task/run (box child outlives the HTTP call anyway).
  codexFiles['__manifex/setup.sh'] = '[ -d node_modules ] || npm ci\n';
  // run.sh — lean. Launch 'next dev' detached on port 4000; /build's
  // wait_port poll probes /__health until Next dev binds (~10-30 s).
  // Dev mode (not 'next start') avoids the separate production build step
  // — aligns with the HMR iteration loop where doc edits regenerate code
  // and Next dev picks up file changes live. Optional migrate-guard
  // preserves the Environment doc's schema-bootstrap contract when
  // scripts/migrate.mjs ships; an absent file is a no-op.
  //
  // Persistence contract: before launching, write .manifex/bootstrap.sh so
  // the box service's runBootstrap() hook re-execs the same launch path
  // when Fly auto_stop_machines restarts the machine after idle. Without
  // this, the dev server never comes back after a stop/start cycle and
  // the iframe sticks on the "Building your app…" stub forever. Writing
  // it from within run.sh (rather than up front at seed time) keeps the
  // launch command and its restart shim co-located — any future change
  // to run.sh's launch path automatically updates what bootstrap.sh
  // invokes, because bootstrap.sh just chains setup.sh + run.sh.
  //
  // Bootstrap chains BOTH setup.sh and run.sh (not run.sh alone) because
  // non-volume state — global npm installs, apt packages, anything under
  // /usr/local — is wiped on machine restart. setup.sh is idempotent
  // (see setup.sh body above), so the chain is cheap on warm restarts
  // and correct when the container was recreated from the base image.
  codexFiles['__manifex/run.sh'] = [
    '#!/bin/bash',
    'set -e',
    'pkill -f "next" 2>/dev/null || true',
    'mkdir -p .manifex',
    'echo "4000" > .manifex-port',
    "cat > .manifex/bootstrap.sh << 'EOF'",
    'bash /app/workspace/setup.sh && bash /app/workspace/run.sh',
    'EOF',
    'chmod +x .manifex/bootstrap.sh',
    'echo "[run.sh] launching npm run dev on port 4000"',
    'nohup bash -c "PORT=4000 HOSTNAME=0.0.0.0 npm run dev -- -p 4000" > .manifex/dev.log 2>&1 < /dev/null & disown',
    'exit 0',
    '',
  ].join('\n');
  codexFiles['__manifex/port'] = '4000';

  // 4. Hash computation — COLD variant, matching the generate route's
  //    probe when no prior row exists (we purge prior by default to
  //    guarantee this shape).
  const seededCodexHash = null;
  const routes = parseRequiredRoutesFromPages(pages).routes;
  const promptVersionHash = computePromptVersionHash('COLD', routes, undefined);
  console.log(`cold-variant hashes: seeded=null prompt=${promptVersionHash.slice(0, 16)}…`);
  console.log(`required_routes parsed: ${routes.length}`);

  // 5. Optionally purge prior rows at this compiler-family.
  //    The /generate route's previous-compilation lookup uses LIKE 'manidex-claude-agent-sdk-%'
  //    (route.ts:273) — it matches v1/v2/v3 alike. To guarantee a COLD probe after seeding,
  //    we must purge the same family, not just the exact version.
  if (purgePrior && !dryRun) {
    const familyPattern = compilerVersion.replace(/-v\d+$/, '-') + '%';
    const { error: purgeErr, count: purgeCount } = await supa
      .from('manifex_compilations')
      .delete({ count: 'exact' })
      .like('compiler_version', familyPattern);
    if (purgeErr) die(`purge failed: ${purgeErr.message}`, 1);
    console.log(`purged ${purgeCount ?? '?'} prior rows at compiler_version LIKE '${familyPattern}'`);
  } else if (purgePrior && dryRun) {
    const familyPattern = compilerVersion.replace(/-v\d+$/, '-') + '%';
    console.log(`[dry-run] would purge all rows at compiler_version LIKE '${familyPattern}'`);
  }

  // 6. UPSERT the seeded row
  const row = {
    manifest_sha: manifestSha,
    compiler_version: compilerVersion,
    codex_files: codexFiles,
    seeded_codex_hash: seededCodexHash,
    prompt_version_hash: promptVersionHash,
  };
  if (dryRun) {
    console.log('[dry-run] would upsert row:');
    console.log(`  manifest_sha=${manifestSha.slice(0, 16)}…`);
    console.log(`  compiler_version=${compilerVersion}`);
    console.log(`  file count=${Object.keys(codexFiles).length} (incl. state snapshot)`);
    console.log(`  prompt_version_hash=${promptVersionHash.slice(0, 16)}…`);
    console.log('[dry-run] no changes written.');
    process.exit(0);
  }
  const { error: upErr } = await supa
    .from('manifex_compilations')
    .upsert(row, { onConflict: 'manifest_sha,compiler_version' });
  if (upErr) die(`upsert failed: ${upErr.message}`, 1);
  console.log(`✓ seeded row at (${manifestSha.slice(0, 16)}…, ${compilerVersion})`);
  console.log(`✓ codex_files: ${Object.keys(codexFiles).length} entries`);
  console.log(`Next step: fire POST /api/manifex/sessions/${sessionId}/generate and expect cache_hit.`);
})().catch(err => {
  console.error(`seed-compilation crashed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

function die(msg, code = 1) {
  console.error(`seed-compilation: ${msg}`);
  process.exit(code);
}
