import { NextResponse } from 'next/server';
import { getSession, updateSession, makeManifestState } from '@/lib/store';
import { editManifest } from '@/lib/modal';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const prompt: string = (body.prompt || '').trim();
  if (!prompt) return NextResponse.json({ error: 'prompt required' }, { status: 400 });

  const result = await editManifest(session.manifest_state, prompt);
  const proposed = makeManifestState(result.pages, result.tree);

  const updated = await updateSession(id, {
    pending_attempt: {
      prompt,
      proposed_manifest: proposed,
      diff_summary: result.diff_summary,
      changed_pages: result.changed_pages,
      attempt_number: 1,
    },
  });

  return NextResponse.json({ session: updated });
}
