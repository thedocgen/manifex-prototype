import { NextResponse } from 'next/server';
import { getSession, listOpenProposals, createProposal } from '@/lib/store';
import { LOCAL_DEV_USER } from '@/lib/types';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const proposals = await listOpenProposals(id);
  return NextResponse.json({ proposals });
}

// Manually create a proposal (alternative to /prompt's auto-creation).
// Body: { prompt, proposed_manifest, diff_summary?, changed_pages? }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  if (!body.prompt || !body.proposed_manifest) {
    return NextResponse.json({ error: 'prompt and proposed_manifest required' }, { status: 400 });
  }

  const proposal = await createProposal({
    session_id: id,
    author_id: session.user_id || LOCAL_DEV_USER.id,
    base_sha: session.manifest_state.sha,
    prompt: body.prompt,
    proposed_manifest: body.proposed_manifest,
    diff_summary: body.diff_summary ?? null,
    changed_pages: body.changed_pages ?? null,
  });

  if (!proposal) {
    return NextResponse.json({ error: 'proposals table not available — apply db/migrations/003_pending_attempts.sql' }, { status: 503 });
  }
  return NextResponse.json({ proposal });
}
