import { NextResponse } from 'next/server';
import { getProposal, resolveProposal } from '@/lib/store';
import { LOCAL_DEV_USER } from '@/lib/types';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proposal = await getProposal(id);
  if (!proposal) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (proposal.status !== 'open') return NextResponse.json({ error: `proposal already ${proposal.status}` }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const resolverId: string = body?.resolver_id || LOCAL_DEV_USER.id;

  const resolved = await resolveProposal(id, 'rejected', resolverId);
  return NextResponse.json({ proposal: resolved ?? { ...proposal, status: 'rejected', resolved_by: resolverId } });
}
