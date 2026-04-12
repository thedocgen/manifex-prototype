import { NextResponse } from 'next/server';
import { getSession, getCachedCompilation } from '@/lib/store';
import { inlineCodex } from '@/lib/codex';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  // Check for a cached compilation of the current manifest. If present,
  // return the inlined HTML so the frontend can auto-populate the iframe.
  const COMPILER_VERSION = 'manifex-claude-sonnet-4-v2';
  const cached = await getCachedCompilation(session.manifest_state.sha, COMPILER_VERSION);
  let inlined_html: string | null = null;
  if (cached) {
    inlined_html = inlineCodex(cached.files);
  }

  return NextResponse.json({ session, inlined_html });
}
