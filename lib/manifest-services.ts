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

export interface ParsedService {
  name: string;
  secrets: string[];
}

export interface ParsedServices {
  services: ParsedService[];
  // Flat list of every secret name mentioned anywhere.
  allSecrets: string[];
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
export function parseEnvironmentServices(environmentMarkdown: string): ParsedServices {
  const services: ParsedService[] = [];
  const seen = new Set<string>();

  if (!environmentMarkdown || typeof environmentMarkdown !== 'string') {
    return { services, allSecrets: [] };
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
      current = { name: header[1].trim(), secrets: [] };
      inSecretsBlock = false;
      continue;
    }
    if (!current) continue;

    if (SECRETS_LABEL_RE.test(line)) {
      inSecretsBlock = true;
      continue;
    }

    // Under the service, any all-caps identifier counts as a secret — but
    // we require it to appear on a bullet line (starts with "-" after
    // optional whitespace) OR to be under an explicit Secrets: label.
    const isBullet = /^\s*-\s/.test(line);
    if (!isBullet && !inSecretsBlock) continue;

    let match: RegExpExecArray | null;
    ENV_VAR_RE.lastIndex = 0;
    while ((match = ENV_VAR_RE.exec(line))) {
      const name = match[1];
      // Filter out common prose-noise matches.
      if (isProseNoise(name)) continue;
      if (!current.secrets.includes(name)) current.secrets.push(name);
    }
  }
  pushCurrent();

  // Also scan for a fenced ```manifex-services code block — a structured
  // alternative that takes precedence if present.
  const fenceMatch = environmentMarkdown.match(/```manifex-services\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    const body = fenceMatch[1];
    body.split('\n').forEach(l => {
      const m = l.match(/^[\s-]*([A-Z][A-Z0-9_]{2,})\s*:/);
      if (m && !isProseNoise(m[1])) {
        seen.add(m[1]);
        // Track fenced secrets under a synthetic service name so they
        // still show up in the services list.
        let fenced = services.find(s => s.name === 'manifex-services');
        if (!fenced) {
          fenced = { name: 'manifex-services', secrets: [] };
          services.push(fenced);
        }
        if (!fenced.secrets.includes(m[1])) fenced.secrets.push(m[1]);
      }
    });
  }

  return { services, allSecrets: Array.from(seen) };
}

// Tokens that look like env vars but are actually prose. Extend as needed.
const PROSE_NOISE = new Set([
  'API', 'URL', 'HTTP', 'HTTPS', 'HTML', 'CSS', 'JS', 'SQL', 'JSON', 'YAML',
  'SDK', 'UI', 'UX', 'IP', 'DNS', 'TLS', 'SSL', 'ORM', 'CRUD', 'REST', 'LLM',
  'AI', 'CPU', 'RAM', 'GB', 'MB', 'KB', 'NPM', 'TODO', 'FIXME', 'NOTE',
  'CSV', 'PDF', 'PNG', 'JPG', 'GIF', 'SVG', 'MD', 'XML', 'UUID',
  'CORS', 'SSR', 'CSR', 'SSE', 'RSC', 'POST', 'GET', 'PUT', 'DELETE',
  'ISO', 'UTC', 'MIT', 'GPL', 'OS', 'VM', 'FS', 'IO', 'CLI', 'IDE',
]);

function isProseNoise(token: string): boolean {
  return PROSE_NOISE.has(token);
}

/**
 * Given a ParsedServices + the caller's own process.env, return the env
 * map to inject into the devbox machine. Only names that (a) are
 * declared as secrets in the doc AND (b) exist in caller env are
 * propagated. Returns a { env, missing } tuple so callers can warn or
 * prompt the user about missing declared secrets.
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
