#!/usr/bin/env node
// verify-doc-section.mjs — 7-check verifier for back-in-docs draft pages
//
// Usage: node scripts/verify-doc-section.mjs <draft.md> [--root <proto-root>] [--verbose]
//        node scripts/verify-doc-section.mjs --help
//
// Exit 0: clean (all claims pass). Exit 1: one or more failures.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `
verify-doc-section.mjs — back-in-docs accuracy verifier

USAGE
  node scripts/verify-doc-section.mjs <draft.md> [options]
  node scripts/verify-doc-section.mjs --help

ARGUMENTS
  <draft.md>         Path to the draft doc-page markdown file to verify.

OPTIONS
  --root <dir>       Prototype root (default: repo root containing this script).
  --verbose          Show per-claim trace (default: failures only + summary).
  --help             Show this help and exit.

CHECKS (per §5 of /tmp/backin-docs-plan-draft4.md)
  1. Route paths        every /api/... or app/api/**/route.ts path exists on disk
  2. Response shapes    NextResponse.json({...}) keys declared in draft appear in route source
  3. REQUIRED strings   every line in a "REQUIRED — exact strings:" block is present verbatim
  4. className claims   every className="..." fragment is used somewhere in source
  5. Type names         every TS type/interface referenced exists in lib/types.ts
  6. File paths         every repo-relative path (app/, lib/, scripts/, components/, db/, manifex-devbox/) exists
  7. Env vars           every UPPER_SNAKE env var appears in .env.example or is flagged runtime-documented
  8. JSON name claims   every "name": "..." inside a fenced json block, and every backticked
                        identifier (runBuildAgent, MANIDEX_COMPILER_VERSION, SYSTEM_PROMPT) in prose,
                        must grep-F match source. Catches fabricated tool names / constants.

EXIT CODES
  0   all claims verified
  1   one or more claims failed
  2   invocation error (missing draft, bad root, etc.)
`;

// ── args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(args.length === 0 ? 2 : 0);
}

let draftPath = null;
let protoRoot = null;
let verbose = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') { protoRoot = args[++i]; continue; }
  if (a === '--verbose') { verbose = true; continue; }
  if (a.startsWith('--')) { die(`unknown flag: ${a}`, 2); }
  if (!draftPath) { draftPath = a; continue; }
  die(`unexpected argument: ${a}`, 2);
}
if (!draftPath) die('missing draft path (see --help)', 2);
if (!protoRoot) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  protoRoot = path.resolve(__dirname, '..');
}

if (!fs.existsSync(draftPath)) die(`draft not found: ${draftPath}`, 2);
if (!fs.existsSync(path.join(protoRoot, 'lib/types.ts'))) {
  die(`proto root does not contain lib/types.ts: ${protoRoot}`, 2);
}

const draft = fs.readFileSync(draftPath, 'utf8');

// ── source-index helpers (lazy) ────────────────────────────────────

let _allSource = null;
function allSource() {
  if (_allSource) return _allSource;
  const roots = ['app', 'lib', 'components', 'scripts', 'db', 'manifex-devbox'];
  const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.sql', '.json', '.css']);
  const out = new Map(); // path -> content
  for (const r of roots) {
    const abs = path.join(protoRoot, r);
    if (!fs.existsSync(abs)) continue;
    walk(abs, (p) => {
      if (!exts.has(path.extname(p))) return;
      if (p.includes('/node_modules/') || p.includes('/.next/')) return;
      out.set(path.relative(protoRoot, p), fs.readFileSync(p, 'utf8'));
    });
  }
  _allSource = out;
  return out;
}
function walk(dir, cb) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, cb);
    else if (e.isFile()) cb(p);
  }
}
function normalizeQuotes(s) {
  // Collapse JSX/HTML escape variants to canonical form so source and needle match.
  return s
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}
function grepAll(needle) {
  const n = normalizeQuotes(needle);
  for (const [, content] of allSource()) {
    if (normalizeQuotes(content).includes(n)) return true;
  }
  return false;
}

// ── check results ──────────────────────────────────────────────────

const results = [];
function record(check, claim, ok, detail = '') {
  results.push({ check, claim, ok, detail });
}

// ── 1. route paths ─────────────────────────────────────────────────

function checkRoutes() {
  const seen = new Set();
  // /api/manifex/... and /api/health and app/api/**/route.ts style
  const reRel = /\bapp\/api\/[A-Za-z0-9_\-\[\]/]+\/route\.(?:ts|tsx|js)\b/g;
  const reUrl = /(?<![A-Za-z])\/api\/[A-Za-z0-9_\-\[\]/]+?(?=["'`\s)]|\.(?:ts|tsx|js|mjs)|$|,\s)/gm;
  for (const m of draft.matchAll(reRel)) seen.add(m[0]);
  for (const m of draft.matchAll(reUrl)) {
    // Map URL → route.ts path; replace dynamic :param or [param] into [id]-style bucket; here we grep for the literal URL in source.
    const url = m[0];
    if (url.includes('{') || url.includes('}')) continue;
    // Try exact URL presence in any route.ts file.
    const matched = [...allSource().entries()].some(
      ([p, c]) => p.startsWith('app/api/') && p.endsWith('/route.ts') && (c.includes(`'${url}'`) || c.includes(`"${url}"`))
    );
    // Also accept the URL corresponding to an actual route.ts file path.
    const asPath = url.replace(/^\//, 'app/') + '/route.ts';
    const exists = fs.existsSync(path.join(protoRoot, asPath));
    record('1.route', url, matched || exists, exists ? asPath : (matched ? 'string-present' : 'not found'));
  }
  for (const p of seen) {
    const abs = path.join(protoRoot, p);
    record('1.route', p, fs.existsSync(abs), abs);
  }
}

