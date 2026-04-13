import { NextResponse } from 'next/server';
import { getSession, getCachedProject, putCachedProject, getSecrets } from '@/lib/store';
import { compileManifestToProject, PROJECT_COMPILER_VERSION } from '@/lib/modal';
import type { CompiledProject, ManifexSession } from '@/lib/types';

// Phase 2B Path A render route. Does the work only the server can do —
// LLM compile, cache read/write, secret injection — and returns
// immediately with the project shape plus the devbox endpoint URLs
// the client will orchestrate against.
//
// The client (app/[id]/page.tsx → renderInBackground) is responsible
// for:
//   1. POST <devbox>/__files with project.files + setup.sh + run.sh
//   2. POST <devbox>/__exec { cmd: 'bash setup.sh' }, unless skip_setup
//   3. POST <devbox>/__exec { cmd: 'bash run.sh', detach: true }
//   4. Poll <devbox>/__health until dev_running + a non-stub GET /
//   5. POST to /api/manifex/sessions/<id>/provisioned to persist the
//      current manifest_sha so the next render can skip_setup
//   6. Trigger an iframe reload
//
// Moving provisioning to the client means the manifex-wip Fly Machine
// can go idle mid-build without dropping the /render request (which
// previously capped at Fly's ~60s idle_timeout even though a cold
// apt + npm install legitimately takes 200+ seconds).

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Defensive guard: refuse to compile while a non-draft pending proposal
  // is open. The UI gates Build too, but this catches direct-API callers.
  if (session.pending_attempt && !session.pending_attempt.draft) {
    return NextResponse.json({
      error: 'You have proposed changes waiting. Click "Looks good" to accept them before building.',
      reason: 'pending_not_accepted',
    }, { status: 409 });
  }

  const manifestSha = session.manifest_state.sha;
  const devbox = getDevbox(session);

  // ---- Cache path -------------------------------------------------------
  const cached = await getCachedProject(manifestSha, PROJECT_COMPILER_VERSION);
  if (cached) {
    console.log(`[render] v7 cache HIT for sha ${manifestSha.slice(0, 12)}`);
    return renderResponse(manifestSha, cached, devbox, 'cache');
  }

  // ---- Compile path -----------------------------------------------------
  console.log(`[render] v7 cache MISS for sha ${manifestSha.slice(0, 12)}, compiling…`);
  const secrets = await getSecrets(session.project_id);
  let compiled: CompiledProject;
  try {
    compiled = await compileManifestToProject(
      session.manifest_state,
      Object.keys(secrets).length > 0 ? secrets : undefined,
    );
  } catch (e: any) {
    const msg: string = e?.message || 'unknown';
    const status: number = e?.status || 500;
    let userMessage = 'Could not build your app right now.';
    let kind = 'unknown';
    if (status === 429 || /rate.?limit/i.test(msg)) { kind = 'rate_limit'; userMessage = 'The compiler is rate-limited. Try building again in a moment.'; }
    else if (status === 401 || /api.?key/i.test(msg)) { kind = 'auth'; userMessage = 'The Anthropic API key is missing or invalid.'; }
    else if (/overload|529/i.test(msg)) { kind = 'overload'; userMessage = 'The compiler is overloaded. Try again in a few seconds.'; }
    else if (/timeout|ECONNRESET|fetch/i.test(msg)) { kind = 'network'; userMessage = 'Lost connection to the compiler. Check your internet and try again.'; }
    console.error('[render] v7 compile failed:', kind, msg);
    return NextResponse.json({ error: userMessage, kind, detail: msg }, { status });
  }

  await putCachedProject(manifestSha, PROJECT_COMPILER_VERSION, compiled);
  return renderResponse(manifestSha, compiled, devbox, 'compile');
}

interface DevboxAttached {
  url: string;
  app_name: string;
  machine_id: string;
  last_provisioned_sha?: string;
}

function getDevbox(session: ManifexSession): DevboxAttached | null {
  const d = (session.manifest_state as any)?.devbox;
  if (!d || !d.url) return null;
  return d as DevboxAttached;
}

function renderResponse(
  manifestSha: string,
  project: CompiledProject,
  devbox: DevboxAttached | null,
  source: 'cache' | 'compile'
) {
  // Bundle setup.sh and run.sh into the files map so the client only
  // has to POST a single JSON blob to /__files. The agent writes every
  // key atomically; subsequent /__exec calls can bash these scripts in
  // place without a second round-trip.
  const files: Record<string, string> = {
    ...project.files,
    'setup.sh': project.setup,
    'run.sh': project.run,
  };

  const skipSetup = devbox?.last_provisioned_sha === manifestSha;

  return NextResponse.json({
    manifest_sha: manifestSha,
    source,
    port: project.port,
    files,
    skip_setup: skipSetup,
    devbox_url: devbox?.url ?? null,
    build_log_url: devbox ? `${devbox.url.replace(/\/+$/, '')}/__logs` : null,
    health_url: devbox ? `${devbox.url.replace(/\/+$/, '')}/__health` : null,
    events_url: devbox ? `${devbox.url.replace(/\/+$/, '')}/__events` : null,
  });
}
