import { NextResponse } from 'next/server';
import { getSession, updateSession } from '@/lib/store';

// Recovery endpoint for sessions where the SSE deep pass hung and left
// pending_attempt.draft=true forever. Clears the draft flag in place so
// the UI unsticks. Idempotent; safe to call when the flag is already
// cleared. Intended for manual recovery only — production code should
// not depend on this.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const pa = session.pending_attempt;
  if (!pa) return NextResponse.json({ session, cleared: false, reason: 'no pending_attempt' });
  if (!pa.draft) return NextResponse.json({ session, cleared: false, reason: 'already not draft' });

  const updated = await updateSession(id, {
    pending_attempt: { ...pa, draft: false },
  });
  return NextResponse.json({ session: updated, cleared: true });
}
