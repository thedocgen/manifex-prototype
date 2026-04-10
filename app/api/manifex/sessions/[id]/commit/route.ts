import { NextResponse } from 'next/server';
import { store } from '@/lib/store';
import { commitFiles } from '@/lib/github';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = store.sessions.get(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const project = store.projects.get(session.project_id);
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });

  // Repo: use env override or project's stored repo (which is a placeholder for prototype)
  const repo = process.env.MANIFEX_GITHUB_REPO || project.github_repo;
  if (!repo || repo.startsWith('local/')) {
    return NextResponse.json({
      error: 'no GitHub repo configured for this project',
      hint: 'set MANIFEX_GITHUB_REPO env var',
    }, { status: 400 });
  }

  const lock = JSON.stringify({
    manifest_sha: session.manifest_state.sha,
    compiler_version: 'manifex-claude-sonnet-4-v1',
    committed_at: new Date().toISOString(),
    project_id: project.id,
  }, null, 2);

  try {
    const result = await commitFiles(
      repo,
      [
        { path: 'manifest/main.md', content: session.manifest_state.content },
        { path: 'manifex.lock', content: lock + '\n' },
      ],
      `manifex: commit session ${id} (sha ${session.manifest_state.sha.slice(0, 12)})`
    );

    return NextResponse.json({
      success: true,
      commit_sha: result.commit_sha,
      commit_url: result.commit_url,
      manifest_sha: session.manifest_state.sha,
    });
  } catch (e: any) {
    return NextResponse.json({
      error: 'commit failed',
      message: e.message,
    }, { status: 500 });
  }
}
