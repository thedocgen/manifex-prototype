import { NextResponse } from 'next/server';
import { getSession, getCachedProject, putCachedProject, getSecrets, updateSession } from '@/lib/store';
import { compileManifestToProject, PROJECT_COMPILER_VERSION } from '@/lib/modal';
import { provisionDevboxProject, type DevboxState } from '@/lib/devbox';
import type { CompiledProject, ManifexSession } from '@/lib/types';

// Phase 2B render route. Replaces the v1 HTML-blob compile + /__sync flow
// with the v7 multi-file compile + /__files + /__exec setup/run + port wait
// + reload flow.
//
// Flow:
//   1. Pending-proposal gate (unchanged from v1 — refuse to compile while
//      the user has unaccepted proposed changes).
//   2. Project cache lookup (manifest_sha, PROJECT_COMPILER_VERSION).
//      Cache HIT: re-provision the devbox with setup cached on the
//      session's last-provisioned sha. If the session's last provisioned
//      sha matches current manifest_sha, skip setup entirely.
//      Cache MISS: fall through to compile.
//   3. Full compile via compileManifestToProject.
//   4. putCachedProject — persist the new project shape via the reserved
//      __manifex/setup.sh / __manifex/run.sh / __manifex/port keys.
//   5. provisionDevboxProject — POST /__files, exec setup.sh (stream to
//      /__logs), exec run.sh detached, wait for port, broadcast reload.
//   6. Persist the provisioned sha back on the session so the next render
//      can skip setup if the spec didn't change.
//
// Editor log UI (chunk 5) subscribes directly to the devbox's /__logs SSE
// stream using the build_log_url returned in the response body.

const MAX_PROVISION_WAIT_MS = 240_000;

type DevboxWithProvisionedSha = DevboxState & { last_provisioned_sha?: string };

function getDevbox(session: ManifexSession): DevboxWithProvisionedSha | null {
  const d = (session.manifest_state as any)?.devbox;
  if (!d || !d.url) return null;
  return d as DevboxWithProvisionedSha;
}

async function persistProvisionedSha(
  sessionId: string,
  session: ManifexSession,
  provisionedSha: string
): Promise<void> {
  const devbox = getDevbox(session);
  if (!devbox) return;
  const updatedManifest = {
    ...session.manifest_state,
    devbox: { ...devbox, last_provisioned_sha: provisionedSha },
  } as unknown as ManifexSession['manifest_state'];
  try {
    await updateSession(sessionId, { manifest_state: updatedManifest });
  } catch (e: any) {
    console.warn(`[render] failed to persist provisioned sha: ${e?.message || e}`);
  }
}

async function provisionAndRespond(
  sessionId: string,
  session: ManifexSession,
  manifestSha: string,
  project: CompiledProject,
  sourceLabel: 'cache' | 'compile'
) {
  const devbox = getDevbox(session);
  if (!devbox) {
    // No devbox provisioned for this session yet — return the project
    // without touching a machine. The session page's Build button kicks
    // off devbox creation separately before reaching /render.
    return NextResponse.json({
      project,
      manifest_sha: manifestSha,
      source: sourceLabel,
      devbox_provisioned: false,
      detail: 'no devbox attached to session',
    });
  }

  const skipSetup = devbox.last_provisioned_sha === manifestSha;
  const provisionStarted = Date.now();
  const provision = await Promise.race([
    provisionDevboxProject(devbox.url, {
      files: project.files,
      setup: project.setup,
      run: project.run,
      port: project.port,
    }, { skipSetup }),
    new Promise<{ ok: false; stage: 'wait_port'; detail: string }>((resolve) =>
      setTimeout(
        () => resolve({ ok: false, stage: 'wait_port', detail: 'render route watchdog timeout' }),
        MAX_PROVISION_WAIT_MS
      )
    ),
  ]);
  const provisionMs = Date.now() - provisionStarted;

  const buildLogUrl = `${devbox.url.replace(/\/+$/, '')}/__logs`;

  if (!provision.ok) {
    console.warn(`[render] provision failed at ${provision.stage} after ${provisionMs}ms: ${provision.detail}`);
    return NextResponse.json({
      project,
      manifest_sha: manifestSha,
      source: sourceLabel,
      devbox_provisioned: false,
      provision: { ...provision, duration_ms: provisionMs },
      build_log_url: buildLogUrl,
      devbox_url: devbox.url,
    }, { status: 502 });
  }

  // Record that this sha is live on the devbox so future renders can
  // skip re-running setup.sh.
  await persistProvisionedSha(sessionId, session, manifestSha);

  console.log(`[render] provision OK in ${provisionMs}ms (setup_skipped=${skipSetup}, source=${sourceLabel}, port=${project.port})`);
  return NextResponse.json({
    project,
    manifest_sha: manifestSha,
    source: sourceLabel,
    devbox_provisioned: true,
    provision: { ...provision, duration_ms: provisionMs, setup_skipped: skipSetup },
    build_log_url: buildLogUrl,
    devbox_url: devbox.url,
    // Legacy-compat field: the session UI gates the iframe render on a
    // truthy `inlined_html` state value (see app/[id]/page.tsx:1532) even
    // when the iframe ultimately points at the devbox URL rather than
    // srcDoc-ing the HTML itself. Return a tiny non-null string so the
    // existing gate flips without the UI needing a chunk-5 rewrite.
    // Chunk 5 removes this reliance when it adds the build-log panel.
    inlined_html: '<!-- manifex v7: preview rendered from devbox -->',
  });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Defensive guard: refuse to compile while a non-draft pending proposal
  // is open. Otherwise the compile runs against the OLD manifest_state and
  // the user's just-generated content gets bypassed silently. The UI
  // gates Build too but this catches direct-API callers.
  if (session.pending_attempt && !session.pending_attempt.draft) {
    return NextResponse.json({
      error: 'You have proposed changes waiting. Click "Looks good" to accept them before building.',
      reason: 'pending_not_accepted',
    }, { status: 409 });
  }

  const manifestSha = session.manifest_state.sha;

  // ---- Cache path -------------------------------------------------------
  const cached = await getCachedProject(manifestSha, PROJECT_COMPILER_VERSION);
  if (cached) {
    console.log(`[render] v7 cache HIT for sha ${manifestSha.slice(0, 12)}`);
    return provisionAndRespond(id, session, manifestSha, cached, 'cache');
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
  return provisionAndRespond(id, session, manifestSha, compiled, 'compile');
}
