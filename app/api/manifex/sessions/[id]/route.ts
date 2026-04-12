import { NextResponse } from 'next/server';
import { getSession, getCachedCompilation } from '@/lib/store';
import { inlineCodex } from '@/lib/codex';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  // Only return cached compilation if the docs have real content
  // (more than just the starter overview page). This ensures the
  // doc-first flow: preview stays hidden until docs are built.
  const COMPILER_VERSION = 'manifex-claude-sonnet-4-v3';
  const pageCount = Object.keys(session.manifest_state.pages).length;
  let inlined_html: string | null = null;

  if (pageCount > 1) {
    const cached = await getCachedCompilation(session.manifest_state.sha, COMPILER_VERSION);
    if (cached) {
      inlined_html = inlineCodex(cached.files);
    }
  }

  return NextResponse.json({ session, inlined_html });
}
