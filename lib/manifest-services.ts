// Phase 4 — doc-driven services parser.
//
// The Manifex spec's Environment page has a "Services" subsection that
// declares external dependencies (Supabase, Stripe, external APIs) and
// the env-var names each one needs. Outer Manifex's devbox orchestrator
// reads this section at machine-create time and propagates matching
// outer env vars into the devbox machine env, so the inner app can
// reach its declared services without any hardcoded secret lists.
//
// Recursive rule: whatever vocabulary we establish here, the same
// parser runs on every inner level's Environment page too, so a
// third-level devbox inherits the same doc-driven secret plumbing as
// a second-level one. No privileged outer.
//
// ── Vocabulary (Environment page ### Services subsection) ──
//
// The Environment page SHOULD contain a section that looks like this:
//
//   ### Services (external dependencies)
//
//   - **Supabase Postgres** — Canonical store for sessions and projects.
//     Secrets:
//     - SUPABASE_PROJECT_URL — base URL of the Supabase project
//     - SUPABASE_SERVICE_KEY — service role key for server-side writes
//     Schema: db/schema.sql (run by setup.sh on first boot)
//
//   - **Anthropic API** — LLM calls for /prompt and /generate.
//     Secrets:
//     - ANTHROPIC_API_KEY — Claude API key
//
// The parser looks for any all-uppercase identifier (A-Z, 0-9, _; at
// least 3 chars) that appears as a bullet item under a "Secrets:"
// label in the Environment page. It also walks an explicit fenced
// code block labelled ```manifex-services for belt-and-suspenders.

export interface SecretDecl {
  key: string;
  // The human description captured from the same bullet line as the secret
  // key (everything after the em-dash / hyphen). Shown to the user when we
  // prompt for a missing secret so they know exactly what to paste.
  description: string;
  // Which service declared this secret, with the service's own one-line
  // description carried along. Used by the missing-secrets gate to group
  // prompts by service in the UI.
  service_name: string;
  service_description: string;
}

export interface ParsedService {
  name: string;
  description: string;
  secrets: string[];
  secret_decls: SecretDecl[];
}

export interface ParsedServices {
  services: ParsedService[];
  // Flat list of every secret name mentioned anywhere (backwards compat).
  allSecrets: string[];
  // Structured form — each secret carries its service + description so a
  // downstream vault resolver can produce useful missing-secret payloads.
  allSecretDecls: SecretDecl[];
}

const ENV_VAR_RE = /\b([A-Z][A-Z0-9_]{2,})\b/g;
const SERVICE_HEADER_RE = /^-\s+\*\*([^*]+)\*\*/; // "- **Service name** — ..."
const SECRETS_LABEL_RE = /^\s*(?:Secrets?)\s*:\s*$/i;

/**
 * Parse the Environment page markdown for service + secret declarations.
 * Permissive: if the page doesn't have a Services section at all, returns
 * an empty list instead of throwing. Callers decide whether absence is
 * an error.
 */
// Extract the human description from a bullet line like:
//   "    - SUPABASE_DB_URL — postgres DSN for DDL/migrations"
// Returns everything after the em-dash / hyphen / colon, or empty string.
function extractSecretDescription(line: string, key: string): string {
  const after = line.split(key)[1] || '';
  // Strip leading separators: em-dash, en-dash, hyphen, colon, whitespace.
  const trimmed = after.replace(/^[\s\u2014\u2013\-:]+/, '').trim();
  return trimmed;
}

// Extract the service-level description from the header bullet:
//   "- **Supabase Postgres** — Canonical store for ..."
function extractServiceDescription(headerLine: string): string {
  const m = headerLine.match(/\*\*[^*]+\*\*\s*[\u2014\u2013\-:]\s*(.+)$/);
  return m ? m[1].trim() : '';
}

