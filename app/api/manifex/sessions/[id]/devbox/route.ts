import { NextResponse } from 'next/server';
import { getSession, getSecrets, updateSession } from '@/lib/store';
import { createDevbox, destroyDevbox, type DevboxState } from '@/lib/devbox';
import { parseEnvironmentServices, resolveDevboxSecrets } from '@/lib/manifest-services';
import { isClaudeAgentSdkBackend } from '@/lib/llm-backend';

// Secrets the Manidex local-build path must gate on BEFORE running
// /generate. These are the ones the GENERATED Manifex will need at
// RUN time (not the ones Manidex's own build loop needs — those are
// all Max OAuth + process.env on the dev machine). Manidex skips the
// SUPABASE_* family entirely because it doesn't spawn a Fly devbox,
// so devbox-spawn-time secrets don't apply.
//
// Intersected with the parsed Services declarations — if the spec
// doesn't mention one of these, it's not gated.
const MANIDEX_RUNTIME_SECRET_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'FLY_API_TOKEN',
]);

// GET — return the session's existing devbox state (or null).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const devbox = (session.manifest_state as any)?.devbox || null;
  return NextResponse.json({ devbox });
}

// POST — create the devbox if it doesn't already exist. Idempotent.
// Persists { app_name, url, machine_id, created_at } onto
// session.manifest_state.devbox so subsequent loads can pull it without
// hitting the Fly API.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  // Manidex local-build path: no Fly devbox, no spawn. Just gate on
  // the runtime-only subset of declared secrets (ANTHROPIC_API_KEY +
  // FLY_API_TOKEN) so the existing editor vault modal fires at the
  // right moment — the editor's Build flow calls this route BEFORE
  // /generate, so a 409 here triggers the modal, the user pastes, and
  // the retry falls through to /generate which writes the compilation
  // row. Nothing else happens in this branch; there's no devbox state
  // to persist onto session.manifest_state.devbox.
  if (isClaudeAgentSdkBackend()) {
    const envContent = (session.manifest_state?.pages as any)?.environment?.content || '';
    const parsed = parseEnvironmentServices(envContent);
    // Intersect declared secrets with the Manidex runtime-gate set.
    const gated = parsed.allSecretDecls.filter((d) => MANIDEX_RUNTIME_SECRET_KEYS.has(d.key));
    let vault: Record<string, string> = {};
    try {
      vault = await getSecrets(session.project_id);
    } catch (e: any) {
      console.warn(`[devbox:manidex] getSecrets(${session.project_id}) failed:`, e?.message || e);
    }
    const missing = gated.filter((d) => !vault[d.key] || vault[d.key].length === 0);
    if (missing.length > 0) {
      console.warn(
        `[devbox:manidex] blocked on missing runtime secrets for session ${id}: ${missing.map((m) => m.key).join(', ')}`,
      );
      return NextResponse.json(
        {
          error: 'missing_secrets',
          reason: 'missing_secrets',
          message: `Manidex build blocked: ${missing.length} runtime secret${missing.length === 1 ? '' : 's'} need to be vaulted before the generated Manifex can run.`,
          missing: missing.map((m) => ({
            key: m.key,
            description: m.description,
            service_name: m.service_name,
            service_description: m.service_description,
          })),
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      mode: 'manidex-local',
      message: 'Manidex local-build mode — no devbox spawn, runtime secrets present in vault.',
      gated_secrets: gated.map((d) => d.key),
    });
  }

  let existing: DevboxState | null = (session.manifest_state as any)?.devbox || null;
  if (existing?.url && existing?.machine_id) {
    // Phase 2B Path A: verify the referenced Fly machine still exists
    // before handing the stale state back. Manual deletes, failed
    // destroys, and cross-environment dev moves can leave stranded
    // pointers; self-healing here keeps the editor from trying to
    // start a machine that Fly has already forgotten about.
    const ok = await (async () => {
      try {
        const { getMachineState } = await import('@/lib/devbox');
        const state = await getMachineState(existing!.app_name, existing!.machine_id);
        return state !== 'missing';
      } catch {
        return false;
      }
    })();
    if (ok) {
      return NextResponse.json({ devbox: existing, created: false });
    }
    // Clear the stale pointer so createDevbox(sessionId) below makes a
    // fresh app + machine rather than trying to reuse an address that
    // resolves to nothing.
    console.warn(`[devbox] stale pointer for session ${id}, rebuilding`);
    const cleared = { ...session.manifest_state };
    delete (cleared as any).devbox;
    await updateSession(id, { manifest_state: cleared });
    existing = null;
  }

  // Phase 4 Path B: doc-driven secret resolution with vault-first lookup.
  // Every ALL_CAPS identifier declared under a Services section's Secrets
  // list is resolved against manifex_secrets (scoped by project_id) first,
  // then falls back to outer process.env as a transitional layer. Anything
  // still missing returns a 409 so the editor can surface the
  // prompt-for-sensitive-info UI, the user pastes the value, it lands in
  // the vault via /api/manifex/secrets, and the retry spawns cleanly.
  //
  // Recursive rule: inner Manifex runs this same code on its own Environment
  // page against its own manifex_secrets table, so a third-level devbox
  // inherits the same vault gating with no privileged outer shortcut.
  const environmentContent = (session.manifest_state?.pages as any)?.environment?.content || '';
  const parsed = parseEnvironmentServices(environmentContent);
  let vault: Record<string, string> = {};
  try {
    vault = await getSecrets(session.project_id);
  } catch (e: any) {
    console.warn(`[devbox] getSecrets(${session.project_id}) failed:`, e?.message || e);
  }
  const { env: resolvedEnv, missing } = resolveDevboxSecrets(parsed, {
    vault,
    env: process.env,
    allowEnvFallback: true,
  });
  if (missing.length > 0) {
    console.warn(
      `[devbox] blocked on missing secrets for session ${id}: ${missing.map((m) => m.key).join(', ')}`,
    );
    return NextResponse.json(
      {
        error: 'missing_secrets',
        reason: 'missing_secrets',
        message: `Cannot spawn devbox: ${missing.length} declared secret${missing.length === 1 ? '' : 's'} not in vault or environment.`,
        missing: missing.map((m) => ({
          key: m.key,
          description: m.description,
          service_name: m.service_name,
          service_description: m.service_description,
        })),
      },
      { status: 409 },
    );
  }

  const result = await createDevbox(id, { extraEnv: resolvedEnv });
  if (!result.ok) {
    const status = result.reason === 'cap_exceeded' ? 503 : 500;
    return NextResponse.json({ error: result.message, reason: result.reason }, { status });
  }

  // Persist devbox state into manifest_state.devbox. We carry every other
  // existing field forward — manifest_state.conversation in particular.
  const newManifestState = {
    ...session.manifest_state,
    devbox: result.state,
  };
  const updated = await updateSession(id, { manifest_state: newManifestState });

  return NextResponse.json({ devbox: result.state, session: updated, created: true });
}

// DELETE — tear down the Fly app for this session and clear devbox state.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  const existing: DevboxState | null = (session.manifest_state as any)?.devbox || null;
  if (!existing?.app_name) {
    return NextResponse.json({ ok: true, destroyed: false, reason: 'no devbox' });
  }

  try {
    await destroyDevbox(existing.app_name);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }

  const newManifestState = { ...session.manifest_state };
  delete (newManifestState as any).devbox;
  const updated = await updateSession(id, { manifest_state: newManifestState });

  return NextResponse.json({ ok: true, destroyed: true, session: updated });
}
