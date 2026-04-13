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

  const existing: DevboxState | null = (session.manifest_state as any)?.devbox || null;
  if (existing?.url && existing?.machine_id) {
    return NextResponse.json({ devbox: existing, created: false });
  }

  const result = await createDevbox(id);
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
