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

  // Withdraw is for the author. We don't enforce author equality here — the
  // UI gates that, and team auth lands in a later phase.
  const resolved = await resolveProposal(id, 'withdrawn', resolverId);
  return NextResponse.json({ proposal: resolved ?? { ...proposal, status: 'withdrawn', resolved_by: resolverId } });
}
