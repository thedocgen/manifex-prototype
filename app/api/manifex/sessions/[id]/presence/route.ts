import { NextResponse } from 'next/server';
import { getSession, heartbeatPresence, listPresence } from '@/lib/store';
import { LOCAL_DEV_USER } from '@/lib/types';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const entries = await listPresence(id);
  return NextResponse.json({ entries });
}

// Heartbeat. Body: { user_id?, display_name?, page_path? }
// The frontend pings this every ~15s while the editor is open.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const ok = await heartbeatPresence({
    session_id: id,
    user_id: body.user_id || session.user_id || LOCAL_DEV_USER.id,
    display_name: body.display_name ?? null,
    page_path: body.page_path ?? null,
  });

  // Always return the current peer list so the client only needs one round trip per beat.
  const entries = await listPresence(id);
  return NextResponse.json({ ok, entries });
}
