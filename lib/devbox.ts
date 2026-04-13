// Manifex devbox orchestrator (Phase 2A — Path A).
//
// One Fly app per Manifex session. Each app runs a single machine that
// pulls registry.fly.io/manifex-devbox-image:latest, listens on :8080, and
// serves the compiled HTML through /__sync + /__events.
//
// This module is the editor's API client for the Fly Machines REST API:
//   https://docs.machines.dev/swagger/index.html
//
// All calls require FLY_API_TOKEN (set as a secret on manifex-wip and as a
// .env.local entry locally).

const FLY_API_BASE = 'https://api.machines.dev/v1';
const FLY_ORG = 'personal';
const FLY_REGION = 'iad';
// Phase 2B pivot: v3-claude-agent is the Claude-on-the-devbox image.
// Manifex no longer compiles projects itself — each devbox runs Claude
// Code CLI in bypass-permissions mode and builds / edits /app/workspace
// from the doc bundle. v2.1-ubuntu remains in the registry as the
// previous-gen rollback target, v2-ubuntu one step before that, and
// :latest is still the original v1 HTML-blob for the ultimate rollback.
const DEVBOX_IMAGE = 'registry.fly.io/manifex-devbox-image:v3-claude-agent';
const APP_PREFIX = 'manifex-app-';
const MAX_ACTIVE_DEVBOXES = 3;

export interface DevboxState {
  app_name: string;
  url: string;
  machine_id: string;
  created_at: string;
}

function token(): string {
  const t = process.env.FLY_API_TOKEN;
  if (!t) throw new Error('FLY_API_TOKEN not set — devbox orchestrator cannot reach the Fly API');
  return t;
}

async function flyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token()}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${FLY_API_BASE}${path}`, { ...init, headers });
}

function appNameFor(sessionId: string): string {
  // Use the first 8 chars of the uuid for human-readable app names.
  // Collisions across sessions are vanishingly unlikely with 8 hex chars
  // and we cap to 3 active anyway.
  return `${APP_PREFIX}${sessionId.replace(/-/g, '').slice(0, 8)}`;
}

function publicUrl(appName: string): string {
  return `https://${appName}.fly.dev`;
}

/**
 * List apps owned by the personal org whose names start with manifex-app-.
 * Used for the active-machine cap check and for cleanup.
 */
export async function listDevboxApps(): Promise<string[]> {
  const res = await flyFetch(`/apps?org_slug=${encodeURIComponent(FLY_ORG)}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`listDevboxApps failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const apps: any[] = data?.apps || data?.Apps || [];
  return apps
    .map(a => a.name || a.Name)
    .filter((n: string) => typeof n === 'string' && n.startsWith(APP_PREFIX))
    .sort();
}

interface FlyMachine {
  id: string;
  name?: string;
  state?: string;
  region?: string;
}

async function listMachines(appName: string): Promise<FlyMachine[]> {
  const res = await flyFetch(`/apps/${encodeURIComponent(appName)}/machines`);
  if (res.status === 404) return [];
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`listMachines(${appName}) failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * How many devbox apps currently exist for the personal org. The cap is
 * enforced on PROVISIONED apps, not running machines — Fly auto-stops idle
 * machines after their grace period, but a stopped session still occupies
 * an app slot until /devbox DELETE explicitly destroys it.
 *
 * Counting started-only would let an unbounded number of apps accumulate
 * as long as fewer than 3 were running at any instant — defeating the cap.
 */
export async function countActiveDevboxes(): Promise<number> {
  const apps = await listDevboxApps();
  return apps.length;
}

/**
 * Create a Fly app for the session if it doesn't already exist. Idempotent.
 */
async function ensureApp(appName: string): Promise<void> {
  const res = await flyFetch(`/apps`, {
    method: 'POST',
    body: JSON.stringify({ app_name: appName, org_slug: FLY_ORG }),
  });
  if (res.ok) return;
  if (res.status === 422 || res.status === 409) {
    // Already exists.
    return;
  }
  const text = await res.text();
  throw new Error(`ensureApp(${appName}) failed: ${res.status} ${text}`);
}

/**
 * Allocate a shared v4 IP so the app is reachable on its public hostname.
 * Idempotent — Fly's API returns success when the allocation already exists.
 */
async function ensurePublicIp(appName: string): Promise<void> {
  // Machines API doesn't expose IP allocation directly. Use the GraphQL
  // path under api.fly.io for this. We swallow errors because Fly auto-
  // allocates a shared v4 IP for new apps in many cases — the worst case
  // is the iframe gets a 404 on first load and the user retries.
  try {
    await fetch('https://api.fly.io/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token()}`,
      },
      body: JSON.stringify({
        query: `mutation Allocate($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id address } } }`,
        variables: { input: { appId: appName, type: 'shared_v4' } },
      }),
    });
  } catch {}
}

