import { NextResponse } from 'next/server';
import { getSession, updateSession, makeManifestState } from '@/lib/store';
import { editManifest } from '@/lib/modal';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!session.pending_attempt) return NextResponse.json({ error: 'no pending attempt' }, { status: 400 });

  const prompt = session.pending_attempt.prompt;
  const attemptNum = session.pending_attempt.attempt_number + 1;

  const result = await editManifest(session.manifest_state.content, prompt, { variation: true });

  const updated = await updateSession(id, {
    pending_attempt: {
      prompt,
      proposed_manifest: makeManifestState(result.new_manifest),
      diff_summary: result.diff_summary,
      attempt_number: attemptNum,
    },
  });

  return NextResponse.json({ session: updated });
}
