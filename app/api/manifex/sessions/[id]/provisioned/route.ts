import { NextResponse } from 'next/server';
import { getSession, updateSession } from '@/lib/store';

// Phase 2B Path A: called by the client orchestrator as soon as
// bash setup.sh exits 0 on the devbox. Persists the current
// manifest_sha onto session.manifest_state.devbox.last_provisioned_sha
// so the next /render for an unchanged spec can skip_setup and jump
// straight to run.sh (which is idempotent and fast — the heavy
// apt/npm/drizzle-push work already paid off).
//
// Deliberately NOT inside the render route: that route now returns
// immediately after compile, so it cannot observe setup.sh's exit
// code. The client is the only party that sees /__exec's ok:true
// response and it owns the persistence call.

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const sha = typeof body?.sha === 'string' ? body.sha : null;
  if (!sha || sha.length < 8) {
    return NextResponse.json({ error: 'sha (non-empty string) required' }, { status: 400 });
  }

  const devbox = (session.manifest_state as any)?.devbox;
  if (!devbox || !devbox.url) {
    return NextResponse.json({ error: 'session has no devbox attached' }, { status: 409 });
  }

  const newManifestState = {
    ...session.manifest_state,
    devbox: {
      ...devbox,
      last_provisioned_sha: sha,
      last_provisioned_at: new Date().toISOString(),
    },
  } as unknown as typeof session.manifest_state;

  const updated = await updateSession(id, { manifest_state: newManifestState });
  return NextResponse.json({ ok: true, session: updated });
}