/**
 * Ensure a Fly volume exists for the session's workspace. Volumes
 * survive machine stop/start cycles, so apt-installed packages,
 * node_modules, the Next.js .next cache, and the SQLite data.db all
 * persist across the lifecycle — a stopped box that starts back up
 * skips setup.sh entirely and run.sh comes up in seconds rather than
 * re-installing 158 npm deps from scratch every session.
 *
 * Idempotent: if a volume with the given name already exists, returns
 * it. Otherwise creates one sized at SIZE_GB in the same region the
 * machine will land in.
 */
const WORKSPACE_VOLUME_NAME = 'workspace';
const WORKSPACE_VOLUME_SIZE_GB = 5;

async function ensureWorkspaceVolume(appName: string): Promise<string> {
  // Check for an existing volume first.
  const listRes = await flyFetch(`/apps/${encodeURIComponent(appName)}/volumes`, { method: 'GET' });
  if (listRes.ok) {
    const vols = (await listRes.json().catch(() => [])) as Array<{ id?: string; name?: string; region?: string }>;
    if (Array.isArray(vols)) {
      for (const v of vols) {
        if (v && v.name === WORKSPACE_VOLUME_NAME && v.region === FLY_REGION && v.id) {
          return v.id;
        }
      }
    }
  }
  // Create a new volume.
  const createRes = await flyFetch(`/apps/${encodeURIComponent(appName)}/volumes`, {
    method: 'POST',
    body: JSON.stringify({
      name: WORKSPACE_VOLUME_NAME,
      region: FLY_REGION,
      size_gb: WORKSPACE_VOLUME_SIZE_GB,
      // No encryption for v1 — per-session ephemeral workspaces don't hold
      // anything more sensitive than the user's compiled app code, which
      // is already stored in Supabase.
    }),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`ensureWorkspaceVolume(${appName}) failed: ${createRes.status} ${text}`);
  }
  const data = await createRes.json();
  if (!data?.id) {
    throw new Error(`ensureWorkspaceVolume(${appName}) returned no id: ${JSON.stringify(data)}`);
  }
  return data.id as string;
}

/**
 * Create a single machine in the session's app, pulling the prebuilt
 * devbox image, with /app/workspace mounted from the session's Fly
 * volume so node_modules + apt state survive stop/start. Returns the
 * new machine's id.
 */
