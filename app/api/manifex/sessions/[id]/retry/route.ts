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

  const response = await editManifest(session.manifest_state, prompt, { variation: true });

  // Retry always forces an update (no questions on retry)
  if (response.type === 'question') {
    // If LLM asks on retry, just re-run with the original approach
    return NextResponse.json({ error: 'retry produced question instead of update' }, { status: 500 });
  }

  const updated = await updateSession(id, {
    pending_attempt: {
      prompt,
      proposed_manifest: makeManifestState(response.result.pages, response.result.tree),
      diff_summary: response.result.diff_summary,
      changed_pages: response.result.changed_pages,
      attempt_number: attemptNum,
    },
  });

  return NextResponse.json({ session: updated });
}
