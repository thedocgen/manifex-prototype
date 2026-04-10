import { NextResponse } from 'next/server';
import { getSession } from '@/lib/store';
import { compileManifestToCodex } from '@/lib/modal';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const compiled = await compileManifestToCodex(session.manifest_state.content);

  const { 'index.html': html, 'styles.css': css, 'app.js': js } = compiled.files;
  const inlined = html
    .replace('<link rel="stylesheet" href="styles.css" />', `<style>${css}</style>`)
    .replace('<link rel="stylesheet" href="styles.css">', `<style>${css}</style>`)
    .replace('<script src="app.js"></script>', `<script>${js}</script>`);

  return NextResponse.json({
    codex: compiled,
    inlined_html: inlined,
    manifest_sha: session.manifest_state.sha,
  });
}
