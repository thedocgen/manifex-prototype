import { NextResponse } from 'next/server';
import { store, makeManifestState } from '@/lib/store';
import { editManifest } from '@/lib/modal';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = store.sessions.get(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!session.pending_attempt) return NextResponse.json({ error: 'no pending attempt' }, { status: 400 });

  const prompt = session.pending_attempt.prompt;
  const attemptNum = session.pending_attempt.attempt_number + 1;

  // Re-run with same prompt; in stub mode, suffix attempt number to vary output
  const stubPrompt = process.env.MANIFEX_COMPILER_URL ? prompt : `${prompt} (variation ${attemptNum})`;
  const result = await editManifest(session.manifest_state.content, stubPrompt);

  session.pending_attempt = {
    prompt,
    proposed_manifest: makeManifestState(result.new_manifest),
    diff_summary: result.diff_summary,
    attempt_number: attemptNum,
  };
  session.updated_at = new Date().toISOString();
  store.sessions.set(id, session);

  return NextResponse.json({ session });
}
