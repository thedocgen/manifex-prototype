import { getSession } from '@/lib/store';
import type { ManifexSession } from '@/lib/types';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Phase A3: routes to pre-warm after the dev server is up but BEFORE
// emitting the 'done' event. Sequential (not parallel) to stay under
// the 1GB Fly machine memory ceiling during Next.js on-demand compile.
// '/' is already warm from the wait_port poll but is re-probed as a
// sanity check. The other routes are the most-likely first clicks
// after the editor iframe loads.
const PREWARM_ROUTES = ['/', '/api/manifex/projects', '/_not-found'];
const PREWARM_ROUTE_TIMEOUT_MS = 90_000;

// Compilation row lookup for the DB→devbox materialize step (see below).
// Must match the compiler_version that seed-compilation.mjs + the Manidex
// /generate path write under. The two magic metadata keys are skipped —
// they're not real files. Everything else in codex_files is materialized
// to /app/workspace on the devbox before setup.sh/run.sh run.
const MANIDEX_COMPILER_VERSION = 'manidex-claude-agent-sdk-v3';
const MANIDEX_STATE_SNAPSHOT_KEY = '__manidex_state_snapshot__';
const MANIDEX_PAGE_FILES_MAP_KEY = '__manidex_page_files_map__';

function supabaseAdmin() {
  return createSupabaseClient(
    process.env.SUPABASE_PROJECT_URL || '',
    process.env.SUPABASE_SERVICE_KEY || '',
    { auth: { persistSession: false } },
  );
}

// Phase 2C split — /build (pure bash, NO Claude).
//
// Runs setup.sh + run.sh on the session's devbox via /__exec. Streams
// stdout/stderr to the editor log panel via SSE. No LLM involvement —
// every click of Build is deterministic, fast, and free. /generate owns
// all Claude work; /build just executes the scripts /generate wrote.
//
// Flow:
//   1. Verify /app/workspace/setup.sh and run.sh exist (if not, return an
//      error telling the client to /generate first).
//   2. POST /__exec { cmd: 'bash setup.sh' } synchronously. Stream the
//      stdout/stderr into the SSE stream as it comes back.
//   3. If setup exit != 0, emit 'error' and stop. (Follow-up: call
//      /diagnose here — for now the client shows the stderr to the user.)
//   4. POST /__exec { cmd: 'bash run.sh', detach: true } — run.sh starts
//      the dev server in the background and exits. Detach semantics
//      keep next dev alive when our HTTP call returns.
//   5. Poll /__health + probe / until dev_running + non-stub response.
//   6. Emit 'done' with dev_port + wait_ms.
//
// SSE event types:
//   start          { devbox_url, manifest_sha }
//   setup_exit     { exit_code, duration_ms }
//   setup_stdout   { chunk }     (emitted once, after exec returns)
//   setup_stderr   { chunk }
//   run_started    { pid }
//   wait_port      { elapsed_ms, dev_running }
//   done           { dev_port, wait_ms }
//   error          { message, stage }

export const runtime = 'nodejs';
export const maxDuration = 600;

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

function sseEvent(event: string, data: unknown): Uint8Array {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${payload}\n\n`);
}

async function exec(
  base: string,
  cmd: string,
  opts: { detach?: boolean; timeoutMs?: number } = {},
): Promise<{ ok: boolean; exit_code: number; duration_ms: number; stdout: string; stderr: string; pid?: number; detached?: boolean; httpStatus?: number }> {
  const res = await fetch(`${base}/__exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, detach: !!opts.detach }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 540_000),
  });
  if (!res.ok) {
    return { ok: false, exit_code: -1, duration_ms: 0, stdout: '', stderr: `HTTP ${res.status}`, httpStatus: res.status };
  }
  const data = await res.json().catch(() => ({}));
  if (opts.detach) {
    return {
      ok: !!data?.ok,
      exit_code: 0,
      duration_ms: 0,
      stdout: '',
      stderr: '',
      detached: true,
      pid: data?.pid,
    };
  }
  return {
    ok: (data?.exit_code ?? -1) === 0,
    exit_code: typeof data?.exit_code === 'number' ? data.exit_code : -1,
    duration_ms: typeof data?.duration_ms === 'number' ? data.duration_ms : 0,
    stdout: typeof data?.stdout === 'string' ? data.stdout : '',
    stderr: typeof data?.stderr === 'string' ? data.stderr : '',
  };
}

