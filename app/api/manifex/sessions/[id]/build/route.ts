import { NextResponse } from 'next/server';
import { getSession } from '@/lib/store';
import type { ManifexSession, ManifestState } from '@/lib/types';

// Phase 2B pivot — /build replaces /render.
//
// Manifex no longer generates code itself. This endpoint:
//   1. Loads the session and concatenates its 7 doc pages into a single
//      markdown spec the devbox's Claude agent will read.
//   2. Returns the spec + composed goal + devbox URLs to the client.
//
// The client then POSTs <devbox_url>/__run { spec_md, goal } directly so
// the long-running Claude build (often minutes) never ties up a server
// HTTP request — manifex-wip's own Fly machine can go idle mid-build.

interface DevboxAttached {
  url: string;
  app_name: string;
  machine_id: string;
  last_provisioned_sha?: string;
}

function getDevbox(session: ManifexSession): DevboxAttached | null {
  const d = (session.manifest_state as any)?.devbox;
  if (!d || !d.url) return null;
  return d as DevboxAttached;
}

// Order the pages in a stable, canonical way so the same manifest_sha
// always produces byte-identical spec_md. Tree order is what the editor
// shows; we fall back to object key order for any pages not in the tree.
function concatenateSpec(state: ManifestState): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const push = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const page = state.pages[path];
    if (!page) return;
    parts.push(`---\npath: ${path}\ntitle: ${JSON.stringify(page.title || path)}\n---\n\n${page.content || ''}`);
  };
  for (const node of state.tree || []) push(node.path);
  for (const path of Object.keys(state.pages || {})) push(path);
  return parts.join('\n\n');
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Same defensive gate as /render used to have — don't build while a
  // non-draft proposal is open, the user would silently get a build of
  // stale content.
  if (session.pending_attempt && !session.pending_attempt.draft) {
    return NextResponse.json({
      error: 'You have proposed changes waiting. Click "Looks good" to accept them before building.',
      reason: 'pending_not_accepted',
    }, { status: 409 });
  }

  const devbox = getDevbox(session);
  if (!devbox) {
    return NextResponse.json({
      error: 'This session has no devbox attached yet. The heartbeat normally provisions one within a few seconds of opening the editor.',
      reason: 'no_devbox',
    }, { status: 409 });
  }

  const spec_md = concatenateSpec(session.manifest_state);
  const manifest_sha = session.manifest_state.sha;
  const goal = `Bring the code in /app/workspace into alignment with the latest Manifex spec (doc bundle at .manifex/spec.md). If /app/workspace is empty, create the project from scratch per the Environment page. If there's existing code, make the smallest set of edits needed to match the spec. Stop by starting the dev server in the background and writing its port to /app/workspace/.manifex-port.`;

  const base = devbox.url.replace(/\/+$/, '');
  return NextResponse.json({
    manifest_sha,
    spec_md,
    goal,
    devbox_url: devbox.url,
    run_url: `${base}/__run`,
    build_log_url: `${base}/__logs`,
    health_url: `${base}/__health`,
    events_url: `${base}/__events`,
  });
}
