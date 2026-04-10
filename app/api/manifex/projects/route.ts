import { NextResponse } from 'next/server';
import { listProjects, createProject } from '@/lib/store';
import { LOCAL_DEV_USER } from '@/lib/types';

export async function GET() {
  const projects = await listProjects(LOCAL_DEV_USER.id);
  return NextResponse.json({ projects });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name: string = body.name?.trim() || 'Untitled Project';

  const project = await createProject({
    user_id: LOCAL_DEV_USER.id,
    name,
    github_repo: `local/${name.toLowerCase().replace(/\s+/g, '-')}`,
  });

  return NextResponse.json({ project });
}
