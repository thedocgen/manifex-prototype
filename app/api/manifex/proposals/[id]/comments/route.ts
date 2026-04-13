import { NextResponse } from 'next/server';
import { getProposal, listProposalComments, createProposalComment } from '@/lib/store';
import { LOCAL_DEV_USER } from '@/lib/types';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proposal = await getProposal(id);
  if (!proposal) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const comments = await listProposalComments(id);
  return NextResponse.json({ comments });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proposal = await getProposal(id);
  if (!proposal) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  if (!body.body || typeof body.body !== 'string') {
    return NextResponse.json({ error: 'body required' }, { status: 400 });
  }
  const comment = await createProposalComment({
    proposal_id: id,
    author_id: body.author_id || LOCAL_DEV_USER.id,
    body: body.body,
    page_path: body.page_path ?? null,
    section_slug: body.section_slug ?? null,
  });
  if (!comment) {
    return NextResponse.json({ error: 'comments table not available — apply db/migrations/003_pending_attempts.sql' }, { status: 503 });
  }
  return NextResponse.json({ comment });
}
