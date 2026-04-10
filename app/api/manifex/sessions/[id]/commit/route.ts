import { NextResponse } from 'next/server';
import { store } from '@/lib/store';

// Phase 1 stub: returns success without actually pushing.
// Phase 5: real GitHub commit via API.

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = store.sessions.get(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // TODO Phase 5: write manifest/main.md and manifex.lock to GitHub
  return NextResponse.json({
    success: true,
    deferred: 'GitHub commit deferred to Phase 5',
    manifest_sha: session.manifest_state.sha,
  });
}
