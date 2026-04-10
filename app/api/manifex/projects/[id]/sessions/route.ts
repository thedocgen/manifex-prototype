import { NextResponse } from 'next/server';
import { store, newId, STARTER_MANIFEST, makeManifestState } from '@/lib/store';
import { LOCAL_DEV_USER } from '@/lib/types';
import type { ManifexSession } from '@/lib/types';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const project = store.projects.get(projectId);
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });

  const id = newId('sess');
  const initialState = makeManifestState(STARTER_MANIFEST);
  const session: ManifexSession = {
    id,
    project_id: projectId,
    user_id: LOCAL_DEV_USER.id,
    base_commit_sha: 'local-init',
    manifest_state: initialState,
    history: [],
    redo_stack: [],
    pending_attempt: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  store.sessions.set(id, session);
  return NextResponse.json({ session });
}
