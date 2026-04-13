import { NextResponse } from 'next/server';
import { getSession } from '@/lib/store';
import { startDevboxMachine } from '@/lib/devbox';

// Phase 2B Path A lifecycle: "boxes for dev sessions only".
// The editor tab sends a POST here every ~15s while visible. If the
// session has a devbox and its machine is stopped (because Fly auto-
// stopped it when idle, or because a prior tab explicitly stopped it
// via /stop-machine), this endpoint starts it back up. Because
// /app/workspace is a Fly volume, node_modules / .next / data.db / the
// apt-installed build toolchain survive stop/start cycles — start
// should land in a few seconds rather than re-running a 3-5 min cold
// setup.sh.
//
// Heartbeats are additive and cheap: no state writes unless the
// machine needs starting. Stale clients that disappear without
// sending a /stop-machine call still get cleaned up via the
// machine's own autostop='stop' service config.

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const devbox = (session.manifest_state as any)?.devbox as
    | { app_name?: string; machine_id?: string; url?: string }
    | undefined;
  if (!devbox || !devbox.app_name || !devbox.machine_id) {
    return NextResponse.json({ ok: true, devbox: null });
  }

  try {
    await startDevboxMachine(devbox.app_name, devbox.machine_id);
  } catch (e: any) {
    // Log and return ok — heartbeats must never break the editor tab.
    console.warn(`[heartbeat] start failed for ${devbox.app_name}/${devbox.machine_id}: ${e?.message || e}`);
    return NextResponse.json({ ok: true, started: false, error: e?.message || String(e) });
  }

  return NextResponse.json({ ok: true, started: true, devbox });
}
