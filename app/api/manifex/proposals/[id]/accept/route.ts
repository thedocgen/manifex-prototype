import { NextResponse } from 'next/server';
import { getProposal, getSession, getProject, resolveProposal, updateSession, appendBuildHistory } from '@/lib/store';
import { LOCAL_DEV_USER } from '@/lib/types';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proposal = await getProposal(id);
  if (!proposal) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (proposal.status !== 'open') return NextResponse.json({ error: `proposal already ${proposal.status}` }, { status: 400 });

  const session = await getSession(proposal.session_id);
  if (!session) return NextResponse.json({ error: 'session gone' }, { status: 404 });

  // Sha conflict guard: the session must still be at the sha this proposal
  // was built against. If someone else accepted a different proposal in
  // between, refuse.
  if (session.manifest_state.sha !== proposal.base_sha) {
    return NextResponse.json({
      error: 'The docs moved on since this proposal was opened. Reject and re-create the proposal against the latest version.',
      kind: 'sha_conflict',
      current_sha: session.manifest_state.sha,
      base_sha: proposal.base_sha,
    }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const resolverId: string = body?.resolver_id || session.user_id || LOCAL_DEV_USER.id;

  const newHistory = [...session.history, session.manifest_state];
  const updated = await updateSession(proposal.session_id, {
    history: newHistory,
    manifest_state: proposal.proposed_manifest,
    pending_attempt: null,
    redo_stack: [],
  });

  await resolveProposal(id, 'accepted', resolverId);

  const project = await getProject(updated.project_id).catch(() => null);
  await appendBuildHistory({
    session_id: proposal.session_id,
    team_id: project?.team_id ?? null,
    author_id: resolverId,
    action: 'accept',
    prompt: proposal.prompt,
    diff_summary: proposal.diff_summary ?? null,
    changed_pages: proposal.changed_pages ?? null,
    sha_before: proposal.base_sha,
    sha_after: updated.manifest_state.sha,
  });

  return NextResponse.json({ session: updated, proposal: { ...proposal, status: 'accepted', resolved_by: resolverId } });
}
