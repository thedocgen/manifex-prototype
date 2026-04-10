import { NextResponse } from 'next/server';
import { getSession, updateSession } from '@/lib/store';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const updated = await updateSession(id, { pending_attempt: null });
  return NextResponse.json({ session: updated });
}
