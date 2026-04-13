import { NextResponse } from 'next/server';
import { validateDiagramSpec, renderDiagramSpec } from '@/lib/diagram';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const v = validateDiagramSpec(body.spec);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  const result = await renderDiagramSpec(JSON.stringify(v.spec));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });

  return NextResponse.json({ ascii: result.ascii });
}