// ── 2. response shapes ─────────────────────────────────────────────

function checkResponseShapes() {
  // Look for fenced json blocks after lines like "Response:" or "returns".
  const reBlocks = /```(?:json|jsonc|ts)?\s*\n([\s\S]*?)```/g;
  let matched = 0;
  for (const m of draft.matchAll(reBlocks)) {
    const body = m[1];
    // Skip tool-schema-shaped blocks (AI Skills page documents Claude tool_use input_schemas,
    // not HTTP response shapes). Heuristic: presence of "input_schema" or "$schema" keys.
    if (/"(?:input_schema|\$schema)"\s*:/.test(body)) continue;
    const keys = [...body.matchAll(/"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g)].map(x => x[1]);
    if (keys.length === 0) continue;
    // Heuristic: need at least one `NextResponse.json` somewhere in source that mentions a majority of these keys.
    let bestHit = 0;
    let bestFile = '';
    for (const [p, content] of allSource()) {
      if (!p.startsWith('app/api/') || !p.endsWith('route.ts')) continue;
      if (!content.includes('NextResponse.json')) continue;
      const hits = keys.filter(k => content.includes(k)).length;
      if (hits > bestHit) { bestHit = hits; bestFile = p; }
    }
    const passThreshold = Math.ceil(keys.length * 0.6);
    const ok = bestHit >= passThreshold;
    record('2.shape', `{${keys.slice(0,4).join(',')}${keys.length>4?',…':''}}`, ok, `${bestHit}/${keys.length} keys in ${bestFile || '(no route)'}`);
    matched++;
  }
  if (matched === 0) record('2.shape', '(no fenced shape blocks found)', true, 'skipped');
}

// ── 3. REQUIRED exact strings ──────────────────────────────────────

function checkRequiredStrings() {
  // Parse blocks: a line matching /REQUIRED\s*—\s*exact strings/ or /REQUIRED — exact strings:/
  // followed by bulleted/quoted lines until a blank line or next heading.
  const lines = draft.split('\n');
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    // A REQUIRED block starts either on a heading line ("## REQUIRED — exact strings: ...")
    // or on a body line ("REQUIRED — exact strings:"). Both open a new block; next heading or blank line closes.
    const isHeading = /^#{1,6}\s/.test(ln);
    const isRequired = /REQUIRED\s*(?:—|--|-)\s*exact\s*strings?/i.test(ln);
    if (isRequired) {
      if (cur) blocks.push(cur);
      cur = { start: i, items: [] };
      continue;
    }
    if (isHeading) { if (cur) { blocks.push(cur); cur = null; } continue; }
    if (cur) {
      if (/^\s*$/.test(ln)) continue;
      // bullet: `- "foo"`, `- \`foo\``, `- foo` — capture from first bullet char, strip one pair of outer quote/backtick
      const bm = ln.match(/^\s*[-*]\s+(.+?)\s*$/);
      if (!bm) continue;
      let s = bm[1];
      // Strip one matching pair of outer backticks or outer double-quotes.
      // For quotes, allow escaped \" inside (the escape gets normalized in grepAll).
      if (/^`.+`$/.test(s) && !s.slice(1, -1).includes('`')) s = s.slice(1, -1);
      else if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1);
      cur.items.push(s);
    }
  }
  if (cur) blocks.push(cur);

  if (blocks.length === 0) {
    record('3.required', '(no REQUIRED exact-string blocks found)', true, 'skipped');
    return;
  }
  for (const b of blocks) {
    for (const s of b.items) {
      const ok = grepAll(s);
      record('3.required', s.length > 80 ? s.slice(0, 77) + '…' : s, ok, ok ? 'found' : 'NOT FOUND in source');
    }
  }
}

