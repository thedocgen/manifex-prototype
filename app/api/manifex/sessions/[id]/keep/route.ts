import { NextResponse } from 'next/server';
import { store } from '@/lib/store';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = store.sessions.get(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!session.pending_attempt) return NextResponse.json({ error: 'no pending attempt' }, { status: 400 });

  // Push current state to history, advance to proposed
  session.history.push(session.manifest_state);
  session.manifest_state = session.pending_attempt.proposed_manifest;
  session.pending_attempt = null;
  session.redo_stack = []; // Forking truncates redo
  session.updated_at = new Date().toISOString();
  store.sessions.set(id, session);

  return NextResponse.json({ session });
}
