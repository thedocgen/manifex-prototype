import { NextResponse } from 'next/server';
import { store, newId, STARTER_MANIFEST, makeManifestState } from '@/lib/store';
import { LOCAL_DEV_USER } from '@/lib/types';
import type { ManifexProject } from '@/lib/types';

export async function GET() {
  const projects = Array.from(store.projects.values())
    .filter(p => p.user_id === LOCAL_DEV_USER.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return NextResponse.json({ projects });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name: string = body.name?.trim() || 'Untitled Project';

  const id = newId('proj');
  const project: ManifexProject = {
    id,
    user_id: LOCAL_DEV_USER.id,
    name,
    github_repo: `local/${name.toLowerCase().replace(/\s+/g, '-')}`,
    github_repo_id: null,
    default_branch: 'main',
    created_at: new Date().toISOString(),
  };

  store.projects.set(id, project);
  return NextResponse.json({ project });
}