async function createMachine(appName: string, volumeId: string): Promise<string> {
  // Phase 2B pivot: the v3 agent spawns Claude Code CLI for every build,
  // which needs credentials. We pass the editor's ANTHROPIC_API_KEY
  // straight through to the devbox machine env at spawn time. This is
  // fine for v1 — devboxes are ephemeral and per-session — but we'll
  // want per-user BYOK eventually.
  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
  if (!anthropicKey) {
    console.warn('[devbox] ANTHROPIC_API_KEY missing from manifex-wip env — Claude on the devbox will 401.');
  }
  const body = {
    name: 'devbox',
    region: FLY_REGION,
    config: {
      image: DEVBOX_IMAGE,
      auto_destroy: false,
      env: {
        PORT: '8080',
        ANTHROPIC_API_KEY: anthropicKey,
      },
      mounts: [
        {
          volume: volumeId,
          path: '/app/workspace',
        },
      ],
      services: [
        {
          ports: [
            { port: 443, handlers: ['tls', 'http'] },
            { port: 80, handlers: ['http'] },
          ],
          protocol: 'tcp',
          internal_port: 8080,
          autostop: 'stop',
          autostart: true,
          min_machines_running: 0,
        },
      ],
      checks: {
        ready: {
          type: 'http',
          port: 8080,
          method: 'GET',
          path: '/__health',
          interval: '15s',
          timeout: '5s',
          grace_period: '10s',
        },
      },
      guest: {
        // Phase 2B: blank-Ubuntu devboxes install real project dependencies
        // (Next.js, better-sqlite3, etc.) inside the machine. 256 MB OOMs on
        // `npm install` alone. Jesse authorized the bump to 1 GB / 2 vCPU.
        cpu_kind: 'shared',
        cpus: 2,
        memory_mb: 1024,
      },
      restart: { policy: 'on-failure', max_retries: 3 },
    },
  };
  const res = await flyFetch(`/apps/${encodeURIComponent(appName)}/machines`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createMachine(${appName}) failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  if (!data.id) throw new Error(`createMachine(${appName}) returned no id: ${JSON.stringify(data)}`);
  return data.id;
}

export interface CreateDevboxResult {
  ok: true;
  state: DevboxState;
}
export interface CreateDevboxError {
  ok: false;
  reason: 'cap_exceeded' | 'fly_error';
  message: string;
}

/**
 * Create a devbox for a session. Idempotent — if the app already exists,
 * returns the existing app's URL and the first running machine. Enforces
 * a hard cap of MAX_ACTIVE_DEVBOXES.
 */
export async function createDevbox(sessionId: string): Promise<CreateDevboxResult | CreateDevboxError> {
  const appName = appNameFor(sessionId);

  // If the app already exists for this session, just return its state.
  try {
    const machines = await listMachines(appName);
    if (machines.length > 0) {
      return {
        ok: true,
        state: {
          app_name: appName,
          url: publicUrl(appName),
          machine_id: machines[0].id,
          created_at: new Date().toISOString(),
        },
      };
    }
  } catch {}

  // Cap check — count apps with ANY started machine.
  const active = await countActiveDevboxes();
  if (active >= MAX_ACTIVE_DEVBOXES) {
    return {
      ok: false,
      reason: 'cap_exceeded',
      message: `Devbox cap (${MAX_ACTIVE_DEVBOXES}) reached. Stop or delete an existing session before opening a new one.`,
    };
  }

  try {
    await ensureApp(appName);
    await ensurePublicIp(appName);
    const volumeId = await ensureWorkspaceVolume(appName);
    const machineId = await createMachine(appName, volumeId);
    return {
      ok: true,
      state: {
        app_name: appName,
        url: publicUrl(appName),
        machine_id: machineId,
        created_at: new Date().toISOString(),
      },
    };
  } catch (e: any) {
    return { ok: false, reason: 'fly_error', message: e?.message || String(e) };
  }
}

/**
 * POST the compiled HTML to a devbox's /__sync endpoint. The devbox writes
 * it to disk and broadcasts a reload event to the iframe over SSE.
 *
 * Best-effort: returns ok=false on failure but never throws. The render
 * route should not block the user's compile on a devbox sync issue.
 */
export async function syncDevbox(url: string, html: string): Promise<{ ok: boolean; bytes?: number; error?: string }> {
  try {
    const res = await fetch(`${url}/__sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html }),
      // Cap individual sync calls at 30s — well above any reasonable network
      // latency, but bounded so a wedged devbox doesn't tie up the render
      // route forever.
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `${res.status} ${text}`.slice(0, 200) };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, bytes: data?.bytes };
  } catch (e: any) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 200) };
  }
}

/**
 * Query the Fly Machines API for a specific machine's lifecycle state.
 * Returns 'missing' when the app or machine is 404, 'stopped' / 'started'
 * / other strings for concrete states. Used by the /devbox POST handler
 * to verify that a persisted devbox pointer still resolves before it
 * hands the pointer back to the client.
 */
export async function getMachineState(appName: string, machineId: string): Promise<string> {
  const res = await flyFetch(`/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`, { method: 'GET' });
  if (res.status === 404) return 'missing';
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`getMachineState(${appName}/${machineId}) failed: ${res.status} ${text}`);
  }
  const data = await res.json().catch(() => ({}));
  return typeof data?.state === 'string' ? data.state : 'unknown';
}

/**
 * Start a stopped machine. Idempotent — returns successfully when the
 * machine is already running. Part of the Phase 2B Path A lifecycle:
 * when a user's editor tab becomes visible, the server starts the
 * paired devbox; when the tab goes idle for 60s, the server stops it.
 * The Fly volume mounted at /app/workspace keeps setup.sh's state
 * across stop/start so cold boots are fast.
 */
export async function startDevboxMachine(appName: string, machineId: string): Promise<void> {
  const res = await flyFetch(`/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/start`, {
    method: 'POST',
  });
  if (!res.ok && res.status !== 404) {
    // 200/412 are both "fine" — 412 is Fly's "already started".
    if (res.status !== 412) {
      const text = await res.text().catch(() => '');
      throw new Error(`startDevboxMachine(${appName}/${machineId}) failed: ${res.status} ${text}`);
    }
  }
}

/**
 * Stop a machine without destroying it. Lets Fly's auto_start_machines
 * boot it back up on the next request. Used for explicit idle.
 */
export async function sleepDevbox(appName: string, machineId: string): Promise<void> {
  const res = await flyFetch(`/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}/stop`, {
    method: 'POST',
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`sleepDevbox(${appName}/${machineId}) failed: ${res.status} ${text}`);
  }
}

// ════════════════════════════════════════════════════════════════════════
// Phase 2B provisioning: POST /__files, run setup.sh, detach run.sh,
// wait for the dev-server port, broadcast a reload.
// ════════════════════════════════════════════════════════════════════════
//
// The v1 syncDevbox above POSTs a single HTML blob to /__sync on the
// v1 agent image. provisionDevboxProject is the v2 equivalent: it stages
// a full multi-file project into /app/workspace, runs the LLM-emitted
// setup.sh (streaming logs to /__logs so the editor UI can show progress),
// starts run.sh detached so the dev server keeps running after the HTTP
// request returns, waits for the proxied port to come up, and fires a
// /__reload so the iframe refreshes to the newly-running app.
//
// Everything is best-effort and structured — callers get a tagged union
// back so they can render a "setup failed" UX distinctly from "dev server
// never came up" distinctly from "files POST errored", rather than a
// collapsed boolean.

export interface ProvisionResult {
  ok: boolean;
  stage:
    | 'files'
    | 'setup'
    | 'run'
    | 'wait_port'
    | 'reload'
    | 'done';
  detail?: string;
  files_written?: number;
  setup_exit_code?: number;
  setup_duration_ms?: number;
  dev_port?: number;
  wait_ms?: number;
}

/**
 * Full provisioning sequence against a v2-ubuntu devbox agent. Should
 * complete in ~20-120s for a cached-ish setup and ~60-180s cold. The
 * caller is expected to have gated against concurrent calls on the
 * same devbox — the agent accepts concurrent /__exec calls but running
 * two setup.sh at once will trip over each other.
 */
export async function provisionDevboxProject(
  url: string,
  project: {
    files: Record<string, string>;
    setup: string;
    run: string;
    port: number;
  },
  opts: { skipSetup?: boolean } = {}
): Promise<ProvisionResult> {
  const base = url.replace(/\/+$/, '');
  // Stage all files under /app/workspace. Include setup.sh and run.sh
  // as regular files so the exec calls can bash them in place.
  const allFiles: Record<string, string> = {
    ...project.files,
    'setup.sh': project.setup,
    'run.sh': project.run,
  };

  // ---- 1. POST /__files -------------------------------------------------
  try {
    const res = await fetch(`${base}/__files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(allFiles),
      // Large payloads: a full Next.js project can be a few hundred KB.
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, stage: 'files', detail: `${res.status} ${text}`.slice(0, 300) };
    }
    const data = (await res.json().catch(() => ({}))) as { files?: number };
    const filesWritten = data.files ?? Object.keys(allFiles).length;

    // ---- 2. POST /__exec bash setup.sh (synchronous) -------------------
    let setupExitCode = 0;
    let setupDurationMs = 0;
    if (!opts.skipSetup) {
      const setupRes = await fetch(`${base}/__exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmd: 'bash setup.sh', cwd: '/app/workspace' }),
        // setup.sh can take 30-180s (apt + npm install). Generous cap.
        signal: AbortSignal.timeout(300_000),
      });
      if (!setupRes.ok) {
        const text = await setupRes.text().catch(() => '');
        return {
          ok: false,
          stage: 'setup',
          detail: `exec endpoint ${setupRes.status}: ${text}`.slice(0, 300),
          files_written: filesWritten,
        };
      }
      const setupData = (await setupRes.json().catch(() => ({}))) as {
        exit_code?: number;
        duration_ms?: number;
        ok?: boolean;
      };
      setupExitCode = setupData.exit_code ?? -1;
      setupDurationMs = setupData.duration_ms ?? 0;
      if (!setupData.ok || setupExitCode !== 0) {
        return {
          ok: false,
          stage: 'setup',
          detail: `setup.sh exited ${setupExitCode}`,
          files_written: filesWritten,
          setup_exit_code: setupExitCode,
          setup_duration_ms: setupDurationMs,
        };
      }
    }

    // ---- 3. POST /__exec bash run.sh (detached) ------------------------
    const runRes = await fetch(`${base}/__exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'bash run.sh', cwd: '/app/workspace', detach: true }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!runRes.ok) {
      const text = await runRes.text().catch(() => '');
      return {
        ok: false,
        stage: 'run',
        detail: `exec endpoint ${runRes.status}: ${text}`.slice(0, 300),
        files_written: filesWritten,
        setup_exit_code: setupExitCode,
        setup_duration_ms: setupDurationMs,
      };
    }

    // ---- 4. Wait for the proxied dev server to respond -----------------
    // We hit GET / on the agent, which proxies to 127.0.0.1:<port> inside
    // the container. While the dev server is still booting, the agent
    // returns the 200 "Building your app…" stub (a deliberate UX choice
    // so iframe users see something other than a white page). We detect
    // readiness by asking the agent /__health and reading its dev_port
    // + whether the proxied endpoint returns a Next.js response.
    const waitStarted = Date.now();
    const MAX_WAIT_MS = 180_000; // 3 min — Next.js first boot on a blank box is slow
    const POLL_MS = 1500;
    let portReady = false;
    let lastDevPort = project.port;
    while (Date.now() - waitStarted < MAX_WAIT_MS) {
      try {
        const healthRes = await fetch(`${base}/__health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (healthRes.ok) {
          const health = (await healthRes.json().catch(() => ({}))) as {
            dev_running?: boolean;
            dev_port?: number;
          };
          if (typeof health.dev_port === 'number') lastDevPort = health.dev_port;
          // dev_running just means "the detached process is alive" — not
          // that the socket is listening. Probe the proxied path too.
          if (health.dev_running) {
            const probe = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) })
              .catch(() => null);
            if (probe && probe.ok) {
              // Check if we got a real response vs. the stub. The stub
              // contains the "Building your app…" literal, Next.js won't.
              const body = await probe.text().catch(() => '');
              if (!body.includes('Building your app…')) {
                portReady = true;
                break;
              }
            }
          }
        }
      } catch {
        // Ignore transient probe errors — we'll retry on the next tick.
      }
      await new Promise(r => setTimeout(r, POLL_MS));
    }

    const waitMs = Date.now() - waitStarted;
    if (!portReady) {
      return {
        ok: false,
        stage: 'wait_port',
        detail: `dev server did not respond within ${Math.round(waitMs / 1000)}s`,
        files_written: filesWritten,
        setup_exit_code: setupExitCode,
        setup_duration_ms: setupDurationMs,
        dev_port: lastDevPort,
        wait_ms: waitMs,
      };
    }

    // ---- 5. Fire a reload broadcast ------------------------------------
    // The agent's /__reload convenience endpoint handles the SSE fan-out
    // for us. Fire-and-forget: the iframe will have already been polling
    // /__events since the user opened the session.
    fetch(`${base}/__reload`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});

    return {
      ok: true,
      stage: 'done',
      files_written: filesWritten,
      setup_exit_code: setupExitCode,
      setup_duration_ms: setupDurationMs,
      dev_port: lastDevPort,
      wait_ms: waitMs,
    };
  } catch (e: any) {
    return {
      ok: false,
      stage: 'files',
      detail: (e?.message || String(e)).slice(0, 300),
    };
  }
}

/**
 * Destroy the entire app for a session. Releases the IP and removes all
 * machines. Used for explicit session deletion.
 */
export async function destroyDevbox(appName: string): Promise<void> {
  const res = await flyFetch(`/apps/${encodeURIComponent(appName)}?force=true`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`destroyDevbox(${appName}) failed: ${res.status} ${text}`);
  }
}
