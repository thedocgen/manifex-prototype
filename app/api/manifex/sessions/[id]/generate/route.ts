import { getSession, getSecrets, updateSession } from '@/lib/store';
import type { ManifexSession, ManifestState } from '@/lib/types';
import { runBuildAgent, isClaudeAgentSdkBackend, computeSeededCodexHash, computePromptVersionHash } from '@/lib/llm-backend';
import { parseEnvironmentServices } from '@/lib/manifest-services';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const MANIDEX_COMPILER_VERSION = 'manidex-claude-agent-sdk-v3';

// Magic key inside codex_files that stores the session
// manifest_state.pages snapshot for incremental diffs. Keys with
// this prefix are metadata, not real files — stripped on seed,
// injected on upsert, ignored by walkAndSerialize diff counts, and
// skipped by the CLI write-back. See lib/llm-backend.ts for the
// matching prefix constant.
const MANIDEX_STATE_SNAPSHOT_KEY = '__manidex_state_snapshot__';
const MANIDEX_PAGE_FILES_MAP_KEY = '__manidex_page_files_map__';

// Keep in sync with app/api/manifex/sessions/[id]/devbox/route.ts.
// These are the declared secrets Manidex gates on before /generate —
// the ones the GENERATED Manifex will need at run time. Devbox-spawn
// secrets (SUPABASE_*) are intentionally excluded; Manidex doesn't
// spawn a Fly devbox on this path.
const MANIDEX_RUNTIME_SECRET_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'FLY_API_TOKEN',
]);

function supabaseAdmin() {
  return createSupabaseClient(
    process.env.SUPABASE_PROJECT_URL || '',
    process.env.SUPABASE_SERVICE_KEY || '',
    { auth: { persistSession: false } },
  );
}

// Phase 2C split — /generate (Claude writes code, cached on manifest_sha).
//
// Replaces the old /build route's Claude part. Claude's only job here is
// to write source files + setup.sh + run.sh into /app/workspace and
// commit to the devbox's git. Does NOT start the dev server, does NOT
// run setup.sh. Those are /build's responsibility, pure bash, no LLM.
//
// Cacheable: if manifest_sha hasn't changed since last successful generate,
// return the cached commit sha without re-running Claude at all. This is
// what makes the round-trip test deterministic — revert the doc, /generate
// hits the cache, same bytes come out.
//
// Runs a Claude tool_use agent loop INSIDE manifex-wip with the
// deliberately un-curated 4-primitive set:
//
//   bash(cmd)                  → POST <devbox>/__exec
//   write_file(path, content)  → POST <devbox>/__write
//   read_file(path)            → POST <devbox>/__read
//   list_files(path)           → POST <devbox>/__ls
//
// ask_user / set_session_secret / get_session_secret are reserved as
// primitives #5-7 per Jesse's hard design constraint but are deferred
// until the core build loop UAT passes — adding them early means DB
// state for suspendable loops, which is a separate chunk.
//
// NO harnesses. NO wrappers. If Claude needs to install a package,
// deploy to Vercel, call an external API, or do literally anything
// exotic, it uses bash. The Manifex codebase gains new capabilities
// from model improvements + bash, not from new Manifex features.
//
// The response is an SSE stream:
//   event: tool_use       data: { id, iteration, name, input }
//   event: tool_result    data: { id, iteration, ok, summary }
//   event: assistant_text data: { iteration, text }
//   event: done           data: { iterations, duration_ms, final_text }
//   event: error          data: { message, stage }
//
// The client reads the stream line-by-line off a POST response body.
// EventSource doesn't support POST, so the editor uses fetch + a
// simple SSE parser.

export const runtime = 'nodejs';
// Phase 4: 53 KB+ specs with doc-driven services take 10-18 min for a
// full cold Claude build (npm install alone is 3-7 min on a fresh
// volume). Bumped from 10 min to 20 min. The bash __exec timeout below
// is also bumped to 15 min so a single long install doesn't abort the
// whole run.
export const maxDuration = 1200;

interface DevboxAttached {
  url: string;
  app_name: string;
  machine_id: string;
}

function getDevbox(session: ManifexSession): DevboxAttached | null {
  const d = (session.manifest_state as any)?.devbox;
  if (!d || !d.url) return null;
  return d as DevboxAttached;
}

