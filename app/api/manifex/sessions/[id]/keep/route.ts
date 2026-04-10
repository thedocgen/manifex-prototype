import { NextResponse } from 'next/server';
import { getSession, updateSession } from '@/lib/store';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!session.pending_attempt) return NextResponse.json({ error: 'no pending attempt' }, { status: 400 });

  const newHistory = [...session.history, session.manifest_state];
  const updated = await updateSession(id, {
    history: newHistory,
    manifest_state: session.pending_attempt.proposed_manifest,
    pending_attempt: null,
    redo_stack: [],
  });

  return NextResponse.json({ session: updated });
}
