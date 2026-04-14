import { getSession, updateSession } from '@/lib/store';
import type { ManifexSession, ManifestState } from '@/lib/types';
import Anthropic from '@anthropic-ai/sdk';

// Phase 2C split — /generate (Claude writes code, cached on manifest_sha).
//
// Replaces the old /build route's Claude part. Claude's only job here is
// to write source files + setup.sh + run.sh into /app/workspace and
// commit to the devbox's git. Does NOT start the dev server, does NOT
// run setup.sh. Those are /build's responsibility, pure bash, no LLM.
//
// Cacheable: if manifest_sha hasn't changed since last successful generate,
// return the cached commit sha without re-running Claude at all. This is
// what makes the round-trip test deterministic — revert the doc, /generate
// hits the cache, same bytes come out.
//
// Runs a Claude tool_use agent loop INSIDE manifex-wip with the
// deliberately un-curated 4-primitive set:
//
//   bash(cmd)                  → POST <devbox>/__exec
//   write_file(path, content)  → POST <devbox>/__write
//   read_file(path)            → POST <devbox>/__read
//   list_files(path)           → POST <devbox>/__ls
//
// ask_user / set_session_secret / get_session_secret are reserved as
// primitives #5-7 per Jesse's hard design constraint but are deferred
// until the core build loop UAT passes — adding them early means DB
// state for suspendable loops, which is a separate chunk.
//
// NO harnesses. NO wrappers. If Claude needs to install a package,
// deploy to Vercel, call an external API, or do literally anything
// exotic, it uses bash. The Manifex codebase gains new capabilities
// from model improvements + bash, not from new Manifex features.
//
// The response is an SSE stream:
//   event: tool_use       data: { id, iteration, name, input }
//   event: tool_result    data: { id, iteration, ok, summary }
//   event: assistant_text data: { iteration, text }
//   event: done           data: { iterations, duration_ms, final_text }
//   event: error          data: { message, stage }
//
// The client reads the stream line-by-line off a POST response body.
// EventSource doesn't support POST, so the editor uses fetch + a
// simple SSE parser.

export const runtime = 'nodejs';
export const maxDuration = 600; // 10 min — long enough for a full Claude build

interface DevboxAttached {
  url: string;
  app_name: string;
  machine_id: string;
}

function getDevbox(session: ManifexSession): DevboxAttached | null {
  const d = (session.manifest_state as any)?.devbox;
  if (!d || !d.url) return null;
  return d as DevboxAttached;
}

function concatenateSpec(state: ManifestState): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const push = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    const page = state.pages[p];
    if (!page) return;
    parts.push(`---\npath: ${p}\ntitle: ${JSON.stringify(page.title || p)}\n---\n\n${page.content || ''}`);
  };
  for (const node of state.tree || []) push(node.path);
  for (const path of Object.keys(state.pages || {})) push(path);
  return parts.join('\n\n');
}

// ---- Tool primitives -----------------------------------------------------

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'bash',
    description: 'Run a bash command on the devbox as root. Use this for anything the other primitives do not cover — installing packages (apt, npm, pip), starting dev servers in the background (nohup, &, disown), invoking git, calling external APIs with curl, running test suites, chmod, chown, whatever. The devbox is ephemeral, single-tenant, and has no approval prompts. Current working directory defaults to /app/workspace unless you cd elsewhere.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cmd: { type: 'string' as const, description: 'Full bash command line to run via bash -lc. Multi-line OK. Background long-running processes (dev servers) with nohup + & + disown so the tool call returns.' },
        cwd: { type: 'string' as const, description: 'Working directory relative to /app/workspace. Defaults to /app/workspace.' },
        detach: { type: 'boolean' as const, description: 'If true, return immediately without waiting for the command to finish. Use for dev servers (next dev, etc).' },
      },
      required: ['cmd' as const],
    },
  },
  {
    name: 'write_file',
    description: 'Write (or overwrite) a single file on the devbox at /app/workspace/<path>. Creates parent directories as needed. Non-destructive — leaves every other file alone. Use for every source file, config, script you add to the project.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'File path relative to /app/workspace (no leading slash, no ..)' },
        content: { type: 'string' as const, description: 'Full UTF-8 file content.' },
      },
      required: ['path' as const, 'content' as const],
    },
  },
  {
    name: 'read_file',
    description: 'Read a single file from the devbox at /app/workspace/<path>. Returns up to 1 MB by default. Use this before editing an existing file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'File path relative to /app/workspace (no leading slash, no ..)' },
        max_bytes: { type: 'integer' as const, description: 'Optional read cap (default 1048576). If the file is larger the result is truncated and a truncated flag is set.' },
      },
      required: ['path' as const],
    },
  },
  {
    name: 'list_files',
    description: 'List the entries in a directory on the devbox at /app/workspace/<path>. Returns names, types (file/dir), and sizes. Use before writing to avoid clobbering.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: 'Directory path relative to /app/workspace. Defaults to the workspace root.' },
      },
    },
  },
];