// ── 4. className claims ────────────────────────────────────────────

function checkClassNames() {
  // Find fragments like className="..." in draft (typically in code fences quoting JSX).
  const re = /className\s*=\s*["'{`]([^"'`}]+)["'}`]/g;
  const seen = new Set();
  for (const m of draft.matchAll(re)) {
    const frag = m[1].trim();
    if (!frag || frag.length > 200) continue;
    seen.add(frag);
  }
  if (seen.size === 0) { record('4.class', '(no className claims in draft)', true, 'skipped'); return; }
  for (const frag of seen) {
    // Match substring presence of the full class string, OR each individual class atom.
    const full = grepAll(frag);
    if (full) { record('4.class', frag, true, 'full match'); continue; }
    const atoms = frag.split(/\s+/).filter(Boolean);
    const hits = atoms.filter(a => grepAll(a)).length;
    const ok = hits === atoms.length;
    record('4.class', frag, ok, `${hits}/${atoms.length} atoms present`);
  }
}

// ── 5. type names vs lib/types.ts ──────────────────────────────────

function checkTypeNames() {
  const typesSrc = fs.readFileSync(path.join(protoRoot, 'lib/types.ts'), 'utf8');
  const declared = new Set();
  for (const m of typesSrc.matchAll(/^\s*export\s+(?:interface|type|enum)\s+([A-Z][A-Za-z0-9_]*)/gm)) {
    declared.add(m[1]);
  }
  // Find type-looking mentions in the draft: explicit "type X" or "interface X" lines, or inline claims like
  // "ManifestState", "DocPage", etc. inside backticks with CamelCase.
  const referenced = new Set();
  for (const m of draft.matchAll(/`([A-Z][A-Za-z0-9_]*)`/g)) {
    // Only treat as a type claim if it's also declared-in-types OR the draft calls it a "type"/"interface".
    referenced.add(m[1]);
  }
  // Narrow: only those referenced which look like TS-typish names (Capitalized, not ALL_CAPS, not obvious components).
  const candidates = [...referenced].filter(n => /^[A-Z][a-zA-Z0-9]*$/.test(n) && !/^[A-Z_]+$/.test(n));
  const failures = [];
  for (const c of candidates) {
    // If it's declared in types.ts, pass.
    if (declared.has(c)) {
      record('5.type', c, true, 'declared in lib/types.ts');
      continue;
    }
    // Otherwise, allow if the draft explicitly marks it as "new-to-mirror" or if it doesn't appear next to type/interface/const keywords in the draft.
    const isTyped = new RegExp(`(?:type|interface)\\s+${c}\\b`).test(draft) ||
                    new RegExp(`\`\\s*${c}\\s*\`[^\\n]{0,60}(?:type|interface|shape)`).test(draft);
    if (!isTyped) {
      // Not a type claim — skip silently.
      continue;
    }
    record('5.type', c, false, 'not in lib/types.ts (flag as new-to-mirror if intentional)');
    failures.push(c);
  }
  if (candidates.length === 0 || (failures.length === 0 && declared.size > 0 && results.filter(r => r.check === '5.type').length === 0)) {
    record('5.type', '(no type-name claims in draft)', true, 'skipped');
  }
}

