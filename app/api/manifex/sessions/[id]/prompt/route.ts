import { NextResponse } from 'next/server';
import { store, makeManifestState } from '@/lib/store';
import { editManifest } from '@/lib/modal';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = store.sessions.get(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const prompt: string = (body.prompt || '').trim();
  if (!prompt) return NextResponse.json({ error: 'prompt required' }, { status: 400 });

  const result = await editManifest(session.manifest_state.content, prompt);
  const proposed = makeManifestState(result.new_manifest);

  session.pending_attempt = {
    prompt,
    proposed_manifest: proposed,
    diff_summary: result.diff_summary,
    attempt_number: 1,
  };
  session.updated_at = new Date().toISOString();
  store.sessions.set(id, session);

  return NextResponse.json({ session });
}
