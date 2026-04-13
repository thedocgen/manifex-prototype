import { NextResponse } from 'next/server';
import { getSession, updateSession } from '@/lib/store';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!session.pending_attempt) return NextResponse.json({ error: 'no pending attempt' }, { status: 400 });

  // Optimistic concurrency: refuse to accept a proposal if the base manifest
  // has moved on since the proposal was created (i.e. another team member
  // accepted something else first). The pending_attempt embeds the original
  // base sha implicitly via the proposal — we additionally accept an
  // expected_sha from the client for extra defence.
  const body = await req.json().catch(() => ({}));
  const expectedSha: string | undefined = body?.expected_sha;
  if (expectedSha && expectedSha !== session.manifest_state.sha) {
    return NextResponse.json({
      error: 'Someone else updated the docs while this proposal was open. Refresh and review again.',
      kind: 'sha_conflict',
      current_sha: session.manifest_state.sha,
      expected_sha: expectedSha,
      session,
    }, { status: 409 });
  }

  const newHistory = [...session.history, session.manifest_state];
  const updated = await updateSession(id, {
    history: newHistory,
    manifest_state: session.pending_attempt.proposed_manifest,
    pending_attempt: null,
    redo_stack: [],
  });

  return NextResponse.json({ session: updated });
}
