import { NextResponse } from 'next/server';
import { getSession, getCachedCompilation, putCachedCompilation, getSecrets } from '@/lib/store';
import { compileManifestToCodex } from '@/lib/modal';
import { inlineCodex } from '@/lib/codex';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const COMPILER_VERSION = 'manifex-claude-sonnet-4-v3';
  const manifestSha = session.manifest_state.sha;

  // Check cache
  let compiled = await getCachedCompilation(manifestSha, COMPILER_VERSION);
  if (compiled) {
    console.log(`[render] cache HIT for sha ${manifestSha.slice(0, 12)}`);
  } else {
    console.log(`[render] cache MISS for sha ${manifestSha.slice(0, 12)}, compiling…`);
    // Fetch project secrets for injection
    const secrets = await getSecrets(session.project_id);
    compiled = await compileManifestToCodex(session.manifest_state, Object.keys(secrets).length > 0 ? secrets : undefined);
    await putCachedCompilation(manifestSha, COMPILER_VERSION, compiled);
  }

  const inlined = inlineCodex(compiled.files);

  return NextResponse.json({
    codex: compiled,
    inlined_html: inlined,
    manifest_sha: manifestSha,
  });
}