// ── 6. file paths ──────────────────────────────────────────────────

function checkFilePaths() {
  const re = /\b((?:app|lib|components|scripts|db|manifex-devbox)\/[A-Za-z0-9_\-\[\]/.]+?\.(?:tsx?|mjs|js|py|sql|json|css|toml|env)(?:\.local)?)\b/g;
  const seen = new Set();
  for (const m of draft.matchAll(re)) seen.add(m[1]);
  if (seen.size === 0) { record('6.path', '(no repo-relative paths in draft)', true, 'skipped'); return; }
  for (const p of seen) {
    const abs = path.join(protoRoot, p);
    record('6.path', p, fs.existsSync(abs), abs);
  }
}

// ── 7. env vars ────────────────────────────────────────────────────

function checkEnvVars() {
  const candidates = ['.env.example', '.env.local'];
  let envFile = null;
  for (const c of candidates) {
    if (fs.existsSync(path.join(protoRoot, c))) { envFile = path.join(protoRoot, c); break; }
  }
  const envExists = !!envFile;
  const envText = envExists ? fs.readFileSync(envFile, 'utf8') : '';
  const declared = new Set(
    envText.split('\n').map(l => l.match(/^\s*([A-Z][A-Z0-9_]+)\s*=/)).filter(Boolean).map(m => m[1])
  );
  // Scan draft for env-looking tokens.
  // Tight heuristic: identifier must both have an env-prefix AND an env-suffix,
  // OR be a bare known env name. This avoids flagging exported TS constants that
  // happen to share the ANTHROPIC_/MANIFEX_/etc. prefix (e.g. ANTHROPIC_SDK_TOOLS,
  // MANIDEX_STATE_SNAPSHOT_KEY).
  const prefixes = /^(?:NEXT_PUBLIC_|SUPABASE_|ANTHROPIC_|FLY_|MANIFEX_|NODE_|GITHUB_|DATABASE_|POSTGRES_|DOLT_|VAULT_)/;
  const suffixes = /(?:_KEY|_URL|_TOKEN|_SECRET|_BACKEND|_ENV|_DSN|_ID|_NAME|_MODE|_PATH|_HOST|_PORT|_REGION)$/;
  const seen = new Set();
  for (const m of draft.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)) {
    const v = m[1];
    const hasPrefix = prefixes.test(v);
    const hasSuffix = suffixes.test(v);
    const isBareEnv = v === 'NODE_ENV' || v === 'PORT' || v === 'PWD' || v === 'HOME';
    if ((hasPrefix && hasSuffix) || isBareEnv) seen.add(v);
  }
  if (seen.size === 0) { record('7.env', '(no env-var claims in draft)', true, 'skipped'); return; }
  for (const v of seen) {
    if (declared.has(v)) { record('7.env', v, true, '.env.example'); continue; }
    // Accept runtime-only if draft tags it
    const rtNote = new RegExp(`\`${v}\`[^\\n]{0,120}(?:runtime-only|runtime-documented|injected at runtime|not in \\.env)`).test(draft);
    const envLabel = envFile ? path.basename(envFile) : '.env.example';
    record('7.env', v, rtNote, rtNote ? 'runtime-documented' : (envExists ? `missing from ${envLabel}` : 'no .env file found'));
  }
}

// ── 8. json-block "name" claims + backticked identifiers ───────────

