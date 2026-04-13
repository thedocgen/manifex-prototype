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
const DEVBOX_IMAGE = 'registry.fly.io/manifex-devbox-image:latest';
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
 * How many devbox apps are currently active (have at least one machine in
 * a started/starting state). Used for the cap check before creation.
 */
export async function countActiveDevboxes(): Promise<number> {
  const apps = await listDevboxApps();
  let active = 0;
  for (const appName of apps) {
    try {
      const machines = await listMachines(appName);
      if (machines.some(m => /start|running/i.test(m.state || ''))) active++;
    } catch {}
  }
  return active;
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
 * Create a single machine in the session's app, pulling the prebuilt
 * devbox image. Returns the new machine's id.
 */
async function createMachine(appName: string): Promise<string> {
  const body = {
    name: 'devbox',
    region: FLY_REGION,
    config: {
      image: DEVBOX_IMAGE,
      auto_destroy: false,
      env: { PORT: '8080' },
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
          method: 'GET',
          path: '/__health',
          interval: '15s',
          timeout: '5s',
          grace_period: '10s',
        },
      },
      guest: {
        cpu_kind: 'shared',
        cpus: 1,
        memory_mb: 256,
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
    const machineId = await createMachine(appName);
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
