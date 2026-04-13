import { NextResponse } from 'next/server';
import { getTeamInviteByToken, getTeam } from '@/lib/store';

// Preview an invite without redeeming it. Used by the join page to show
// "You're being invited to <team> as <role>".
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await getTeamInviteByToken(token);
  if (!invite) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (invite.revoked_at) return NextResponse.json({ error: 'revoked' }, { status: 410 });
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'expired' }, { status: 410 });
  }
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
    return NextResponse.json({ error: 'exhausted' }, { status: 410 });
  }
  const team = await getTeam(invite.team_id);
  return NextResponse.json({
    invite: {
      team_id: invite.team_id,
      team_name: team?.name || 'Unknown team',
      role_on_join: invite.role_on_join,
      expires_at: invite.expires_at,
      uses_remaining: invite.max_uses === null ? null : invite.max_uses - invite.uses,
    },
  });
}