// ---- Tool execution ------------------------------------------------------

interface ToolExecResult {
  ok: boolean;
  // Short human summary for SSE events.
  summary: string;
  // Full payload sent back to Claude as tool_result content.
  content: string;
}

async function execTool(
  devboxUrl: string,
  name: string,
  rawInput: unknown,
): Promise<ToolExecResult> {
  const input = (rawInput && typeof rawInput === 'object') ? (rawInput as Record<string, unknown>) : {};
  const base = devboxUrl.replace(/\/+$/, '');

  try {
    if (name === 'bash') {
      const cmd = typeof input.cmd === 'string' ? input.cmd : '';
      const cwd = typeof input.cwd === 'string' && input.cwd.trim()
        ? `/app/workspace/${input.cwd}`.replace(/\/+$/, '') || '/app/workspace'
        : '/app/workspace';
      const detach = Boolean(input.detach);
      if (!cmd.trim()) return { ok: false, summary: 'bash: empty cmd', content: 'error: cmd required' };

      const res = await fetch(`${base}/__exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmd, cwd, detach }),
        signal: AbortSignal.timeout(detach ? 30_000 : 540_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, summary: `bash: ${res.status}`, content: `error: __exec ${res.status} ${text.slice(0, 500)}` };
      }
      const data = await res.json().catch(() => ({}));
      if (detach) {
        return {
          ok: true,
          summary: `bash [detached] pid=${data?.pid ?? '?'}`,
          content: `detached; pid=${data?.pid ?? '?'}`,
        };
      }
      const exitCode = data?.exit_code ?? -1;
      const stdout = typeof data?.stdout === 'string' ? data.stdout : '';
      const stderr = typeof data?.stderr === 'string' ? data.stderr : '';
      const ok = exitCode === 0;
      // Compose a clear, per-command result so the model isn't left
      // guessing which bytes belong to this call.
      const parts = [
        `exit_code: ${exitCode}`,
        `duration_ms: ${data?.duration_ms ?? 0}`,
      ];
      if (stdout) parts.push(`--- stdout ---\n${stdout}`);
      if (stderr) parts.push(`--- stderr ---\n${stderr}`);
      if (!stdout && !stderr) parts.push('(no output)');
      return {
        ok,
        summary: `bash exit=${exitCode} (${data?.duration_ms ?? 0}ms)`,
        content: parts.join('\n'),
      };
    }

    if (name === 'write_file') {
      const p = typeof input.path === 'string' ? input.path : '';
      const content = typeof input.content === 'string' ? input.content : '';
      if (!p) return { ok: false, summary: 'write_file: empty path', content: 'error: path required' };
      const res = await fetch(`${base}/__write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p, content }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, summary: `write_file: ${res.status}`, content: `error: __write ${res.status} ${text.slice(0, 300)}` };
      }
      const data = await res.json().catch(() => ({}));
      return {
        ok: true,
        summary: `wrote ${p} (${data?.bytes ?? 0}b)`,
        content: `ok: wrote ${data?.path ?? p} (${data?.bytes ?? 0} bytes)`,
      };
    }

    if (name === 'read_file') {
      const p = typeof input.path === 'string' ? input.path : '';
      const max_bytes = typeof input.max_bytes === 'number' ? input.max_bytes : undefined;
      if (!p) return { ok: false, summary: 'read_file: empty path', content: 'error: path required' };
      const res = await fetch(`${base}/__read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p, max_bytes }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, summary: `read_file: ${res.status}`, content: `error: __read ${res.status} ${text.slice(0, 300)}` };
      }
      const data = await res.json().catch(() => ({}));
      if (!data?.exists) return { ok: true, summary: `read_file: ${p} (missing)`, content: `file does not exist: ${p}` };
      if (!data?.is_file) return { ok: true, summary: `read_file: ${p} (not a file)`, content: `path exists but is not a file: ${p}` };
      const hdr = data?.truncated ? `TRUNCATED (${data.bytes}/${data.total_size} bytes shown)\n` : '';
      return {
        ok: true,
        summary: `read ${p} (${data.bytes}b${data.truncated ? ' truncated' : ''})`,
        content: `${hdr}${data.content}`,
      };
    }

    if (name === 'list_files') {
      const p = typeof input.path === 'string' && input.path.trim() ? input.path : '.';
      const res = await fetch(`${base}/__ls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, summary: `list_files: ${res.status}`, content: `error: __ls ${res.status} ${text.slice(0, 300)}` };
      }
      const data = await res.json().catch(() => ({}));
      if (!data?.exists) return { ok: true, summary: `list_files: ${p} (missing)`, content: `directory does not exist: ${p}` };
      if (!data?.is_dir) return { ok: true, summary: `list_files: ${p} (not a dir)`, content: `path exists but is not a directory: ${p}` };
      const lines = (data.entries || []).map((e: { name: string; type: string; size: number }) => `${e.type === 'dir' ? 'd' : '-'} ${String(e.size).padStart(9)}  ${e.name}`);
      return {
        ok: true,
        summary: `list_files: ${p} (${lines.length})`,
        content: lines.length > 0 ? lines.join('\n') : '(empty directory)',
      };
    }

    return { ok: false, summary: `unknown tool: ${name}`, content: `error: unknown tool ${name}` };
  } catch (e: any) {
    return { ok: false, summary: `${name}: ${e?.message || String(e)}`, content: `error: ${e?.message || String(e)}` };
  }
}

