import { NextResponse } from 'next/server';
import { getSession, listBuildHistory } from '@/lib/store';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const entries = await listBuildHistory(id, 100);
  return NextResponse.json({ entries });
}
