import { NextResponse } from 'next/server';
import { getSession, updateSession } from '@/lib/store';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (session.history.length === 0) return NextResponse.json({ error: 'nothing to undo' }, { status: 400 });

  const newHistory = [...session.history];
  const prev = newHistory.pop()!;
  const newRedo = [...session.redo_stack, session.manifest_state];

  // Carry the current conversation forward — history entries may have
  // their own (older) conversation snapshot, but the user's experience
  // is that conversation is monotonic across the session lifetime.
  // Keeping the latest conversation on the new manifest_state avoids
  // losing turns the user sees in the thread.
  const carriedConversation = (session.manifest_state as any)?.conversation || [];
  const newManifestState = {
    ...prev,
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
