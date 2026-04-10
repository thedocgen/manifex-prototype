import { NextResponse } from 'next/server';
import { store } from '@/lib/store';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = store.sessions.get(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (session.redo_stack.length === 0) return NextResponse.json({ error: 'nothing to redo' }, { status: 400 });

  const next = session.redo_stack.pop()!;
  session.history.push(session.manifest_state);
  session.manifest_state = next;
  session.updated_at = new Date().toISOString();
  store.sessions.set(id, session);

  return NextResponse.json({ session });
}