// ---- SSE helpers ---------------------------------------------------------

function sseEvent(event: string, data: unknown): Uint8Array {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${payload}\n\n`);
}

// ---- Build loop ----------------------------------------------------------

const SYSTEM_PROMPT = `You are the Manifex build agent. A developer has written a documentation spec for a web app and you are building it on a fresh Fly.io devbox (ubuntu:24.04, root, /app/workspace is your working directory, git initialised).

Your primitives are bash, write_file, read_file, list_files. You have nothing else. If you need to install a package, deploy, call an API, or do anything exotic, you do it with bash.

Your workflow:
1. Use list_files to see the current state of /app/workspace.
2. Read the spec at .manifex/spec.md with read_file.
3. Follow the spec literally — every page is the source of truth. The Environment page declares the stack. The Look and Feel page declares the visual design. The Data and Storage page declares the schema. Etc.
4. If /app/workspace is empty or nearly empty, scaffold the whole project from scratch using write_file.
5. If /app/workspace already has a partial project, read the relevant files with read_file first and make the SMALLEST set of incremental edits needed to align with the spec. Do not rewrite what's already correct.
6. Write a setup.sh at /app/workspace/setup.sh that a downstream bash runner will execute AFTER you finish. It must be idempotent — safe to re-run on an existing volume that already has node_modules, a pushed schema, etc. Contents must install dependencies (\`npm install --no-audit --no-fund\`), push the drizzle schema (\`npx drizzle-kit push --config=drizzle.config.ts --force\` — only if this project uses drizzle), and return 0 on success. It must NOT start the dev server.
7. Write a run.sh at /app/workspace/run.sh that a downstream bash runner will execute AFTER setup.sh succeeds. It must: (a) kill any prior dev server (\`pkill -f "next dev" 2>/dev/null || true\`), (b) write the dev server's port to /app/workspace/.manifex-port, (c) start the dev server in the background via \`nohup bash -c "..." > .manifex/dev.log 2>&1 < /dev/null & disown\` so it survives when run.sh exits, (d) return 0 immediately. It must NOT block on the server, must NOT verify with curl.
8. Write /app/workspace/.manifex/bootstrap.sh with contents \`bash /app/workspace/run.sh\`. This is the script the devbox agent re-execs on machine start when Fly auto-stop has killed the server — it just re-runs run.sh, which is already idempotent.
9. **Do NOT run setup.sh, run.sh, bash npm install, start the dev server, or touch port 3000 yourself.** You only write files. A pure-bash /build runner on the manifex-wip side takes over once you finish and runs setup.sh + run.sh. If you spawn processes here they'll get killed when the build route kicks its own run.sh.
10. Finish with a one-sentence text response starting with "BUILD_SUMMARY:" describing what changed.

Stack decisions (when not explicitly overridden by the Environment page):
- Default to Next.js 15 App Router + Tailwind v3 + SQLite + Drizzle ORM. It's what Manifex knows best and what the devbox toolchain is tuned for.
- Use npm (not yarn or pnpm). The box has nodejs 20 preinstalled.
- For native module build deps (better-sqlite3, etc): the box already has build-essential, python3, sqlite3. You do not need apt install for those.

You have no approval prompts, no permission barriers, no tool allowlist beyond the four primitives. You MAY use bash to inspect the workspace (ls, grep, cat), check package versions, dry-run npm commands, etc. — but do NOT run mutating commands that change the dev-server state. File writes are the artifact.

Be efficient. Prefer batching file writes. Do not re-read files you just wrote. Do not ls the same directory twice in a row.`;

// Run a small bash on the devbox, return stdout + exit code.
async function devboxBash(devboxUrl: string, cmd: string): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const base = devboxUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/__exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { exit_code: -1, stdout: '', stderr: `HTTP ${res.status}` };
  const data = await res.json().catch(() => ({}));
  return {
    exit_code: typeof data?.exit_code === 'number' ? data.exit_code : -1,
    stdout: typeof data?.stdout === 'string' ? data.stdout : '',
    stderr: typeof data?.stderr === 'string' ? data.stderr : '',
  };
}

async function ensureGitInit(devboxUrl: string): Promise<void> {
  // Safe to run repeatedly — if .git exists, init + config are no-ops.
  await devboxBash(devboxUrl, `
cd /app/workspace || exit 0
if [ ! -d .git ]; then
  git init -q -b main
  git config user.email "manifex@local"
  git config user.name "Manifex"
  git commit --allow-empty -q -m "init" 2>/dev/null || true
fi
`.trim());
}

async function gitCommitAll(devboxUrl: string, summary: string): Promise<string | null> {
  const safeSummary = summary.replace(/["\n]/g, ' ').slice(0, 120);
  const r = await devboxBash(devboxUrl, `
cd /app/workspace || exit 1
git add -A
git commit --allow-empty -q -m "generate: ${safeSummary}" 2>/dev/null || true
git rev-parse HEAD
`.trim());
  const sha = r.stdout.trim();
  return sha.match(/^[0-9a-f]{7,}$/) ? sha : null;
}

async function runAgentLoop(
  devboxUrl: string,
  specMd: string,
  manifestSha: string,
  emit: (event: string, data: unknown) => void,
): Promise<{ iterations: number; final_text: string; duration_ms: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set on manifex-wip');
  const client = new Anthropic({ apiKey });

  // Seed: stash the spec on the devbox so Claude can read it with read_file
  // instead of us sending 42KB of text in every turn's context.
  const base = devboxUrl.replace(/\/+$/, '');
  await fetch(`${base}/__write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '.manifex/spec.md', content: specMd }),
    signal: AbortSignal.timeout(30_000),
  });

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: 'user',
      content: `A Manifex documentation spec has been placed at /app/workspace/.manifex/spec.md. Your goal: bring the code in /app/workspace into alignment with that spec. If the workspace is empty, scaffold the project. If it already has code, make the smallest incremental edits.\n\nWrite setup.sh (idempotent installer), run.sh (starts dev server + writes .manifex-port), and .manifex/bootstrap.sh (just 'bash /app/workspace/run.sh'). Do NOT run setup.sh, do NOT run run.sh, do NOT npm install, do NOT start the dev server yourself — a pure-bash /build runner picks those up after you finish. Finish with a one-sentence BUILD_SUMMARY.\n\nmanifest_sha: ${manifestSha}`,
    },
  ];

  const MAX_ITERATIONS = 60;
  const started = Date.now();
  let iteration = 0;
  let finalText = '';

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    emit('iteration', { n: iteration });

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Capture any assistant text blocks for the log panel.
    const textBlocks = resp.content.filter(b => b.type === 'text') as Array<{ type: 'text'; text: string }>;
    if (textBlocks.length > 0) {
      const joined = textBlocks.map(b => b.text).join('\n');
      if (joined.trim()) {
        emit('assistant_text', { iteration, text: joined });
        finalText = joined;
      }
    }

    if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'stop_sequence') {
      // Claude is done.
      break;
    }

    if (resp.stop_reason !== 'tool_use') {
      emit('error', { message: `unexpected stop_reason: ${resp.stop_reason}`, stage: 'loop' });
      break;
    }

    // Execute every tool_use block, collect tool_results in one user message.
    const toolUses = resp.content.filter(b => b.type === 'tool_use') as Array<{
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
    }>;
    const toolResultsContent: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      emit('tool_use', { id: tu.id, iteration, name: tu.name, input: tu.input });
      const result = await execTool(devboxUrl, tu.name, tu.input);
      emit('tool_result', { id: tu.id, iteration, ok: result.ok, summary: result.summary });
      toolResultsContent.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.content,
        is_error: !result.ok,
      });
    }

    // Append the assistant turn + tool results and loop.
    messages.push({ role: 'assistant', content: resp.content });
    messages.push({ role: 'user', content: toolResultsContent });
  }

  return {
    iterations: iteration,
    final_text: finalText || '(no summary)',
    duration_ms: Date.now() - started,
  };
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  if (session.pending_attempt && !session.pending_attempt.draft) {
    return new Response(JSON.stringify({
      error: 'You have proposed changes waiting. Click "Looks good" to accept them before building.',
      reason: 'pending_not_accepted',
    }), { status: 409, headers: { 'content-type': 'application/json' } });
  }
  const devbox = getDevbox(session);
  if (!devbox) {
    return new Response(JSON.stringify({
      error: 'No devbox attached. Heartbeat should provision one within a few seconds of opening the editor.',
      reason: 'no_devbox',
    }), { status: 409, headers: { 'content-type': 'application/json' } });
  }

  const spec_md = concatenateSpec(session.manifest_state);
  const manifest_sha = session.manifest_state.sha;

  // Phase 2C generate-cache: look up prior commit sha for this manifest_sha.
  // Cache is stored on session.manifest_state.generate_cache as a flat
  // object { [manifest_sha]: { commit_sha, at, duration_ms, iterations } }.
  // Hit → replay the cached commit via `git checkout <sha>` so the
  // workspace is byte-exact to the last successful generate. Round-trip
  // determinism depends on this — revert the doc, get the same commit back,
  // /build replays the same code.
  const cacheMap = (session.manifest_state as any)?.generate_cache || {};
  const cached = cacheMap[manifest_sha];

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: string, data: unknown) => {
        try { controller.enqueue(sseEvent(event, data)); } catch {}
      };
      emit('start', { manifest_sha, devbox_url: devbox.url, spec_bytes: spec_md.length, cache_hit: !!cached });

      try {
        if (cached?.commit_sha) {
          // Cache hit: checkout the stored commit on the devbox, no LLM.
          emit('cache_hit', { commit_sha: cached.commit_sha, at: cached.at });
          await ensureGitInit(devbox.url);
          const r = await devboxBash(devbox.url, `
cd /app/workspace || exit 1
git rev-parse --verify ${cached.commit_sha} >/dev/null 2>&1 || { echo "MISSING"; exit 2; }
git checkout -q ${cached.commit_sha} -- .
git reset -q ${cached.commit_sha}
git clean -qfd
`.trim());
          if (r.exit_code === 0) {
            emit('done', { iterations: 0, final_text: `cache hit ${String(cached.commit_sha).slice(0, 12)}`, duration_ms: 0, commit_sha: cached.commit_sha, cache_hit: true });
            return;
          }
          // Missing / corrupted cache entry — fall through to fresh run.
          emit('assistant_text', { iteration: 0, text: `Cache miss: stored commit ${cached.commit_sha.slice(0,12)} not found on volume (exit ${r.exit_code}). Running fresh agent loop.` });
        }

        await ensureGitInit(devbox.url);
        const result = await runAgentLoop(devbox.url, spec_md, manifest_sha, emit);

        // Commit everything Claude wrote into the devbox git.
        const commit_sha = await gitCommitAll(devbox.url, result.final_text);

        // Persist cache entry if we got a sha back.
        if (commit_sha) {
          const newCacheMap = { ...cacheMap, [manifest_sha]: {
            commit_sha,
            at: new Date().toISOString(),
            duration_ms: result.duration_ms,
            iterations: result.iterations,
          }};
          try {
            const newManifestState = { ...session.manifest_state, generate_cache: newCacheMap } as unknown as typeof session.manifest_state;
            await updateSession(id, { manifest_state: newManifestState });
          } catch (e: any) {
            console.warn(`[generate] cache write failed: ${e?.message || e}`);
          }
        }

        emit('done', { ...result, commit_sha, cache_hit: false });
      } catch (e: any) {
        emit('error', { message: e?.message || String(e), stage: 'agent' });
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
