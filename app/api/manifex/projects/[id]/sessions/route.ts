import { NextResponse } from 'next/server';
import { getProject, createSession, STARTER_MANIFEST, makeManifestState } from '@/lib/store';
import { LOCAL_DEV_USER } from '@/lib/types';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });

  const session = await createSession({
    project_id: projectId,
    user_id: LOCAL_DEV_USER.id,
    base_commit_sha: 'local-init',
    manifest_state: makeManifestState(STARTER_MANIFEST),
  });

  return NextResponse.json({ session });
}