export function parseEnvironmentServices(environmentMarkdown: string): ParsedServices {
  const services: ParsedService[] = [];
  const seen = new Set<string>();
  const allDecls: SecretDecl[] = [];

  if (!environmentMarkdown || typeof environmentMarkdown !== 'string') {
    return { services, allSecrets: [], allSecretDecls: [] };
  }

  const lines = environmentMarkdown.split('\n');

  // Strategy: walk top-to-bottom. When we see "- **Name**" start a service.
  // Under that service, collect any all-caps identifiers until we hit the
  // next "- **Name**" header or a top-level heading.
  let current: ParsedService | null = null;
  let inSecretsBlock = false;

  const pushCurrent = () => {
    if (current && current.secrets.length > 0) {
      services.push(current);
      for (const s of current.secrets) seen.add(s);
      for (const d of current.secret_decls) allDecls.push(d);
    }
    current = null;
    inSecretsBlock = false;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    // New top-level heading closes any open service.
    if (/^#{1,2}\s/.test(line)) {
      pushCurrent();
      continue;
    }
    const header = line.match(SERVICE_HEADER_RE);
    if (header) {
      pushCurrent();
      current = {
        name: header[1].trim(),
        description: extractServiceDescription(line),
        secrets: [],
        secret_decls: [],
      };
      inSecretsBlock = false;
      continue;
    }
    if (!current) continue;

    if (SECRETS_LABEL_RE.test(line)) {
      inSecretsBlock = true;
      continue;
    }

    // Under the service, a secret declaration is a bullet line whose
    // FIRST token (after the "- ") is an ALL_CAPS identifier. We only
    // capture that first token — everything after it is free-form
    // human description ("— postgres DSN for DDL/migrations") and
    // must not be treated as additional secret keys. This is the only
    // reliable way to stop description prose like DSN/DDL/RPC/URL from
    // falsely registering as env vars the vault then demands.
    const bulletKey = line.match(/^\s*-\s+([A-Z][A-Z0-9_]{2,})\b/);
    if (!bulletKey) continue;
    const name = bulletKey[1];
    if (isProseNoise(name)) continue;
    if (!current.secrets.includes(name)) {
      current.secrets.push(name);
      current.secret_decls.push({
        key: name,
        description: extractSecretDescription(line, name),
        service_name: current.name,
        service_description: current.description,
      });
    }
  }
  pushCurrent();

  // Also scan for a fenced ```manifex-services code block — a structured
  // alternative that takes precedence if present.
  const fenceMatch = environmentMarkdown.match(/```manifex-services\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    const body = fenceMatch[1];
    body.split('\n').forEach(l => {
      const m = l.match(/^[\s-]*([A-Z][A-Z0-9_]{2,})\s*:\s*(.*)$/);
      if (m && !isProseNoise(m[1])) {
        seen.add(m[1]);
        // Track fenced secrets under a synthetic service name so they
        // still show up in the services list.
        let fenced = services.find(s => s.name === 'manifex-services');
        if (!fenced) {
          fenced = {
            name: 'manifex-services',
            description: 'Fenced services block',
            secrets: [],
            secret_decls: [],
          };
          services.push(fenced);
        }
        if (!fenced.secrets.includes(m[1])) {
          fenced.secrets.push(m[1]);
          const decl: SecretDecl = {
            key: m[1],
            description: (m[2] || '').trim(),
            service_name: fenced.name,
            service_description: fenced.description,
          };
          fenced.secret_decls.push(decl);
          allDecls.push(decl);
        }
      }
    });
  }

  return { services, allSecrets: Array.from(seen), allSecretDecls: allDecls };
}

// Tokens that look like env vars but are actually prose. Extend as needed.
const PROSE_NOISE = new Set([
  'API', 'URL', 'HTTP', 'HTTPS', 'HTML', 'CSS', 'JS', 'SQL', 'JSON', 'YAML',
  'SDK', 'UI', 'UX', 'IP', 'DNS', 'TLS', 'SSL', 'ORM', 'CRUD', 'REST', 'LLM',
  'AI', 'CPU', 'RAM', 'GB', 'MB', 'KB', 'NPM', 'TODO', 'FIXME', 'NOTE',
  'CSV', 'PDF', 'PNG', 'JPG', 'GIF', 'SVG', 'MD', 'XML', 'UUID',
  'CORS', 'SSR', 'CSR', 'SSE', 'RSC', 'POST', 'GET', 'PUT', 'DELETE',
  'ISO', 'UTC', 'MIT', 'GPL', 'OS', 'VM', 'FS', 'IO', 'CLI', 'IDE',
  // SQL DDL/DML keywords that can appear in a Services Schema: line and look
  // like env vars but aren't. Extend as needed.
  'CREATE', 'TABLE', 'IF', 'NOT', 'EXISTS', 'SELECT', 'INSERT', 'UPDATE',
  'FROM', 'WHERE', 'JOIN', 'INNER', 'OUTER', 'LEFT', 'RIGHT', 'ON', 'AS',
  'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'INDEX', 'UNIQUE', 'DEFAULT',
  'NULL', 'CHECK', 'CONSTRAINT', 'ALTER', 'DROP', 'ADD', 'COLUMN',
  'TEXT', 'INTEGER', 'BIGINT', 'BOOLEAN', 'SERIAL', 'VARCHAR', 'TIMESTAMP',
  'DATE', 'TIME', 'JSONB', 'BYTEA', 'UUID_GENERATE_V4', 'NOW',
  'AND', 'OR', 'IN', 'IS', 'BY', 'ORDER', 'GROUP', 'HAVING', 'LIMIT',
]);

function isProseNoise(token: string): boolean {
  return PROSE_NOISE.has(token);
}

/**
 * Backwards-compat: given a ParsedServices + the caller's own process.env,
 * return the env map to inject into the devbox machine using env-only
 * resolution. Prefer resolveDevboxSecrets for new code — it adds vault
 * lookup and returns structured missing-secret payloads.
 */
export function buildDevboxEnvFromServices(
  parsed: ParsedServices,
  sourceEnv: NodeJS.ProcessEnv,
): { env: Record<string, string>; missing: string[] } {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of parsed.allSecrets) {
    const value = sourceEnv[name];
    if (typeof value === 'string' && value.length > 0) {
      env[name] = value;
    } else {
      missing.push(name);
    }
  }
  return { env, missing };
}

/**
 * Resolve every doc-declared secret to a concrete value, vault-first with
 * optional process.env fallback. Missing secrets come back as structured
 * SecretDecl records so the caller can prompt the user with the service
 * name + the doc description for each.
 *
 * Resolution order per secret:
 *   1. vault[key]  (manifex_secrets row for this project)
 *   2. env[key]    (outer process.env, transitional)
 *
 * When `allowEnvFallback` is false, env is ignored entirely — strict
 * vault-only mode for the target architecture. Default is true to keep
 * the transitional layer working while the vault is being populated.
 */
export function resolveDevboxSecrets(
  parsed: ParsedServices,
  opts: {
    vault: Record<string, string>;
    env?: NodeJS.ProcessEnv;
    allowEnvFallback?: boolean;
  },
): { env: Record<string, string>; missing: SecretDecl[] } {
  const envMap: Record<string, string> = {};
  const missing: SecretDecl[] = [];
  const allowEnv = opts.allowEnvFallback !== false;
  for (const decl of parsed.allSecretDecls) {
    const vaultValue = opts.vault[decl.key];
    if (typeof vaultValue === 'string' && vaultValue.length > 0) {
      envMap[decl.key] = vaultValue;
      continue;
    }
    if (allowEnv && opts.env) {
      const envValue = opts.env[decl.key];
      if (typeof envValue === 'string' && envValue.length > 0) {
        envMap[decl.key] = envValue;
        continue;
      }
    }
    missing.push(decl);
  }
  return { env: envMap, missing };
}

// ───────────────────────────────────────────────────────────────────
// REQUIRED ROUTES — doc primitive for files the build agent MUST create.
//
// The Manifex spec's "Pages and Layout" page (and any other page that
// declares server-side routes) can include a "### REQUIRED ROUTES"
// subsection listing files the generated app must have. Each bullet
// has the shape:
//
//   ### REQUIRED ROUTES
//
//   - app/api/manifex/sessions/[id]/build/route.ts — runs setup.sh + run.sh via devbox /__exec, streams SSE events
//   - app/api/manifex/sessions/[id]/devbox/health/route.ts — probes Fly machine state, returns { ready, last_check, machine_id }
//
// Motivation: earlier spec pages used a "Files" subsection with similar
// bullets, but the build agent read them as DOCUMENTATION of existing
// files ("here's what the codebase already has") instead of INSTRUCTIONS
// to create them. Net result: missing route files silently stayed
// missing across incremental edits. REQUIRED ROUTES is the prescriptive
// primitive — the system prompt teaches the agent that a REQUIRED ROUTES
// entry for a path that doesn't exist in cwd is a MUST-CREATE, not a
// "file is already here."
//
// Distinction from REQUIRED SHAPE: REQUIRED SHAPE pins the exact BYTES
// of a file (used for postcss.config.mjs, instrumentation.ts where a
// runtime constraint is non-obvious). REQUIRED ROUTES pins the EXISTENCE
// and SEMANTICS (via prose description) of a route file, leaving the
// implementation to the agent's judgment. Both compose: a file can be
// listed as REQUIRED ROUTES AND have a REQUIRED SHAPE fence elsewhere,
// in which case the fence wins.
//
// Recursive rule: every level of Manifex/Manidex uses the same
// REQUIRED ROUTES vocabulary.

export interface RequiredRouteDecl {
  /** File path relative to the project root (e.g. "app/api/foo/route.ts") */
  path: string;
  /** Prose description of the route's behavior, from the bullet line. */
  description: string;
}

export interface ParsedRequiredRoutes {
  routes: RequiredRouteDecl[];
}

// Bullet matcher: "- <path> — <description>". Accepts em-dash (U+2014),
// en-dash (U+2013), plain hyphen, or colon as the separator. The path
// must end with a recognized source extension so prose bullets that
// happen to start with a path-like token don't get swept in.
const REQUIRED_ROUTE_BULLET_RE = /^\s*-\s+(`?)([A-Za-z0-9_\-./[\]]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|sql|css|html|json|md))\1\s*[\u2014\u2013\-:]\s*(.+)$/;

