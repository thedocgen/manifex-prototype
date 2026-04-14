import { NextResponse } from 'next/server';
import { getSession, updateSession } from '@/lib/store';
import { createDevbox, destroyDevbox, type DevboxState } from '@/lib/devbox';

// GET — return the session's existing devbox state (or null).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const devbox = (session.manifest_state as any)?.devbox || null;
  return NextResponse.json({ devbox });
}

// POST — create the devbox if it doesn't already exist. Idempotent.
// Persists { app_name, url, machine_id, created_at } onto
// session.manifest_state.devbox so subsequent loads can pull it without
// hitting the Fly API.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  let existing: DevboxState | null = (session.manifest_state as any)?.devbox || null;
  if (existing?.url && existing?.machine_id) {
    // Phase 2B Path A: verify the referenced Fly machine still exists
    // before handing the stale state back. Manual deletes, failed
    // destroys, and cross-environment dev moves can leave stranded
    // pointers; self-healing here keeps the editor from trying to
    // start a machine that Fly has already forgotten about.
    const ok = await (async () => {
      try {
        const { getMachineState } = await import('@/lib/devbox');
        const state = await getMachineState(existing!.app_name, existing!.machine_id);
        return state !== 'missing';
      } catch {
        return false;
      }
    })();
    if (ok) {
      return NextResponse.json({ devbox: existing, created: false });
    }
    // Clear the stale pointer so createDevbox(sessionId) below makes a
    // fresh app + machine rather than trying to reuse an address that
    // resolves to nothing.
    console.warn(`[devbox] stale pointer for session ${id}, rebuilding`);
    const cleared = { ...session.manifest_state };
    delete (cleared as any).devbox;
    await updateSession(id, { manifest_state: cleared });
    existing = null;
  }

  // Phase 4: pass the session's Environment page content so the
  // doc-driven services parser can extract declared secrets and
  // propagate matching outer env vars to the devbox at spawn time.
  const environmentContent = (session.manifest_state?.pages as any)?.environment?.content;
  const result = await createDevbox(id, { environmentContent });
  if (!result.ok) {
    const status = result.reason === 'cap_exceeded' ? 503 : 500;
    return NextResponse.json({ error: result.message, reason: result.reason }, { status });
  }

  // Persist devbox state into manifest_state.devbox. We carry every other
  // existing field forward — manifest_state.conversation in particular.
  const newManifestState = {
    ...session.manifest_state,
    devbox: result.state,
  };
  const updated = await updateSession(id, { manifest_state: newManifestState });

  return NextResponse.json({ devbox: result.state, session: updated, created: true });
}

// DELETE — tear down the Fly app for this session and clear devbox state.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const existing: DevboxState | null = (session.manifest_state as any)?.devbox || null;
  if (!existing?.app_name) {
    return NextResponse.json({ ok: true, destroyed: false, reason: 'no devbox' });
  }

  try {
    await destroyDevbox(existing.app_name);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }

  const newManifestState = { ...session.manifest_state };
  delete (newManifestState as any).devbox;
  const updated = await updateSession(id, { manifest_state: newManifestState });

  return NextResponse.json({ ok: true, destroyed: true, session: updated });
}