// ---- /agent/task/* client ----------------------------------------------
//
// Gate 3: long-running commands (setup.sh = npm ci, run.sh = detached dev
// server launcher) go through the box's background-task protocol instead
// of a single long-lived /__exec HTTP call, which Fly's edge proxy kills
// around the 5-min mark. The helper POSTs /agent/task/run to spawn, then
// subscribes to /agent/task/{id}/events (SSE) and forwards stdout/stderr
// chunks to the caller via onStdout/onStderr. Resolves when the stream
// emits a terminal 'done' or 'canceled' event.
//
// timeoutMs is a wall-clock watchdog on the SSE connection, NOT on the
// box child: the box task keeps running even if the SSE aborts. If the
// watchdog fires before a terminal event arrives, the helper throws and
// leaves the task orphaned on the box (reachable later via /agent/tasks).

interface AgentTaskResult {
  task_id: string;
  exit_code: number | null;
  signal: string | null;
  canceled: boolean;
  started_at: string;
  duration_ms: number;
}

async function runAgentTask(
  base: string,
  cmd: string,
  onStdout: (chunk: string) => void,
  onStderr: (chunk: string) => void,
  opts: { timeoutMs?: number } = {},
): Promise<AgentTaskResult> {
  const started = Date.now();
  const kickRes = await fetch(`${base}/agent/task/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!kickRes.ok) {
    const t = await kickRes.text().catch(() => '');
    throw new Error(`/agent/task/run ${kickRes.status}: ${t.slice(0, 200)}`);
  }
  const kick = await kickRes.json() as { task_id: string; started_at: string };

  const eventsCtrl = new AbortController();
  const watchdog = opts.timeoutMs
    ? setTimeout(() => eventsCtrl.abort(), opts.timeoutMs)
    : null;
  const eventsRes = await fetch(`${base}/agent/task/${kick.task_id}/events`, {
    headers: { 'accept': 'text/event-stream' },
    signal: eventsCtrl.signal,
  });
  if (!eventsRes.ok || !eventsRes.body) {
    if (watchdog) clearTimeout(watchdog);
    throw new Error(`/agent/task/${kick.task_id}/events ${eventsRes.status}`);
  }

  const reader = eventsRes.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let exit_code: number | null = null;
  let signal: string | null = null;
  let canceled = false;
  let terminal = false;

  try {
    while (!terminal) {
      let chunkRead;
      try {
        chunkRead = await reader.read();
      } catch {
        break; // watchdog abort or network drop
      }
      if (chunkRead.done) break;
      buf += dec.decode(chunkRead.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dm = block.match(/^data:\s*(.+)$/m);
        if (!dm) continue;
        let payload: { kind?: string; chunk?: string; exit_code?: number | null; signal?: string | null } | null = null;
        try { payload = JSON.parse(dm[1]); } catch { continue; }
        if (!payload || typeof payload.kind !== 'string') continue;
        if (payload.kind === 'stdout' && typeof payload.chunk === 'string') {
          onStdout(payload.chunk);
        } else if (payload.kind === 'stderr' && typeof payload.chunk === 'string') {
          onStderr(payload.chunk);
        } else if (payload.kind === 'done') {
          exit_code = typeof payload.exit_code === 'number' ? payload.exit_code : null;
          signal = typeof payload.signal === 'string' ? payload.signal : null;
          terminal = true;
          break;
        } else if (payload.kind === 'canceled') {
          exit_code = typeof payload.exit_code === 'number' ? payload.exit_code : null;
          signal = typeof payload.signal === 'string' ? payload.signal : null;
          canceled = true;
          terminal = true;
          break;
        }
      }
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
    try { await reader.cancel(); } catch {}
  }
  if (!terminal) {
    throw new Error(`agent task ${kick.task_id} did not reach terminal state (timeout or stream closed)`);
  }
  return {
    task_id: kick.task_id,
    exit_code,
    signal,
    canceled,
    started_at: kick.started_at,
    duration_ms: Date.now() - started,
  };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  const devbox = getDevbox(session);
  if (!devbox) {
    return new Response(JSON.stringify({
      error: 'No devbox attached. Heartbeat should provision one within a few seconds of opening the editor.',
      reason: 'no_devbox',
    }), { status: 409, headers: { 'content-type': 'application/json' } });
  }
  const manifest_sha = session.manifest_state.sha;

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: string, data: unknown) => {
        try { controller.enqueue(sseEvent(event, data)); } catch {}
      };
      const base = devbox.url.replace(/\/+$/, '');
      emit('start', { devbox_url: devbox.url, manifest_sha });
      try {
        // ---- Materialize codex_files onto the devbox ------------------
        // Read the current compilation row by (manifest_sha, compiler_version)
        // and POST each entry to <devbox>/__write. Reserved __manifex/ keys
        // map to workspace-root paths (setup.sh, run.sh, .manifex-port); all
        // other keys write verbatim. Two magic metadata keys are skipped.
        // Makes cache-hit flows work identically to agent-run flows —
        // either way, the devbox ends up populated before setup.sh runs.
        // If no compilation row exists, we skip materialize and fall through
        // to the existing precheck (which errors with "Run /generate first").
        const { data: compRow, error: compErr } = await supabaseAdmin()
          .from('manifex_compilations')
          .select('codex_files')
          .eq('manifest_sha', manifest_sha)
          .eq('compiler_version', MANIDEX_COMPILER_VERSION)
          .maybeSingle();
        if (compErr) {
          emit('error', { stage: 'materialize', message: `compilation lookup failed: ${compErr.message}` });
          return;
        }
        if (compRow?.codex_files) {
          const files = compRow.codex_files as Record<string, unknown>;
          const entries: Array<[string, string]> = [];
          for (const [key, value] of Object.entries(files)) {
            if (key === MANIDEX_STATE_SNAPSHOT_KEY) continue;
            if (key === MANIDEX_PAGE_FILES_MAP_KEY) continue;
            if (typeof value !== 'string') continue;
            entries.push([key, value]);
          }
          const total = entries.length;
          let written = 0;
          emit('materialize_start', { total });
          for (const [key, content] of entries) {
            let path: string;
            if (key === '__manifex/setup.sh') path = 'setup.sh';
            else if (key === '__manifex/run.sh') path = 'run.sh';
            else if (key === '__manifex/port') path = '.manifex-port';
            else path = key;
            try {
              const writeRes = await fetch(`${base}/__write`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path, content }),
                signal: AbortSignal.timeout(30_000),
              });
              if (!writeRes.ok) {
                const txt = await writeRes.text().catch(() => '');
                emit('error', {
                  stage: 'materialize',
                  message: `POST /__write ${path} returned ${writeRes.status}: ${txt.slice(0, 200)}`,
                });
                return;
              }
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              emit('error', { stage: 'materialize', message: `POST /__write ${path} failed: ${msg}` });
              return;
            }
            written++;
            emit('materialize_progress', { written, total, path });
          }
          emit('materialize_done', { written, total });
        }

        // ---- Precheck: setup.sh + run.sh must exist -------------------
        const check = await exec(base, 'test -f /app/workspace/setup.sh && test -f /app/workspace/run.sh && echo OK || echo MISSING', { timeoutMs: 10_000 });
        if (!check.stdout.includes('OK')) {
          emit('error', {
            stage: 'precheck',
            message: 'setup.sh or run.sh not found in /app/workspace. Run /generate first.',
          });
          return;
        }

        // ---- setup.sh (via /agent/task/*) -----------------------------
        // setup.sh can be long (npm ci on cold deps ≈ 3-4 min), which is
        // right at Fly's ~5-min HTTP edge-proxy limit. Route it through
        // the agent task protocol so the box child outlives our SSE
        // connection, and translate stdout/stderr chunks back onto the
        // /build SSE contract (setup_stdout / setup_stderr / setup_exit)
        // so the editor doesn't notice the change of underlying transport.
        emit('setup_started', {});
        let setupResult;
        try {
          setupResult = await runAgentTask(
            base,
            'bash /app/workspace/setup.sh',
            chunk => emit('setup_stdout', { chunk }),
            chunk => emit('setup_stderr', { chunk }),
            { timeoutMs: 15 * 60 * 1000 },
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          emit('error', { stage: 'setup', message: `agent task error: ${msg}` });
          return;
        }
        emit('setup_exit', {
          exit_code: setupResult.exit_code,
          signal: setupResult.signal,
          duration_ms: setupResult.duration_ms,
          task_id: setupResult.task_id,
        });
        if (setupResult.canceled || setupResult.exit_code !== 0) {
          emit('error', {
            stage: 'setup',
            message: setupResult.canceled
              ? `setup.sh canceled (signal=${setupResult.signal ?? 'unknown'})`
              : `setup.sh exited ${setupResult.exit_code}`,
          });
          return;
        }

        // ---- run.sh (via /agent/task/*) -------------------------------
        // run.sh itself is fast (nohup launch + disown + exit 0 ≤ 1s) —
        // the long-lived dev server is a grand-child of this task and
        // keeps running after the task terminates. We use /agent/task/run
        // here instead of /__exec's detach:true so both phases share one
        // transport. SSE terminal 'done' arrives once run.sh exits; the
        // wait_port loop below then polls for the detached dev server.
        let runResult;
        try {
          runResult = await runAgentTask(
            base,
            'bash /app/workspace/run.sh',
            () => {},
            () => {},
            { timeoutMs: 60_000 },
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          emit('error', { stage: 'run', message: `agent task error: ${msg}` });
          return;
        }
        emit('run_started', {
          task_id: runResult.task_id,
          exit_code: runResult.exit_code,
          signal: runResult.signal,
        });
        if (runResult.canceled || runResult.exit_code !== 0) {
          emit('error', {
            stage: 'run',
            message: `run.sh exited ${runResult.exit_code ?? 'null'} (signal=${runResult.signal ?? 'null'})`,
          });
          return;
        }

        // ---- Wait for dev server to answer ----------------------------
        const waitStarted = Date.now();
        const MAX_WAIT_MS = 180_000;
        const POLL_MS = 1500;
        let devPort = 3000;
        let ready = false;
        while (Date.now() - waitStarted < MAX_WAIT_MS) {
          try {
            const healthRes = await fetch(`${base}/__health`, { signal: AbortSignal.timeout(5000) });
            if (healthRes.ok) {
              const health = await healthRes.json().catch(() => ({})) as { dev_port?: number };
              if (typeof health?.dev_port === 'number') devPort = health.dev_port;
            }
            const probe = await fetch(`${base}/`, { cache: 'no-store', signal: AbortSignal.timeout(5000) }).catch(() => null);
            if (probe && probe.ok) {
              const body = await probe.text().catch(() => '');
              if (!body.includes('Building your app…')) {
                ready = true;
                break;
              }
            }
          } catch {}
          emit('wait_port', { elapsed_ms: Date.now() - waitStarted });
          await new Promise(r => setTimeout(r, POLL_MS));
        }
        if (!ready) {
          emit('error', {
            stage: 'wait_port',
            message: `dev server did not respond within ${Math.round(MAX_WAIT_MS / 1000)}s`,
          });
          return;
        }

        // ── Phase A3: pre-warm major routes ──────────────────────────
        // Sequential fetches that trigger Next.js on-demand compilation
        // for each route BEFORE emitting 'done'. This blocks /build by
        // ~15-30s extra but gives the user ≤5s first-paint when the
        // iframe loads and they navigate to any pre-warmed route.
        //
        // Skip via ?skip_prewarm=1 for A/B comparison during testing.
        const skipPrewarm = new URL(req.url).searchParams.get('skip_prewarm') === '1';
        if (!skipPrewarm && PREWARM_ROUTES.length > 0) {
          const prewarmStarted = Date.now();
          let successCount = 0;
          let failureCount = 0;
          let aborted = false;
          emit('prewarm_start', { routes: PREWARM_ROUTES });

          for (const route of PREWARM_ROUTES) {
            if (aborted) break;
            const routeStarted = Date.now();
            try {
              const res = await fetch(`${base}${route}`, {
                cache: 'no-store',
                signal: AbortSignal.timeout(PREWARM_ROUTE_TIMEOUT_MS),
              });
              const compiledMs = Date.now() - routeStarted;
              const statusCode = res.status;
              // Any 2xx/3xx/4xx means the route compiled (even a 404 on
              // /api/manifex/projects is fine — the Next.js compilation
              // still happened). 502/503 means the dev server crashed or
              // is unreachable — bail to avoid hiding a real failure.
              if (statusCode >= 500) {
                emit('prewarm', { route, ok: false, status_code: statusCode, compiled_ms: compiledMs, error: `server error ${statusCode}` });
                failureCount++;
                // Bail: 5xx likely means run.sh crashed and further
                // pre-warms will all fail the same way.
                emit('prewarm_aborted', { reason: `${route} returned ${statusCode} — dev server may be down`, after_route: route });
                aborted = true;
              } else {
                emit('prewarm', { route, ok: true, status_code: statusCode, compiled_ms: compiledMs });
                successCount++;
              }
            } catch (e: unknown) {
              const compiledMs = Date.now() - routeStarted;
              const msg = e instanceof Error ? e.message : String(e);
              const isTimeout = /abort|timeout/i.test(msg);
              emit('prewarm', { route, ok: false, status_code: null, compiled_ms: compiledMs, error: isTimeout ? `timeout (${PREWARM_ROUTE_TIMEOUT_MS}ms)` : msg });
              failureCount++;
              // Timeout on a single route is non-fatal (might be a very
              // heavy page). But a connection error means the server is
              // gone — bail.
              if (!isTimeout) {
                emit('prewarm_aborted', { reason: `${route} connection failed: ${msg}`, after_route: route });
                aborted = true;
              }
            }
          }
          emit('prewarm_done', {
            total_ms: Date.now() - prewarmStarted,
            success_count: successCount,
            failure_count: failureCount,
            aborted,
          });
        }

        emit('done', { dev_port: devPort, wait_ms: Date.now() - waitStarted });
      } catch (e: any) {
        emit('error', { stage: 'unknown', message: e?.message || String(e) });
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