// Heading matcher: any H1-H6 whose text CONTAINS "REQUIRED ROUTES"
// (case-insensitive). Keeps the primitive flexible — "### REQUIRED
// ROUTES", "## Required routes (new in v2)", "#### REQUIRED ROUTES
// — build + health" all match.
const REQUIRED_ROUTES_HEADING_RE = /^#{1,6}\s+.*REQUIRED\s+ROUTES/i;

/**
 * Parse REQUIRED ROUTES subsections out of a markdown page. Returns
 * every file-path bullet found under a "REQUIRED ROUTES" heading.
 * Stops collecting at the next heading (of any level) or EOF.
 *
 * Permissive: if the page has no REQUIRED ROUTES section, returns an
 * empty list instead of throwing.
 */
export function parseRequiredRoutes(markdown: string): ParsedRequiredRoutes {
  const routes: RequiredRouteDecl[] = [];
  if (!markdown || typeof markdown !== 'string') return { routes };

  const lines = markdown.split('\n');
  let inBlock = false;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (REQUIRED_ROUTES_HEADING_RE.test(line)) {
      inBlock = true;
      continue;
    }
    // Any subsequent heading closes the block.
    if (inBlock && /^#{1,6}\s/.test(line)) {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;

    const m = line.match(REQUIRED_ROUTE_BULLET_RE);
    if (!m) continue;
    const path = m[2].trim();
    const description = m[3].trim();
    // De-dupe on path — if the same path appears twice, keep the first.
    if (routes.some((r) => r.path === path)) continue;
    routes.push({ path, description });
  }

  return { routes };
}

/**
 * Walk a map of { pagePath: markdown } and collect REQUIRED ROUTES
 * declarations across all pages. Preserves the order pages are walked
 * so callers can bias toward the primary declaring page if the same
 * route is mentioned on multiple pages (though de-duplication already
 * keeps the first occurrence).
 */
export function parseRequiredRoutesFromPages(
  pages: Record<string, { content?: string } | string | undefined>,
): ParsedRequiredRoutes {
  const all: RequiredRouteDecl[] = [];
  const seen = new Set<string>();
  for (const [, page] of Object.entries(pages || {})) {
    const content = typeof page === 'string' ? page : page?.content;
    if (!content) continue;
    const parsed = parseRequiredRoutes(content);
    for (const r of parsed.routes) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      all.push(r);
    }
  }
  return { routes: all };
}
