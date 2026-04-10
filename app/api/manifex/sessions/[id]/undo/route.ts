import { NextResponse } from 'next/server';
import { store } from '@/lib/store';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = store.sessions.get(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (session.history.length === 0) return NextResponse.json({ error: 'nothing to undo' }, { status: 400 });

  const prev = session.history.pop()!;
  session.redo_stack.push(session.manifest_state);
  session.manifest_state = prev;
  session.pending_attempt = null;
  session.updated_at = new Date().toISOString();
  store.sessions.set(id, session);

  return NextResponse.json({ session });
}
