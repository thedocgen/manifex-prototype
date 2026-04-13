import { NextResponse } from 'next/server';
import { redeemTeamInvite } from '@/lib/store';
import { LOCAL_DEV_USER } from '@/lib/types';

const STATUS_FOR: Record<string, number> = {
  not_found: 404,
  expired: 410,
  exhausted: 410,
  revoked: 410,
  already_member: 409,
  tables_missing: 503,
  unknown: 500,
};

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await req.json().catch(() => ({}));
  const userId: string = body?.user_id || LOCAL_DEV_USER.id;

  const result = await redeemTeamInvite(token, userId);
  if (result.ok) {
    return NextResponse.json({ team_id: result.team_id, role: result.role });
  }
  return NextResponse.json({ error: result.message, reason: result.reason }, { status: STATUS_FOR[result.reason] || 500 });
}
