import { NextResponse } from 'next/server';
import { getSession, updateSession } from '@/lib/store';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (session.redo_stack.length === 0) return NextResponse.json({ error: 'nothing to redo' }, { status: 400 });

  const newRedo = [...session.redo_stack];
  const next = newRedo.pop()!;
  const newHistory = [...session.history, session.manifest_state];

  // Carry the current conversation forward (mirrors /keep and /undo).
  // Without this the redo target's stored conversation snapshot would
  // overwrite the live thread.
  const carriedConversation = (session.manifest_state as any)?.conversation || [];
  const newManifestState = {
    ...next,
    ...(carriedConversation.length > 0 ? { conversation: carriedConversation } : {}),
  };

  const updated = await updateSession(id, {
    history: newHistory,
    redo_stack: newRedo,
    manifest_state: newManifestState,
    pending_attempt: null,
  });

  return NextResponse.json({ session: updated });
}
