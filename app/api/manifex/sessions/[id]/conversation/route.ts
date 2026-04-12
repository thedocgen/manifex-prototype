import { NextResponse } from 'next/server';
import { getSession, updateSession } from '@/lib/store';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const conversation = body.conversation || [];

  // Store conversation in manifest_state alongside pages/tree/sha
  const updatedManifest = { ...session.manifest_state, conversation };
  const updated = await updateSession(id, { manifest_state: updatedManifest });

  return NextResponse.json({ success: true });
}