function checkJsonNameClaims() {
  // 8a: every `"name": "<ident>"` inside a ```json``` block
  // 8b: every backticked identifier in prose that looks like a tool/function/constant
  //     (snake_case or CamelCase or UPPER_SNAKE) must be present in source somewhere
  const seen = new Map(); // needle -> context label

  // 8a: Scan JSON code blocks
  const reJsonBlocks = /```(?:json|jsonc)\s*\n([\s\S]*?)```/g;
  for (const m of draft.matchAll(reJsonBlocks)) {
    const body = m[1];
    for (const nm of body.matchAll(/"name"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/g)) {
      const name = nm[1];
      if (!seen.has(name)) seen.set(name, 'json:name');
    }
  }

  // 8b: Scan backticked identifiers in prose
  // Match identifier shapes we care about:
  //   - snake_case_tool names (at least one underscore, all lowercase)
  //   - camelCase/PascalCase function/type names (starting letter + mixed case)
  //   - UPPER_SNAKE constants (all uppercase with underscores, length ≥ 4)
  const reBacktick = /`([A-Za-z_][A-Za-z0-9_]*(?:\(\))?)`/g;
  for (const m of draft.matchAll(reBacktick)) {
    const raw = m[1];
    const ident = raw.replace(/\(\)$/, '');
    if (ident.length < 4) continue;
    // Skip common English words and markdown-escape artifacts
    if (/^(this|that|these|those|here|there|true|false|null|undefined|void|type|prop|props|state|when|then|from|into|using|which|where|such|also|etc|note|more|some)$/i.test(ident)) continue;
    const looksLikeIdent =
      /_/.test(ident) ||                          // snake_case, UPPER_SNAKE
      /^[A-Z][a-zA-Z0-9]*$/.test(ident) ||        // PascalCase / ALL_CAPS short
      /^[a-z]+[A-Z]/.test(ident);                 // camelCase
    if (!looksLikeIdent) continue;
    if (!seen.has(ident)) seen.set(ident, 'prose:`ident`');
  }

  if (seen.size === 0) {
    record('8.ident', '(no json-name or backticked identifier claims)', true, 'skipped');
    return;
  }
  for (const [ident, ctx] of seen) {
    const ok = grepAll(ident);
    record('8.ident', ident, ok, ok ? `found (${ctx})` : `NOT FOUND in source (${ctx})`);
  }
}

// ── run ────────────────────────────────────────────────────────────

try {
  checkRoutes();
  checkResponseShapes();
  checkRequiredStrings();
  checkClassNames();
  checkTypeNames();
  checkFilePaths();
  checkEnvVars();
  checkJsonNameClaims();
} catch (err) {
  console.error(`verifier crash: ${err.message}`);
  process.exit(2);
}

// ── report ─────────────────────────────────────────────────────────

const byCheck = new Map();
for (const r of results) {
  if (!byCheck.has(r.check)) byCheck.set(r.check, []);
  byCheck.get(r.check).push(r);
}
const order = ['1.route', '2.shape', '3.required', '4.class', '5.type', '6.path', '7.env', '8.ident'];
let totalPass = 0, totalFail = 0;
for (const k of order) {
  const arr = byCheck.get(k) || [];
  const pass = arr.filter(r => r.ok).length;
  const fail = arr.length - pass;
  totalPass += pass; totalFail += fail;
  console.log(`\n[${k}]  pass=${pass}  fail=${fail}`);
  for (const r of arr) {
    if (r.ok && !verbose) continue;
    const icon = r.ok ? 'ok  ' : 'FAIL';
    console.log(`  ${icon} ${r.claim}${r.detail ? '  — ' + r.detail : ''}`);
  }
}
console.log(`\n──────────────────────────────────────────────`);
console.log(`TOTAL: ${totalPass} pass, ${totalFail} fail`);
console.log(`DRAFT: ${draftPath}`);
console.log(`ROOT:  ${protoRoot}`);

process.exit(totalFail > 0 ? 1 : 0);

function die(msg, code = 1) {
  console.error(`verify-doc-section: ${msg}`);
  process.exit(code);
}
