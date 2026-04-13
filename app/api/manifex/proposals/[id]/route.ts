import { NextResponse } from 'next/server';
import { getProposal, listProposalComments } from '@/lib/store';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proposal = await getProposal(id);
  if (!proposal) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const comments = await listProposalComments(id);
  return NextResponse.json({ proposal, comments });
}
