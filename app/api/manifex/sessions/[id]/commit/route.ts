import { NextResponse } from 'next/server';
import { getSession, getProject } from '@/lib/store';
import { commitFiles } from '@/lib/github';
import { COMPILER_VERSION } from '@/lib/modal';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const project = await getProject(session.project_id);
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });

  const repo = process.env.MANIFEX_GITHUB_REPO || project.github_repo;
  if (!repo || repo.startsWith('local/')) {
    return NextResponse.json({
      error: 'no GitHub repo configured for this project',
      hint: 'set MANIFEX_GITHUB_REPO env var',
    }, { status: 400 });
  }

  // Build file list: each page as manifest/<path>.md + tree.json + lock
  const files: { path: string; content: string }[] = [];

  for (const [pagePath, page] of Object.entries(session.manifest_state.pages)) {
    files.push({
      path: `manifest/${pagePath}.md`,
      content: page.content,
    });
  }

  files.push({
    path: 'manifest/tree.json',
    content: JSON.stringify(session.manifest_state.tree, null, 2) + '\n',
  });

  const lock = JSON.stringify({
    manifest_sha: session.manifest_state.sha,
    compiler_version: COMPILER_VERSION,
    committed_at: new Date().toISOString(),
    project_id: project.id,
    page_count: Object.keys(session.manifest_state.pages).length,
  }, null, 2);

  files.push({ path: 'manifex.lock', content: lock + '\n' });

  try {
    const result = await commitFiles(
      repo,
      files,
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
