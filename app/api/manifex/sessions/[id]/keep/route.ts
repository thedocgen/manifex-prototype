import { NextResponse } from 'next/server';
import { getSession, updateSession, appendBuildHistory, getProject } from '@/lib/store';
import { LOCAL_DEV_USER } from '@/lib/types';

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

  const shaBefore = session.manifest_state.sha;
  const proposal = session.pending_attempt;
  const newHistory = [...session.history, session.manifest_state];
  const updated = await updateSession(id, {
    history: newHistory,
    manifest_state: proposal.proposed_manifest,
    pending_attempt: null,
    redo_stack: [],
  });

  // Persisted team build history (Phase 2). No-ops gracefully when the
  // table doesn't exist yet — never fail the keep on a history-write error.
  const project = await getProject(updated.project_id).catch(() => null);
  await appendBuildHistory({
    session_id: id,
    team_id: project?.team_id ?? null,
    author_id: session.user_id || LOCAL_DEV_USER.id,
    action: 'accept',
    prompt: proposal.prompt,
    diff_summary: proposal.diff_summary ?? null,
    changed_pages: proposal.changed_pages ?? null,
    sha_before: shaBefore,
    sha_after: updated.manifest_state.sha,
  });

  return NextResponse.json({ session: updated });
}
