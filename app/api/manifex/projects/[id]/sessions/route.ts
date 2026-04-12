import { NextResponse } from 'next/server';
import { getProject, createSession, makeStarterManifest } from '@/lib/store';
import { LOCAL_DEV_USER } from '@/lib/types';
import type { ManifestState } from '@/lib/types';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });

  // Accept optional pre-built manifest_state for instant templates
  const body = await req.json().catch(() => ({}));
  const manifestState: ManifestState = body.manifest_state || makeStarterManifest();

  const session = await createSession({
    project_id: projectId,
    user_id: LOCAL_DEV_USER.id,
    base_commit_sha: 'local-init',
    manifest_state: manifestState,
  });

  return NextResponse.json({ session });
}
