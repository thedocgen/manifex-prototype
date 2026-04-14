import { getSession } from '@/lib/store';
import type { ManifexSession } from '@/lib/types';

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

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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
        // ---- Precheck: setup.sh + run.sh must exist -------------------
        const check = await exec(base, 'test -f /app/workspace/setup.sh && test -f /app/workspace/run.sh && echo OK || echo MISSING', { timeoutMs: 10_000 });
        if (!check.stdout.includes('OK')) {
          emit('error', {
            stage: 'precheck',
            message: 'setup.sh or run.sh not found in /app/workspace. Run /generate first.',
          });
          return;
        }

        // ---- setup.sh (blocking) --------------------------------------
        emit('setup_started', {});
        const setup = await exec(base, 'bash /app/workspace/setup.sh 2>&1', { timeoutMs: 540_000 });
        if (setup.stdout) emit('setup_stdout', { chunk: setup.stdout.slice(-8000) });
        if (setup.stderr) emit('setup_stderr', { chunk: setup.stderr.slice(-8000) });
        emit('setup_exit', { exit_code: setup.exit_code, duration_ms: setup.duration_ms });
        if (!setup.ok) {
          emit('error', { stage: 'setup', message: `setup.sh exited ${setup.exit_code}` });
          return;
        }

        // ---- run.sh (detach) ------------------------------------------
        const run = await exec(base, 'bash /app/workspace/run.sh', { detach: true, timeoutMs: 30_000 });
        emit('run_started', { pid: run.pid });
        if (!run.ok && !run.detached) {
          emit('error', { stage: 'run', message: 'run.sh spawn failed' });
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
