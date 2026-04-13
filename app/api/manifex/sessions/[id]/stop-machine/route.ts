import { NextResponse } from 'next/server';
import { getSession } from '@/lib/store';
import { sleepDevbox } from '@/lib/devbox';

// Phase 2B Path A lifecycle: explicit stop when the editor tab closes,
// becomes hidden for more than a short window, or the user navigates
// away. Fired via navigator.sendBeacon so it survives a tab closing.
// The machine's Fly autostop still catches orphans (network drops,
// browser crashes) — this endpoint is just the fast path.

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const devbox = (session.manifest_state as any)?.devbox as
    | { app_name?: string; machine_id?: string }
    | undefined;
  if (!devbox || !devbox.app_name || !devbox.machine_id) {
    return NextResponse.json({ ok: true, devbox: null });
  }

  try {
    await sleepDevbox(devbox.app_name, devbox.machine_id);
  } catch (e: any) {
    console.warn(`[stop-machine] failed for ${devbox.app_name}/${devbox.machine_id}: ${e?.message || e}`);
    return NextResponse.json({ ok: false, error: e?.message || String(e) });
  }

  return NextResponse.json({ ok: true, stopped: true });
}
