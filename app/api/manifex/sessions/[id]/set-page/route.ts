import { NextResponse } from 'next/server';
import { getSession, updateSession, makeManifestState } from '@/lib/store';
import type { TreeNode } from '@/lib/types';

// Deterministic page write. Bypasses the LLM edit pipeline for cases
// where we're declaring content (Environment page stack declaration,
// test fixtures, spec fixups) rather than asking Claude to author it.
//
// POST body: { path, title, content, position? }
//   path     — page slug, kebab-case
//   title    — human-readable title
//   content  — markdown body
//   position — optional tree index to insert at (defaults to after overview)
//
// Merges the page into session.manifest_state.pages and into the tree,
// recomputes the manifest sha, persists. Returns the updated session.

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const path = typeof body?.path === 'string' ? body.path.trim() : '';
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const content = typeof body?.content === 'string' ? body.content : '';
  const position = Number.isFinite(body?.position) ? Math.max(0, body.position) : undefined;
  if (!path || !title || !content) {
    return NextResponse.json({ error: 'path, title, content required' }, { status: 400 });
  }

  const currentPages = { ...(session.manifest_state.pages || {}) };
  const existingTree = session.manifest_state.tree || [];
  const newPages = { ...currentPages, [path]: { title, content } };

  let newTree: TreeNode[] = existingTree.filter(n => n.path !== path);
  const node: TreeNode = { path, title };
  if (position != null) {
    newTree.splice(position, 0, node);
  } else {
    // Default: insert after 'overview' if present, else append.
    const overviewIdx = newTree.findIndex(n => n.path === 'overview');
    if (overviewIdx >= 0) newTree.splice(overviewIdx + 1, 0, node);
    else newTree.push(node);
  }

  const baseManifestState = makeManifestState(newPages, newTree);
  // Preserve session-scoped fields that don't belong to (pages, tree, sha)
  // but live on manifest_state for legacy reasons: devbox attachment and
  // the v7-pivot generate_cache. makeManifestState only knows about the
  // canonical core, so we have to merge the rest back in by hand or
  // every set-page call would orphan the generate cache and the attached
  // devbox pointer.
  const newManifestState: typeof session.manifest_state = {
    ...baseManifestState,
  };
  const prior = session.manifest_state as any;
  if (prior?.devbox) (newManifestState as any).devbox = prior.devbox;
  if (prior?.generate_cache) (newManifestState as any).generate_cache = prior.generate_cache;
  if (prior?.conversation) (newManifestState as any).conversation = prior.conversation;
  const updated = await updateSession(id, { manifest_state: newManifestState });
  return NextResponse.json({ ok: true, session: updated, sha: newManifestState.sha });
}
