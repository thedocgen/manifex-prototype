import { NextResponse } from 'next/server';
import { getTeam, listTeamInvites, createTeamInvite } from '@/lib/store';
import { LOCAL_DEV_USER, type TeamRole } from '@/lib/types';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const team = await getTeam(id);
  if (!team) return NextResponse.json({ error: 'team not found' }, { status: 404 });
  const invites = await listTeamInvites(id);
  return NextResponse.json({ invites });
}

// Body: { role_on_join?: 'owner'|'editor'|'viewer', expires_at?: ISO string, max_uses?: number, created_by?: string }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const team = await getTeam(id);
  if (!team) return NextResponse.json({ error: 'team not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const role: TeamRole = (body.role_on_join as TeamRole) || 'editor';
  if (!['owner', 'editor', 'viewer'].includes(role)) {
    return NextResponse.json({ error: 'invalid role_on_join' }, { status: 400 });
  }

  const invite = await createTeamInvite({
    team_id: id,
    created_by: body.created_by || LOCAL_DEV_USER.id,
    role_on_join: role,
    expires_at: body.expires_at ?? null,
    max_uses: typeof body.max_uses === 'number' ? body.max_uses : null,
  });
  if (!invite) {
    return NextResponse.json({ error: 'invites table not available — apply db/migrations/004_team_invites.sql' }, { status: 503 });
  }
  return NextResponse.json({ invite });
}