function concatenateSpec(state: ManifestState): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const push = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    const page = state.pages[p];
    if (!page) return;
    parts.push(`---\npath: ${p}\ntitle: ${JSON.stringify(page.title || p)}\n---\n\n${page.content || ''}`);
  };
  for (const node of state.tree || []) push(node.path);
  for (const path of Object.keys(state.pages || {})) push(path);
  return parts.join('\n\n');
}

// ---- SSE helpers ---------------------------------------------------------

function sseEvent(event: string, data: unknown): Uint8Array {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${payload}\n\n`);
}

// ---- Build loop ----------------------------------------------------------
// The agent loop itself lives in lib/llm-backend.ts, where both the
// @anthropic-ai/sdk + API-key backend and the @anthropic-ai/claude-agent-sdk
// + Max OAuth backend are wired behind a MANIFEX_LLM_BACKEND flag. The
// route keeps the devbox git + cache + SSE plumbing and delegates the
// Claude call to runBuildAgent().

// Walk the devbox's /app/workspace and pack every non-binary source file
// into a { path: content } map suitable for manifex_compilations. Uses
// /__exec for a single find to get the file list, then parallel /__read
// calls. Skips the usual noise dirs (node_modules, .git, .next, build
// artefacts, lost+found), .env* secrets, binary files, and files ≥2 MB
// (matches the box's /__read cap and seed-compilation.mjs invariants).
// All returned paths are relative to /app/workspace, no leading slash.
async function packDevboxWorkspace(devboxUrl: string): Promise<Record<string, string>> {
  const base = devboxUrl.replace(/\/+$/, '');
  const findCmd = [
    'cd /app/workspace',
    'find . -type f',
    "! -path './node_modules/*'",
    "! -path './.git/*'",
    "! -path './.next/*'",
    "! -path './.turbo/*'",
    "! -path './.vercel/*'",
    "! -path './.cache/*'",
    "! -path './lost+found/*'",
    "! -path './dist/*'",
    "! -path './build/*'",
    "! -path './out/*'",
    '! -name .DS_Store',
    '! -name Thumbs.db',
    '! -name .manifex-port',
    '-size -2M',
  ].join(' ');
  const findRes = await fetch(`${base}/__exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: findCmd }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!findRes.ok) throw new Error(`packDevboxWorkspace: find ${findRes.status}`);
  const findData = await findRes.json() as { exit_code?: number; stdout?: string };
  if (findData.exit_code !== 0) throw new Error(`packDevboxWorkspace: find exit ${findData.exit_code}`);
  const paths = (findData.stdout || '')
    .split('\n')
    .map(ln => ln.trim().replace(/^\.\//, ''))
    .filter(Boolean)
    .filter(p => !p.startsWith('.env')); // never persist secret files

  const out: Record<string, string> = {};
  const CONCURRENCY = 8;
  let idx = 0;
  async function worker() {
    while (idx < paths.length) {
      const p = paths[idx++];
      try {
        const r = await fetch(`${base}/__read`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: p, max_bytes: 2 * 1024 * 1024 }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!r.ok) continue;
        const data = await r.json() as { exists?: boolean; is_file?: boolean; content?: string };
        if (!data.exists || !data.is_file || typeof data.content !== 'string') continue;
        // Cheap binary guard — UTF-8 source files don't contain NUL bytes.
        if (data.content.indexOf('\x00') >= 0) continue;
        out[p] = data.content;
      } catch { /* per-file transient; keep going */ }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return out;
}

// Run a small bash on the devbox, return stdout + exit code.
async function devboxBash(devboxUrl: string, cmd: string): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const base = devboxUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/__exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { exit_code: -1, stdout: '', stderr: `HTTP ${res.status}` };
  const data = await res.json().catch(() => ({}));
  return {
    exit_code: typeof data?.exit_code === 'number' ? data.exit_code : -1,
    stdout: typeof data?.stdout === 'string' ? data.stdout : '',
    stderr: typeof data?.stderr === 'string' ? data.stderr : '',
  };
}

async function ensureGitInit(devboxUrl: string): Promise<void> {
  // Safe to run repeatedly — if .git exists, init + config are no-ops.
  await devboxBash(devboxUrl, `
cd /app/workspace || exit 0
if [ ! -d .git ]; then
  git init -q -b main
  git config user.email "manifex@local"
  git config user.name "Manifex"
  git commit --allow-empty -q -m "init" 2>/dev/null || true
fi
`.trim());
}

async function gitCommitAll(devboxUrl: string, summary: string): Promise<string | null> {
  const safeSummary = summary.replace(/["\n]/g, ' ').slice(0, 120);
  const r = await devboxBash(devboxUrl, `
cd /app/workspace || exit 1
git add -A
git commit --allow-empty -q -m "generate: ${safeSummary}" 2>/dev/null || true
git rev-parse HEAD
`.trim());
  const sha = r.stdout.trim();
  return sha.match(/^[0-9a-f]{7,}$/) ? sha : null;
}

// The build-agent loop was extracted into lib/llm-backend.ts as
// runBuildAgent() with two flag-selected backends. See the top of
// that file for how MANIFEX_LLM_BACKEND switches between
// @anthropic-ai/sdk (API key) and @anthropic-ai/claude-agent-sdk
// (Max OAuth via host credentials).

// DELETE — clear the generate cache for this session. Used when a stale
// commit sha is replaying against a doc that has been rewritten, or
// when the cached commit's setup.sh/run.sh hangs and we need to force a
// fresh Claude loop. Returns the updated session (cache map emptied).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  const oldMap = (session.manifest_state as any)?.generate_cache || {};
  const cleared_count = Object.keys(oldMap).length;
  const newManifestState = { ...session.manifest_state, generate_cache: {} };
  const { updateSession } = await import('@/lib/store');
  const updated = await updateSession(id, { manifest_state: newManifestState });
  return new Response(
    JSON.stringify({ ok: true, cleared_count, session: updated }),
    { headers: { 'content-type': 'application/json' } },
  );
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  if (session.pending_attempt && !session.pending_attempt.draft) {
    return new Response(JSON.stringify({
      error: 'You have proposed changes waiting. Click "Looks good" to accept them before building.',
      reason: 'pending_not_accepted',
    }), { status: 409, headers: { 'content-type': 'application/json' } });
  }

  const spec_md = concatenateSpec(session.manifest_state);
  const manifest_sha = session.manifest_state.sha;

  // Manidex (claude-agent-sdk) path: build into an ephemeral temp dir
  // on the local host, serialize the resulting file tree into
  // manifex_compilations, return. No Fly devbox, no git commit cache,
  // no /__exec proxy. The /manidex-run.mjs CLI fetches the latest row
  // and runs it locally.
  if (isClaudeAgentSdkBackend()) {
    // Defense-in-depth gate: the editor's Build flow calls /devbox
    // POST first, which already runs the same gate, but a direct curl
    // to /generate would bypass it. Duplicated here so the backend
    // enforces runtime-secret presence no matter how it's called.
    const envContentForGate = (session.manifest_state?.pages as any)?.environment?.content || '';
    const parsedForGate = parseEnvironmentServices(envContentForGate);
    const gatedForGate = parsedForGate.allSecretDecls.filter((d) => MANIDEX_RUNTIME_SECRET_KEYS.has(d.key));
    let vaultForGate: Record<string, string> = {};
    try {
      vaultForGate = await getSecrets(session.project_id);
    } catch (e: any) {
      console.warn(`[generate:manidex] getSecrets(${session.project_id}) failed:`, e?.message || e);
    }
    const missingForGate = gatedForGate.filter((d) => !vaultForGate[d.key] || vaultForGate[d.key].length === 0);
    if (missingForGate.length > 0) {
      return new Response(
        JSON.stringify({
          error: 'missing_secrets',
          reason: 'missing_secrets',
          message: `Manidex generate blocked: ${missingForGate.length} runtime secret${missingForGate.length === 1 ? '' : 's'} missing from vault.`,
          missing: missingForGate.map((m) => ({
            key: m.key,
            description: m.description,
            service_name: m.service_name,
            service_description: m.service_description,
          })),
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    }

    // Cache lookup — "change on doc diff only." Same manifest_sha
    // must produce the same build artifact, mirroring the devbox-git
    // cache behavior on the cloud path. If a row already exists for
    // (manifest_sha, MANIDEX_COMPILER_VERSION), skip the agent loop
    // entirely and emit a cache_hit. The only ways to invalidate are
    // editing the spec (new sha) or DELETE /generate.
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: string, data: unknown) => {
          try { controller.enqueue(sseEvent(event, data)); } catch {}
        };

        try {
          // ─── A2: previous-compilation lookup + composite hash computation ───
          // Must happen BEFORE the cache probe so we can include seeded_codex_hash
          // and prompt_version_hash in the extended cache key. The previous row
          // is also needed by the incremental path on cache miss.
          let previousCodexFiles: Record<string, string> | undefined;
          let previousPages: Record<string, { title: string; content: string }> | undefined;
          let previousPageFilesMap: Record<string, string[]> | undefined;
          try {
            const { data: prevRows, error: prevErr } = await supabaseAdmin()
              .from('manifex_compilations')
              .select('manifest_sha,compiler_version,created_at,codex_files')
              .like('compiler_version', 'manidex-claude-agent-sdk-%')
              .neq('manifest_sha', manifest_sha)
              .order('created_at', { ascending: false })
              .limit(1);
            if (prevErr) {
              console.warn(`[generate:manidex] previous-compilation lookup failed: ${prevErr.message}`);
            } else if (prevRows && prevRows[0]?.codex_files) {
              const prevFiles = prevRows[0].codex_files as Record<string, unknown>;
              const snapshotRaw = prevFiles[MANIDEX_STATE_SNAPSHOT_KEY];
              const seededFiles: Record<string, string> = {};
              for (const [k, v] of Object.entries(prevFiles)) {
                if (k.startsWith('__manidex_')) continue;
                if (typeof v === 'string') seededFiles[k] = v;
              }
              previousCodexFiles = seededFiles;
              const mapRaw = prevFiles[MANIDEX_PAGE_FILES_MAP_KEY];
              if (typeof mapRaw === 'string') {
                try {
                  const mapParsed = JSON.parse(mapRaw);
                  if (mapParsed && typeof mapParsed === 'object') {
                    previousPageFilesMap = mapParsed as Record<string, string[]>;
                  }
                } catch {}
              }
              if (typeof snapshotRaw === 'string') {
                try {
                  const parsed = JSON.parse(snapshotRaw);
                  if (parsed && typeof parsed === 'object') {
                    previousPages = parsed as Record<string, { title: string; content: string }>;
                  }
                } catch (e: any) {
                  console.warn(`[generate:manidex] snapshot parse failed on previous row: ${e?.message || e}`);
                }
              } else {
                // Previous compilation was written before incremental
                // mode shipped — no snapshot key. Fall back to cold
                // gen (seeding without diff context would just let
                // Claude drift in unpredictable ways).
                console.log(`[generate:manidex] previous compilation ${String(prevRows[0].manifest_sha).slice(0, 12)} has no snapshot — cold gen this time, next edit will be incremental`);
                previousCodexFiles = undefined;
              }
            }
          } catch (e: any) {
            console.warn(`[generate:manidex] previous-compilation path errored, falling back to cold gen: ${e?.message || e}`);
          }

          // ─── A2: compute composite cache key hashes ───
          // These mirror what runWithClaudeAgentSDK will compute internally.
          // We need them here so the cache probe can match on all 4 fields.
          // Import is already at top of file.
          const { parseRequiredRoutesFromPages } = await import('@/lib/manifest-services');
          const currentPages = session.manifest_state.pages as Record<string, { title: string; content: string }>;
          const routesForHash = parseRequiredRoutesFromPages(currentPages).routes;
          const seededHash = computeSeededCodexHash(previousCodexFiles);
          // For the prompt hash, we need to know WHICH system prompt variant
          // will be used. Incremental fires when both previous + pages exist;
          // otherwise cold. This matches shouldRunIncremental in lib/llm-backend.ts.
          const willBeIncremental = !!(previousCodexFiles && previousPages);
          // The actual prompt hash is computed inside runWithClaudeAgentSDK and
          // returned in the result — but we need it HERE for the cache probe.
          // We replicate the computation with the same inputs so the hashes match.
          // (The alternative — querying without hashes and filtering post-query —
          // would miss the index and scan the full table.)
          const promptHash = computePromptVersionHash(
            willBeIncremental ? 'INCREMENTAL' : 'COLD',
            routesForHash,
            previousPageFilesMap,
          );
          console.log(`[generate:manidex] A2 hashes: seeded=${seededHash?.slice(0, 12) || 'null'} prompt=${promptHash.slice(0, 12)} incremental=${willBeIncremental}`);

          // ─── Cache probe ───
          // prompt_version_hash is intentionally NOT in the lookup constraints.
          // manifest_sha already encodes the doc content — if docs haven't
          // changed, Build should cache-hit regardless of which agent version
          // or prompt variant was used the last time. prompt_version_hash is
          // still recorded on the row (see upsert below) and selected here for
          // diagnostics / forensics, but it does NOT gate cache validity.
          // Click Build with no doc changes → straight cache-hit → materialize
          // → deploy. Agent runs ONLY when docs actually diffed.
          let cacheQuery = supabaseAdmin()
            .from('manifex_compilations')
            .select('manifest_sha,compiler_version,created_at,codex_files,seeded_codex_hash,prompt_version_hash')
            .eq('manifest_sha', manifest_sha)
            .eq('compiler_version', MANIDEX_COMPILER_VERSION);
          if (seededHash === null) {
            cacheQuery = cacheQuery.is('seeded_codex_hash', null);
          } else {
            cacheQuery = cacheQuery.eq('seeded_codex_hash', seededHash);
          }
          const { data: existing, error: cacheLookupErr } = await cacheQuery.maybeSingle();
          if (cacheLookupErr) {
            console.warn(`[generate:manidex] cache lookup failed: ${cacheLookupErr.message}`);
          }

          if (existing?.codex_files) {
            const files = (existing.codex_files as Record<string, unknown>) || {};
            const fileCount = Object.keys(files).filter(k => !String(k).startsWith('__manidex_')).length;
            const totalBytes = Object.values(files).reduce<number>(
              (a, v) => a + (typeof v === 'string' ? v.length : 0), 0,
            );
            const ageMs = Date.now() - new Date(existing.created_at as string).getTime();
            emit('start', {
              manifest_sha,
              backend: 'claude-agent-sdk',
              spec_bytes: spec_md.length,
              cache_hit: true,
              seeded_codex_hash: seededHash,
              prompt_version_hash: promptHash,
            });
            emit('cache_hit', {
              manifest_sha,
              compiler_version: MANIDEX_COMPILER_VERSION,
              file_count: fileCount,
              total_bytes: totalBytes,
              at: existing.created_at,
              age_ms: ageMs,
            });
            emit('done', {
              backend: 'claude-agent-sdk',
              iterations: 0,
              duration_ms: 0,
              final_text: `Cache hit from ${Math.round(ageMs / 60000)} minute${Math.round(ageMs / 60000) === 1 ? '' : 's'} ago — ${fileCount} files, ${totalBytes} bytes.`,
              file_count: fileCount,
              total_bytes: totalBytes,
              manifest_sha,
              compiler_version: MANIDEX_COMPILER_VERSION,
              cache_hit: true,
              cached_at: existing.created_at,
              cache_age_ms: ageMs,
            });
            return;
          }

          // ─── Cache miss — run agent ───
          emit('start', {
            manifest_sha,
            backend: 'claude-agent-sdk',
            spec_bytes: spec_md.length,
            cache_hit: false,
            incremental: willBeIncremental,
            seeded_codex_hash: seededHash,
            prompt_version_hash: promptHash,
          });
          const result = await runBuildAgent(
            '',
            spec_md,
            manifest_sha,
            emit,
            {
              sessionId: id,
              previousCodexFiles,
              previousPages,
              currentPages: session.manifest_state.pages as Record<string, { title: string; content: string }>,
              previousPageFilesMap,
            },
          );
          const files = result.codex_files || {};
          const fileCount = Object.keys(files).length;
          if (fileCount === 0) {
            emit('error', {
              message: 'Agent loop completed but wrote no files to the temp dir',
              stage: 'persist',
            });
            return;
          }
          // Inject the current session.manifest_state.pages snapshot
          // into codex_files under the magic key BEFORE upsert. This
          // gives the NEXT run a baseline to diff against and pre-seed
          // the cwd from. The walker already filters __manidex_* keys
          // out of the diff comparison, and the CLI skips them on
          // write-back, so this metadata never touches real disk.
          const filesWithSnapshot: Record<string, string> = { ...files };
          try {
            filesWithSnapshot[MANIDEX_STATE_SNAPSHOT_KEY] = JSON.stringify(
              session.manifest_state.pages,
            );
          } catch (e: any) {
            console.warn(`[generate:manidex] snapshot serialize failed: ${e?.message || e}`);
          }
          // Inject the page→files map if the agent wrote one.
          if (result.page_files_map && Object.keys(result.page_files_map).length > 0) {
            try {
              filesWithSnapshot[MANIDEX_PAGE_FILES_MAP_KEY] = JSON.stringify(result.page_files_map);
              console.log(`[generate:manidex] injected page→files map: ${Object.keys(result.page_files_map).length} pages`);
            } catch (e: any) {
              console.warn(`[generate:manidex] page-files-map serialize failed: ${e?.message || e}`);
            }
          }
          const { error: upsertErr } = await supabaseAdmin()
            .from('manifex_compilations')
            .upsert(
              {
                manifest_sha,
                compiler_version: MANIDEX_COMPILER_VERSION,
                codex_files: filesWithSnapshot,
                // A2: composite cache key hashes — either from the
                // agent's own computation (returned in result) or
                // from our pre-computed values above (should match).
                seeded_codex_hash: result.seeded_codex_hash ?? seededHash,
                prompt_version_hash: result.prompt_version_hash ?? promptHash,
              },
              { onConflict: 'manifest_sha,compiler_version' },
            );
          if (upsertErr) {
            emit('error', {
              message: `manifex_compilations upsert failed: ${upsertErr.message}`,
              stage: 'persist',
            });
            return;
          }
          emit('done', {
            backend: 'claude-agent-sdk',
            iterations: result.iterations,
            duration_ms: result.duration_ms,
            final_text: result.final_text,
            file_count: fileCount,
            total_bytes: result.total_bytes || 0,
            manifest_sha,
            compiler_version: MANIDEX_COMPILER_VERSION,
            cache_hit: false,
            incremental: !!result.incremental,
            modified_files: result.modified_files,
            preserved_files: result.preserved_files,
            total_files: result.total_files,
          });
        } catch (e: any) {
          emit('error', { message: e?.message || String(e), stage: 'agent' });
        } finally {
          try { controller.close(); } catch {}
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  }

  // Cloud Manifex (anthropic-sdk) path — Fly devbox + git + cache.
  const devbox = getDevbox(session);
  if (!devbox) {
    return new Response(JSON.stringify({
      error: 'No devbox attached. Heartbeat should provision one within a few seconds of opening the editor.',
      reason: 'no_devbox',
    }), { status: 409, headers: { 'content-type': 'application/json' } });
  }

  // Unified cache probe: mirror the claude-agent-sdk path's manifex_compilations
  // lookup (route.ts ~270-358) so both backends share one cache source. When the
  // probe hits, emit start/cache_hit/done and return — /build's materialize step
  // will read the SAME row from manifex_compilations and POST files to the devbox
  // via /__write, no git-checkout needed. Hash inputs match the Manidex path
  // exactly so a row seeded there hits here.
  let unifiedCacheHit: null | {
    file_count: number;
    total_bytes: number;
    at: string;
    age_ms: number;
    seeded_codex_hash: string | null;
    prompt_version_hash: string;
  } = null;
  // Hoisted so the post-agent materialize-clobber fix (inside the stream
  // handler) can reuse these without recomputing. Assigned inside the
  // probe's try block below.
  let hoistedCurrentPages: Record<string, { title: string; content: string }> = session.manifest_state.pages as Record<string, { title: string; content: string }>;
  let hoistedSeededHash: string | null = null;
  let hoistedPromptHash: string = '';
  try {
    // Previous-compilation lookup (needed for seededHash computation).
    const { data: prevRows } = await supabaseAdmin()
      .from('manifex_compilations')
      .select('manifest_sha,compiler_version,created_at,codex_files')
      .like('compiler_version', 'manidex-claude-agent-sdk-%')
      .neq('manifest_sha', manifest_sha)
      .order('created_at', { ascending: false })
      .limit(1);
    let previousCodexFiles: Record<string, string> | undefined;
    let previousPageFilesMap: Record<string, string[]> | undefined;
    if (prevRows && prevRows[0]?.codex_files) {
      const prevFiles = prevRows[0].codex_files as Record<string, unknown>;
      const seededFiles: Record<string, string> = {};
      for (const [k, v] of Object.entries(prevFiles)) {
        if (k.startsWith('__manidex_')) continue;
        if (typeof v === 'string') seededFiles[k] = v;
      }
      previousCodexFiles = seededFiles;
      const mapRaw = prevFiles[MANIDEX_PAGE_FILES_MAP_KEY];
      if (typeof mapRaw === 'string') {
        try {
          const mapParsed = JSON.parse(mapRaw);
          if (mapParsed && typeof mapParsed === 'object') previousPageFilesMap = mapParsed as Record<string, string[]>;
        } catch {}
      }
    }
    const { parseRequiredRoutesFromPages } = await import('@/lib/manifest-services');
    const currentPages = session.manifest_state.pages as Record<string, { title: string; content: string }>;
    const routesForHash = parseRequiredRoutesFromPages(currentPages).routes;
    const seededHash = computeSeededCodexHash(previousCodexFiles);
    const willBeIncremental = !!previousCodexFiles;
    const promptHash = computePromptVersionHash(
      willBeIncremental ? 'INCREMENTAL' : 'COLD',
      routesForHash,
      previousPageFilesMap,
    );
    hoistedCurrentPages = currentPages;
    hoistedSeededHash = seededHash;
    hoistedPromptHash = promptHash;
    // prompt_version_hash is intentionally NOT in the lookup constraints —
    // see the comment on the claude-agent-sdk path's probe above. manifest_sha
    // encodes doc content; a matching row means docs haven't changed, so the
    // cached compilation is valid regardless of which prompt variant wrote it.
    // Still recorded on the row and selected for diagnostics.
    let cacheQuery = supabaseAdmin()
      .from('manifex_compilations')
      .select('manifest_sha,compiler_version,created_at,codex_files,seeded_codex_hash,prompt_version_hash')
      .eq('manifest_sha', manifest_sha)
      .eq('compiler_version', MANIDEX_COMPILER_VERSION);
    if (seededHash === null) {
      cacheQuery = cacheQuery.is('seeded_codex_hash', null);
    } else {
      cacheQuery = cacheQuery.eq('seeded_codex_hash', seededHash);
    }
    const { data: existing } = await cacheQuery.maybeSingle();
    if (existing?.codex_files) {
      const files = (existing.codex_files as Record<string, unknown>) || {};
      const fileCount = Object.keys(files).filter((k) => !String(k).startsWith('__manidex_')).length;
      const totalBytes = Object.values(files).reduce<number>(
        (a, v) => a + (typeof v === 'string' ? v.length : 0),
        0,
      );
      unifiedCacheHit = {
        file_count: fileCount,
        total_bytes: totalBytes,
        at: existing.created_at as string,
        age_ms: Date.now() - new Date(existing.created_at as string).getTime(),
        seeded_codex_hash: seededHash,
        prompt_version_hash: promptHash,
      };
    }
  } catch (e: any) {
    console.warn(`[generate:anthropic-sdk] unified cache probe failed: ${e?.message || e}`);
  }

  // Phase 2C generate-cache (fallback): look up prior commit sha for this manifest_sha.
  // Cache is stored on session.manifest_state.generate_cache as a flat
  // object { [manifest_sha]: { commit_sha, at, duration_ms, iterations } }.
  // Hit → replay the cached commit via `git checkout <sha>` so the
  // workspace is byte-exact to the last successful generate. Retained for
  // backwards compat when no manifex_compilations row matches.
  const cacheMap = (session.manifest_state as any)?.generate_cache || {};
  const cached = cacheMap[manifest_sha];

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: string, data: unknown) => {
        try { controller.enqueue(sseEvent(event, data)); } catch {}
      };

      // Unified-cache short-circuit — must come before the old per-session
      // git-commit cache so both backends agree on the cache source when
      // both sources exist at the same manifest_sha.
      if (unifiedCacheHit) {
        emit('start', {
          manifest_sha,
          backend: 'anthropic-sdk',
          devbox_url: devbox.url,
          spec_bytes: spec_md.length,
          cache_hit: true,
          seeded_codex_hash: unifiedCacheHit.seeded_codex_hash,
          prompt_version_hash: unifiedCacheHit.prompt_version_hash,
        });
        emit('cache_hit', {
          manifest_sha,
          compiler_version: MANIDEX_COMPILER_VERSION,
          file_count: unifiedCacheHit.file_count,
          total_bytes: unifiedCacheHit.total_bytes,
          at: unifiedCacheHit.at,
          age_ms: unifiedCacheHit.age_ms,
        });
        emit('done', {
          backend: 'anthropic-sdk',
          iterations: 0,
          duration_ms: 0,
          final_text: `Cache hit from manifex_compilations — ${unifiedCacheHit.file_count} files, ${unifiedCacheHit.total_bytes} bytes.`,
          file_count: unifiedCacheHit.file_count,
          total_bytes: unifiedCacheHit.total_bytes,
          manifest_sha,
          compiler_version: MANIDEX_COMPILER_VERSION,
          cache_hit: true,
          cached_at: unifiedCacheHit.at,
          cache_age_ms: unifiedCacheHit.age_ms,
        });
        try { controller.close(); } catch {}
        return;
      }

      emit('start', { manifest_sha, devbox_url: devbox.url, spec_bytes: spec_md.length, cache_hit: !!cached });

      try {
        if (cached?.commit_sha) {
          // Cache hit: checkout the stored commit on the devbox, no LLM.
          emit('cache_hit', { commit_sha: cached.commit_sha, at: cached.at });
          await ensureGitInit(devbox.url);
          const r = await devboxBash(devbox.url, `
cd /app/workspace || exit 1
git rev-parse --verify ${cached.commit_sha} >/dev/null 2>&1 || { echo "MISSING"; exit 2; }
git checkout -q ${cached.commit_sha} -- .
git reset -q ${cached.commit_sha}
git clean -qfd
`.trim());
          if (r.exit_code === 0) {
            emit('done', { iterations: 0, final_text: `cache hit ${String(cached.commit_sha).slice(0, 12)}`, duration_ms: 0, commit_sha: cached.commit_sha, cache_hit: true });
            return;
          }
          // Missing / corrupted cache entry — fall through to fresh run.
          emit('assistant_text', { iteration: 0, text: `Cache miss: stored commit ${cached.commit_sha.slice(0,12)} not found on volume (exit ${r.exit_code}). Running fresh agent loop.` });
        }

        await ensureGitInit(devbox.url);
        const result = await runBuildAgent(devbox.url, spec_md, manifest_sha, emit);

        // Commit everything Claude wrote into the devbox git.
        const commit_sha = await gitCommitAll(devbox.url, result.final_text);

        // Persist cache entry if we got a sha back.
        if (commit_sha) {
          const newCacheMap = { ...cacheMap, [manifest_sha]: {
            commit_sha,
            at: new Date().toISOString(),
            duration_ms: result.duration_ms,
            iterations: result.iterations,
          }};
          try {
            const newManifestState = { ...session.manifest_state, generate_cache: newCacheMap } as unknown as typeof session.manifest_state;
            await updateSession(id, { manifest_state: newManifestState });
          } catch (e: any) {
            console.warn(`[generate] cache write failed: ${e?.message || e}`);
          }
        }

        // Materialize-clobber fix: write manifex_compilations from the
        // devbox's FINAL state (not from prototype source). Prior design
        // had /render or seed-compilation.mjs populating this row from
        // the prototype tree, and /build's materialize would then clobber
        // the agent's edits on the next click. By writing the row here,
        // the materialize step re-hydrates the same files the agent just
        // committed — so a no-doc-change re-Build is a cache-hit that
        // deploys identical state rather than regressing. Hashes
        // (seeded_codex_hash, prompt_version_hash) were computed above
        // for the cache probe; reuse them here for consistency.
        try {
          const codexFiles = await packDevboxWorkspace(devbox.url);
          codexFiles[MANIDEX_STATE_SNAPSHOT_KEY] = JSON.stringify(hoistedCurrentPages);
          const { error: upsertErr } = await supabaseAdmin()
            .from('manifex_compilations')
            .upsert(
              {
                manifest_sha,
                compiler_version: MANIDEX_COMPILER_VERSION,
                codex_files: codexFiles,
                seeded_codex_hash: hoistedSeededHash,
                prompt_version_hash: hoistedPromptHash,
              },
              { onConflict: 'manifest_sha,compiler_version' },
            );
          if (upsertErr) {
            console.warn(`[generate:anthropic-sdk] compilation upsert failed: ${upsertErr.message}`);
          } else {
            const fileCount = Object.keys(codexFiles).filter(k => !k.startsWith('__manidex_')).length;
            const totalBytes = Object.values(codexFiles).reduce<number>((s, v) => s + (typeof v === 'string' ? v.length : 0), 0);
            console.log(`[generate:anthropic-sdk] wrote manifex_compilations row: ${fileCount} files, ${totalBytes} bytes`);
            emit('assistant_text', {
              iteration: result.iterations,
              text: `Persisted compilation row from devbox state: ${fileCount} files, ${totalBytes} bytes.`,
            });
          }
        } catch (e: any) {
          console.warn(`[generate:anthropic-sdk] pack+upsert failed: ${e?.message || e}`);
        }

        emit('done', { ...result, commit_sha, cache_hit: false });
      } catch (e: any) {
        emit('error', { message: e?.message || String(e), stage: 'agent' });
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
