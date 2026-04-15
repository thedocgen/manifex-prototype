// Phase 4/5 LLM backend dispatcher.
//
// Wraps the build-agent loop used by /api/manifex/sessions/[id]/generate
// behind a flag so we can switch between:
//
//   1. @anthropic-ai/sdk + ANTHROPIC_API_KEY  (runWithAnthropicSDK)
//   2. @anthropic-ai/claude-agent-sdk + Max OAuth via ~/.claude/.credentials.json
//      (runWithClaudeAgentSDK)
//
// Both paths run the same 4 devbox tools (bash, write_file, read_file,
// list_files) against the same /__exec + /__write + /__read + /__ls
// endpoints on the inner Fly devbox. Only the LLM transport differs.
//
// Scope note: /api/manifex/sessions/[id]/prompt (the shallow+deep manifest
// edit agent in lib/modal.ts) is NOT routed through this dispatcher yet.
// /generate is the big token burn and the gate Jesse cares about. /prompt
// stays on the @anthropic-ai/sdk + ANTHROPIC_API_KEY path until /generate
// has proven out locally.
//
// Dispatch is controlled by MANIFEX_LLM_BACKEND:
//   "anthropic-sdk"     (default — existing API-key path)
//   "claude-agent-sdk"  (new — Max OAuth via host credentials, local dev)

import Anthropic from '@anthropic-ai/sdk';
import type { ZodRawShape } from 'zod';

// ───────────────────────────────────────────────────────────────────
// Shared system prompt used by BOTH backends (Anthropic SDK + API key
// and Claude Agent SDK + Max OAuth). Paths reference /app/workspace
// and the 4 primitives (bash, write_file, read_file, list_files) that
// proxy to the devbox agent via HTTP. Manidex and cloud Manifex both
// build onto a Fly devbox; the only difference between the two paths
// is LLM auth, not the tool surface or system prompt.
// ───────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are the Manifex build agent. A developer has written a documentation spec for a web app and you are building it on a fresh Fly.io devbox (ubuntu:24.04, root, /app/workspace is your working directory, git initialised).

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

── REQUIRED SHAPE code blocks ──

When a spec page includes a fenced code block whose header contains "REQUIRED SHAPE" (anywhere in the info-string or the line immediately before the fence), you MUST write that file to the indicated path BYTE-FOR-BYTE, without paraphrasing, refactoring, or "improving" it. Format:

  \`\`\`ts path=lib/example.ts REQUIRED SHAPE
  import { something } from 'pkg';
  // ... exact contents ...
  \`\`\`

Rules:
1. Use write_file with the exact path from the info-string and the exact content between the fences. Do not drop comments, do not reorder imports, do not switch node: prefixes, do not swap ESM for CJS, do not collapse try/catch, do not rename identifiers.
2. If a REQUIRED SHAPE block contradicts your instincts (e.g. you think there's a "better" pattern), the REQUIRED SHAPE wins. The spec author has a specific runtime constraint you can't see from inside the build agent (webpack bundling, import resolution, external SSL, etc.).
3. If the info-string lists a path like \`run.sh\`, write the file at that path with that content. If it lists no path, the file name must still come from context — look for "# path: foo/bar.ts" or a nearby spec sentence naming the file.
4. You MAY add files around REQUIRED SHAPE files (e.g. a package.json dep, an import in another file) but you may NOT edit the REQUIRED SHAPE file itself.
5. This is the primary mechanism specs use to pin down non-negotiable implementation details. Treat these blocks as compiler-level contracts, not suggestions.

Recursive rule: every level of Manifex uses the same REQUIRED SHAPE vocabulary on its own spec pages. An inner app spec that ships a REQUIRED SHAPE block gets the exact same verbatim-copy treatment with no privileged outer shortcut.

Be efficient. Prefer batching file writes. Do not re-read files you just wrote. Do not ls the same directory twice in a row.`;

export const ANTHROPIC_SDK_TOOLS: Anthropic.Messages.Tool[] = [
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

// ───────────────────────────────────────────────────────────────────
// Shared devbox tool execution (HTTP calls to the inner Fly devbox
// agent). Both backends reuse this — only the LLM transport differs.
// ───────────────────────────────────────────────────────────────────

export interface ToolExecResult {
  ok: boolean;
  // Short human summary for SSE events.
  summary: string;
  // Full payload sent back to Claude as tool_result content.
  content: string;
}

export async function execTool(
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
        signal: AbortSignal.timeout(detach ? 30_000 : 900_000),
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
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, summary: `${name}: ${err}`, content: `error: ${err}` };
  }
}

// ───────────────────────────────────────────────────────────────────
// Dispatcher
// ───────────────────────────────────────────────────────────────────

export type BuildAgentEmit = (event: string, data: unknown) => void;

export interface BuildAgentResult {
  iterations: number;
  final_text: string;
  duration_ms: number;
  // Only set by the claude-agent-sdk backend, which builds into a
  // local ephemeral temp dir and returns the full file tree as a
  // { filepath: content } map for the caller to persist into
  // manifex_compilations. Anthropic-SDK backend leaves this
  // undefined — that path commits directly to the Fly devbox's git.
  codex_files?: Record<string, string>;
  total_bytes?: number;
  // Incremental compilation metrics — set when the claude-agent-sdk
  // backend was run with previousCodexFiles (a previous compilation
  // was pre-seeded into the cwd). Counts measured against the
  // post-loop codex_files vs the previous codex_files, excluding
  // magic __manidex_* metadata keys. Undefined on cold gens.
  modified_files?: number;  // files in new that differ from previous OR are new
  preserved_files?: number; // files in new that are byte-identical to previous
  total_files?: number;     // total files in new codex_files (excluding magic keys)
  // True when this run was framed as a surgical edit against a
  // pre-seeded cwd (previousCodexFiles provided). False/undefined
  // when it was a cold scaffold.
  incremental?: boolean;
}

// Page-level snapshot used for diff computation in the incremental
// path. Shape matches ManifestState.pages: a map of doc page path to
// { title, content }. Only `content` is compared for diff detection;
// title changes alone don't flag a page as changed.
export interface ManidexPagesSnapshot {
  [path: string]: { title: string; content: string };
}

export interface RunBuildAgentOpts {
  // Required for claude-agent-sdk backend — used as the temp dir key
  // so concurrent builds on different sessions don't clobber each
  // other. Ignored by the anthropic-sdk backend.
  sessionId?: string;
  // Incremental compilation (claude-agent-sdk backend only): the
  // previous compilation's codex_files map. When provided, the
  // Manidex build path pre-seeds the cwd with these files, frames
  // the agent loop as a surgical edit against an existing codebase,
  // and computes added/changed/preserved counts against this
  // baseline. Magic __manidex_* keys are filtered out when seeding.
  previousCodexFiles?: Record<string, string>;
  // Previous manifest_state.pages — the doc pages that PRODUCED
  // previousCodexFiles. Used to compute the doc-level diff so the
  // user message can say "this is what changed in the spec".
  // Required alongside previousCodexFiles for the incremental path
  // to fire; absence falls back to cold scaffold framing.
  previousPages?: ManidexPagesSnapshot;
  // Current manifest_state.pages — the spec the agent is building
  // toward. Compared against previousPages to identify changed doc
  // pages. The agent's user message focuses on these changes
  // instead of restating the full spec.
  currentPages?: ManidexPagesSnapshot;
}

export async function runBuildAgent(
  devboxUrl: string,
  specMd: string,
  manifestSha: string,
  emit: BuildAgentEmit,
  opts: RunBuildAgentOpts = {},
): Promise<BuildAgentResult> {
  const backend = (process.env.MANIFEX_LLM_BACKEND || 'anthropic-sdk').trim();
  if (backend === 'claude-agent-sdk') {
    return runWithClaudeAgentSDK(devboxUrl, specMd, manifestSha, emit, opts);
  }
  return runWithAnthropicSDK(devboxUrl, specMd, manifestSha, emit);
}

// ───────────────────────────────────────────────────────────────────
// Backend 1: @anthropic-ai/sdk + ANTHROPIC_API_KEY
// Existing path — byte-faithful lift of the route's prior runAgentLoop.
// ───────────────────────────────────────────────────────────────────

async function runWithAnthropicSDK(
  devboxUrl: string,
  specMd: string,
  manifestSha: string,
  emit: BuildAgentEmit,
): Promise<BuildAgentResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (required for MANIFEX_LLM_BACKEND=anthropic-sdk)');
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

  // Anthropic ephemeral prompt caching — mark the stable prefix
  // (system prompt + tools) as cacheable so the N-iteration tool_use
  // loop hits the 5-minute cache on turns 2..N and pays ~10% on the
  // cached bytes. SYSTEM_PROMPT is ~8 KB and ANTHROPIC_SDK_TOOLS is
  // ~3 KB — caching both is a clear win across 20-60 turns.
  //
  // Asymmetry with the claude-agent-sdk path: the Agent SDK handles
  // its own prompt caching internally (it spawns the Claude Code CLI
  // subprocess which applies cache_control to the standard Claude
  // Code system prompt + tool prefix automatically). So the
  // cache_control markers below are only for the API-key path used
  // by cloud Manifex. The two backends end up with equivalent
  // multi-turn economics — one via explicit markers, one via the
  // SDK's built-in handling.
  const cachedSystem: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];
  const cachedTools: Anthropic.Messages.Tool[] = ANTHROPIC_SDK_TOOLS.map((t, i) =>
    // Mark the LAST tool with cache_control — that caches every tool
    // definition before it as a single stable prefix.
    i === ANTHROPIC_SDK_TOOLS.length - 1
      ? ({ ...t, cache_control: { type: 'ephemeral' } } as Anthropic.Messages.Tool)
      : t,
  );

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    emit('iteration', { n: iteration });

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 16000,
      system: cachedSystem,
      tools: cachedTools,
      messages,
    });

    const textBlocks = resp.content.filter(b => b.type === 'text') as Array<{ type: 'text'; text: string }>;
    if (textBlocks.length > 0) {
      const joined = textBlocks.map(b => b.text).join('\n');
      if (joined.trim()) {
        emit('assistant_text', { iteration, text: joined });
        finalText = joined;
      }
    }

    if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'stop_sequence') {
      break;
    }

    if (resp.stop_reason !== 'tool_use') {
      emit('error', { message: `unexpected stop_reason: ${resp.stop_reason}`, stage: 'loop' });
      break;
    }

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

    messages.push({ role: 'assistant', content: resp.content });
    messages.push({ role: 'user', content: toolResultsContent });
  }

  return {
    iterations: iteration,
    final_text: finalText || '(no summary)',
    duration_ms: Date.now() - started,
  };
}

// ───────────────────────────────────────────────────────────────────
// Backend 2: @anthropic-ai/claude-agent-sdk + Max OAuth (host creds)
// The SDK spawns the bundled Claude Code CLI as a subprocess, which
// auto-reads ~/.claude/.credentials.json when ANTHROPIC_API_KEY is
// absent. No explicit token plumbing — we just unset the env var in
// the child to force OAuth.
// ───────────────────────────────────────────────────────────────────

// System prompt variant for the claude-agent-sdk backend. Targets the
// ephemeral temp dir and describes the 6 built-in tools the SDK
// exposes. The output of this loop is serialized into
// manifex_compilations, not committed to a Fly devbox — Manidex
// builds into the DB, not onto disk.
const SYSTEM_PROMPT_MANIDEX = `You are the Manidex build agent. A developer has written a documentation spec for a web app and you are building it in an ephemeral working directory on a local dev machine. The directory may be empty (fresh scaffold) or contain a partial project from a prior iteration. Your working directory is the cwd of this session — paths are relative to that cwd unless you use an absolute path.

Your primitives are the Claude Code built-in tools: Bash, Read, Write, Edit, Glob, Grep. Use Bash for anything the other tools don't cover — npm dry-run, git, cat/grep for inspection, etc. Use Write for new files and Edit for incremental changes. Use Read before editing.

Your workflow:
1. Use Bash ls or Glob to see the current state of the working directory.
2. The spec is included in the user message. Read it, follow it literally — every page is the source of truth. The Environment page declares the stack. The Look and Feel page declares the visual design. The Data and Storage page declares the schema. Etc.
3. If the working directory is empty or nearly empty, scaffold the whole project from scratch using Write.
4. If the working directory already has a partial project, Read the relevant files first and make the SMALLEST set of incremental Edit calls needed to align with the spec.
5. Write a setup.sh (idempotent installer: \`npm install --no-audit --no-fund\`) and a run.sh (kills prior \`next dev\`, backgrounds a new one via nohup). These scripts are consumed by the Manidex runner AFTER this loop completes — do NOT run them yourself, do NOT npm install, do NOT start the dev server.
6. Finish with a one-sentence text response starting with "BUILD_SUMMARY:" describing what changed.

Stack defaults (when the Environment page doesn't override):
- Next.js 15 App Router + Tailwind v4 + Supabase Postgres + TypeScript.
- npm only (not yarn or pnpm). Node 20 is preinstalled on the host.

── REQUIRED SHAPE code blocks ──

When a spec page includes a fenced code block whose header contains "REQUIRED SHAPE" (anywhere in the info-string or the line immediately before the fence), you MUST write that file to the indicated path BYTE-FOR-BYTE, without paraphrasing or "improving" it. Format:

  \`\`\`ts path=lib/example.ts REQUIRED SHAPE
  import { something } from 'pkg';
  // ... exact contents ...
  \`\`\`

Rules:
1. Use Write with the exact path from the info-string and the exact content between the fences. Do not drop comments, do not reorder imports, do not switch node: prefixes, do not swap ESM for CJS, do not collapse try/catch, do not rename identifiers.
2. If a REQUIRED SHAPE block contradicts your instincts, the REQUIRED SHAPE wins. The spec author has a specific runtime constraint the build agent can't see.
3. You MAY add files around REQUIRED SHAPE files but MUST NOT edit the REQUIRED SHAPE file itself.
4. Treat these blocks as compiler-level contracts, not suggestions.

Recursive rule: every level of Manifex/Manidex uses the same REQUIRED SHAPE vocabulary on its own spec pages. An inner spec's REQUIRED SHAPE block gets the exact same verbatim treatment.

── REQUIRED ROUTES subsection ──

When a spec page contains a subsection heading that includes "REQUIRED ROUTES" (e.g. "### REQUIRED ROUTES"), every bullet line under it is a file the agent MUST ensure exists in the working directory. Format:

  ### REQUIRED ROUTES

  - app/api/manifex/sessions/[id]/build/route.ts — runs setup.sh + run.sh via devbox /__exec, streams SSE events
  - app/api/manifex/sessions/[id]/devbox/health/route.ts — probes Fly machine state, returns { ready, last_check, machine_id }

Rules:
1. These are INSTRUCTIONS, not documentation of existing files. If a listed path does not exist in the cwd, CREATE it with Write. If it exists, verify it matches the prose description and Edit it if not.
2. Match the route's behavior to the prose description after the em-dash / hyphen. Use the existing project's conventions for similar routes (imports, error handling, SSE streaming patterns, response shapes).
3. REQUIRED ROUTES composes with REQUIRED SHAPE. If the same path has a REQUIRED SHAPE fenced block elsewhere in the spec, REQUIRED SHAPE wins (copy the fence verbatim). If only REQUIRED ROUTES, implement the described behavior using your judgment.
4. The distinction between "Files" subsections and "REQUIRED ROUTES" is prescriptive vs descriptive: "Files" describes what exists; "REQUIRED ROUTES" tells you what must exist. A missing REQUIRED ROUTES path is a bug you must fix.

Be efficient. Batch Write calls. Do not re-read files you just wrote. Do not ls the same directory twice in a row. Do not escape the cwd. The directory is ephemeral — whatever you leave on disk when BUILD_SUMMARY fires is what gets persisted into manifex_compilations.`;

// Incremental system prompt — used when a previous compilation has
// been pre-seeded into the cwd and the agent's job is a surgical
// edit against existing code, not a fresh scaffold. Lead with the
// framing: this is a git commit, not a project init. Claude Code (
// which this SDK wraps) does surgical edits by default when the
// codebase already exists; this prompt just makes sure it keeps
// that instinct on the path where the cwd was pre-seeded.
const SYSTEM_PROMPT_MANIDEX_INCREMENTAL = `You are the Manidex incremental build agent. A developer just made a narrow edit to a Manifex documentation spec, and your job is to apply the corresponding code change to the EXISTING codebase in your working directory.

You are NOT scaffolding from scratch. The cwd already contains a complete, working codebase aligned to the PREVIOUS version of the spec. Your job is the minimal, surgical change that brings the code in line with the user's doc edit — nothing more.

Think git commit, not project init.

Your primitives are the Claude Code built-in tools: Bash, Read, Write, Edit, Glob, Grep. Use Glob/Grep to FIND the right files before editing — search for identifiers, class names, or strings from the changed doc pages. Prefer Edit over Write (narrower diffs are reviewable). Only use Write if a file needs to be replaced wholesale.

Your workflow:
1. The user message tells you which doc pages changed. Read them — they are short and focused.
2. Identify 1-5 source files that correspond to those pages. Use Glob or Grep to find them by content, not by guessing. "Pages and Layout" changes usually live in app/[id]/page.tsx and components/. "Data and Storage" lives in db/schema.sql and lib/store.ts. "Environment" lives in package.json, setup.sh, run.sh, config files. Use your judgment; prefer narrower scopes.
3. Read the files you're about to edit. Understand their current state.
4. Apply the change with Edit (preferred) or Write.
5. Do NOT touch any file unrelated to the changed doc pages. Every file you don't edit is preserved byte-for-byte in the output compilation — that's the point.
6. Do NOT re-run setup.sh or run.sh. Do NOT npm install. Do NOT start dev servers. The runner picks those up after you finish.
7. Finish with a one-line "BUILD_SUMMARY: <sentence>" describing the specific change you made. Be terse.

Narrowness is the point. A single-sentence doc edit should produce a single-file code edit. A three-page spec rewrite should produce a three-file code diff. If you find yourself wanting to "also refactor while I'm here" — DON'T. That's the scaffold instinct; this is a commit. Scope creep here breaks determinism.

── REQUIRED SHAPE code blocks ──

If a changed spec page contains a fenced code block whose header contains "REQUIRED SHAPE" (e.g. \`\`\`ts path=lib/example.ts REQUIRED SHAPE), you MUST write that file to the indicated path BYTE-FOR-BYTE from the fence. REQUIRED SHAPE is a hard contract even in incremental mode. Overwrite the existing file with the exact fence content; do not merge or preserve prior edits.

── REQUIRED ROUTES subsection ──

If a changed spec page contains a subsection heading that includes "REQUIRED ROUTES", every bullet under it is a route file that MUST exist in the working directory. If the listed path doesn't exist yet, CREATE it with Write — the bullet's prose description after the em-dash is your behavioral spec. If the path exists, verify it matches the description and Edit it if not.

CRITICAL: these are INSTRUCTIONS, not documentation. A missing REQUIRED ROUTES path is a bug in the current compilation that the agent must fix, not a note that the file is somewhere else. Don't skip it because "the spec is describing what's there" — the spec is describing what MUST be there. If you don't see the file on disk, create it.

In incremental mode, REQUIRED ROUTES in a CHANGED page applies — create/update routes mentioned on the pages that changed. Routes listed in unchanged pages are assumed already correct on disk; don't re-verify them unless you're already editing that area for another reason.

REQUIRED ROUTES composes with REQUIRED SHAPE: if a route file is ALSO pinned with a REQUIRED SHAPE fenced block, the fence content wins (copy verbatim). If only a REQUIRED ROUTES bullet, implement the described behavior using project conventions.

── Files you MUST NOT touch ──

Unless explicitly mentioned in the changed pages or a REQUIRED SHAPE block in a changed page, preserve these files byte-for-byte: node_modules (doesn't exist in cwd anyway), package-lock.json, .next, .git. The runner handles dependencies out-of-loop.

Be efficient. Your output is the filesystem state when BUILD_SUMMARY fires. Every file you leave alone is preserved in the next compilation row. Every file you write or edit becomes part of the diff. Nothing is implicitly regenerated.`;

// Magic key prefix used to store incremental-compilation metadata
// inside codex_files without introducing a new schema column. Keys
// starting with this prefix are metadata, not source files — the
// route injects them before upsert, strips them on readback, and
// the CLI skips them when writing to disk.
const MANIDEX_META_KEY_PREFIX = '__manidex_';
const MANIDEX_STATE_SNAPSHOT_KEY = '__manidex_state_snapshot__';

// Directories / files to skip when serializing the temp dir into
// manifex_compilations.codex_files. We ship source only — not install
// artifacts, not build output, not editor metadata.
const CODEX_SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.cache',
  '.turbo',
  '.vercel',
  '.manifex',
  'dist',
  'build',
  'out',
]);
const CODEX_SKIP_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.manifex-port',
]);
// Per-file hard cap so a runaway bundle doesn't blow out the JSONB
// row. Files over 1 MB get elided with a placeholder — if the spec
// genuinely needs large binary assets, lift this later.
const CODEX_MAX_FILE_BYTES = 1_000_000;

async function walkAndSerialize(
  rootDir: string,
): Promise<{ files: Record<string, string>; totalBytes: number; elided: string[] }> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const files: Record<string, string> = {};
  const elided: string[] = [];
  let totalBytes = 0;

  async function walk(absDir: string, relDir: string): Promise<void> {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (CODEX_SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(absDir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      if (CODEX_SKIP_FILES.has(entry.name)) continue;
      const absPath = path.join(absDir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const stat = await fs.stat(absPath);
      if (stat.size > CODEX_MAX_FILE_BYTES) {
        elided.push(relPath);
        files[relPath] = `__MANIDEX_ELIDED__ file too large for JSONB row (${stat.size} bytes > ${CODEX_MAX_FILE_BYTES} cap)`;
        continue;
      }
      const content = await fs.readFile(absPath, 'utf-8');
      files[relPath] = content;
      totalBytes += content.length;
    }
  }

  await walk(rootDir, '');
  return { files, totalBytes, elided };
}

// Decide whether the incremental path should fire: we need BOTH
// the previous compilation's codex_files AND the previous
// manifest_state.pages AND the current pages. Missing any of these
// (first build, no snapshot in the old row, etc.) falls back to
// the cold scaffold path.
function shouldRunIncremental(opts: RunBuildAgentOpts): boolean {
  if (!opts.previousCodexFiles) return false;
  if (!opts.previousPages || Object.keys(opts.previousPages).length === 0) return false;
  if (!opts.currentPages || Object.keys(opts.currentPages).length === 0) return false;
  // Need at least one non-meta file in the previous codex.
  const hasRealFiles = Object.keys(opts.previousCodexFiles).some(
    (k) => !k.startsWith(MANIDEX_META_KEY_PREFIX),
  );
  return hasRealFiles;
}

interface ChangedPage {
  path: string;
  title: string;
  before: string;
  after: string;
  kind: 'added' | 'removed' | 'edited';
}

// Compute the set of doc pages that changed between previous and
// current. Only `content` is compared — a title change alone is NOT
// a change for this purpose (titles rarely drive code edits and
// false-positive page diffs break determinism).
function computePageDiff(
  previous: ManidexPagesSnapshot,
  current: ManidexPagesSnapshot,
): ChangedPage[] {
  const changed: ChangedPage[] = [];
  const allPaths = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const path of allPaths) {
    const prev = previous[path];
    const curr = current[path];
    if (!prev && curr) {
      changed.push({ path, title: curr.title, before: '(page did not exist)', after: curr.content, kind: 'added' });
    } else if (prev && !curr) {
      changed.push({ path, title: prev.title, before: prev.content, after: '(page removed)', kind: 'removed' });
    } else if (prev && curr && prev.content !== curr.content) {
      changed.push({ path, title: curr.title, before: prev.content, after: curr.content, kind: 'edited' });
    }
  }
  return changed;
}

async function runWithClaudeAgentSDK(
  devboxUrl: string,
  specMd: string,
  manifestSha: string,
  emit: BuildAgentEmit,
  opts: RunBuildAgentOpts = {},
): Promise<BuildAgentResult> {
  // devboxUrl is unused on the Manidex path — Manidex builds into an
  // ephemeral temp dir on the local machine and persists the file
  // tree into manifex_compilations.codex_files. The Fly devbox layer
  // only exists on the runWithAnthropicSDK / cloud Manifex path.
  void devboxUrl;

  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const fs = await import('node:fs/promises');
  const nodePath = await import('node:path');

  const sessionKey = (opts.sessionId || manifestSha).slice(0, 16) || 'default';
  const cwd = `/tmp/manidex-build-${sessionKey}`;
  // Wipe any prior attempt + recreate. Incremental path will
  // re-populate from previousCodexFiles; cold path leaves it empty.
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.mkdir(cwd, { recursive: true });

  const incremental = shouldRunIncremental(opts);

  // ─── Incremental path: pre-seed the cwd from the previous compilation ───
  if (incremental) {
    const prevFiles = opts.previousCodexFiles!;
    let seededCount = 0;
    for (const [relPath, content] of Object.entries(prevFiles)) {
      // Skip magic metadata keys — they aren't real files.
      if (relPath.startsWith(MANIDEX_META_KEY_PREFIX)) continue;
      if (typeof content !== 'string') continue;
      if (content.startsWith('__MANIDEX_ELIDED__')) continue;
      const absPath = nodePath.join(cwd, relPath);
      await fs.mkdir(nodePath.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content, 'utf-8');
      seededCount++;
    }
    console.log(`[manidex:incremental] pre-seeded ${seededCount} files into ${cwd}`);
    emit('incremental_seed', { seeded_files: seededCount });
  }

  // Force OAuth: strip ANTHROPIC_API_KEY from the env we pass to the
  // child CLI process so it falls through to ~/.claude/.credentials.json.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN') continue;
    if (typeof v === 'string') childEnv[k] = v;
  }
  childEnv.CLAUDE_AGENT_SDK_CLIENT_APP = 'manidex/0.1';

  // ─── Build the user prompt ───
  //
  // Cold path: restate the full spec, tell the agent to scaffold.
  // Incremental path: tell the agent the codebase already exists, hand
  // it a short change-focused diff, ask for surgical edits. The user
  // message should NOT restate the spec — that's what triggers
  // scaffold behavior on the model side.
  let userPrompt: string;
  let systemPromptVariant: string;
  let changedPagesForEmit: ChangedPage[] = [];

  // REQUIRED ROUTES extraction. In incremental mode, parse only the
  // CHANGED pages (routes on unchanged pages are assumed already on
  // disk). In cold mode, parse ALL current pages (everything needs to
  // be scaffolded). The parsed list is surfaced in the user message as
  // an explicit must-create-or-verify checklist so the agent can't
  // read "Files" bullets as descriptive-only.
  const { parseRequiredRoutesFromPages } = await import('./manifest-services');
  let requiredRoutes: Array<{ path: string; description: string }> = [];
  if (incremental && opts.currentPages) {
    // Build a pages-subset containing only the changed page paths so
    // the parser only sees the diff scope.
    const changedPaths = new Set(computePageDiff(opts.previousPages!, opts.currentPages).map((p) => p.path));
    const changedPagesSubset: Record<string, { content: string }> = {};
    for (const p of changedPaths) {
      const page = opts.currentPages[p];
      if (page?.content) changedPagesSubset[p] = { content: page.content };
    }
    requiredRoutes = parseRequiredRoutesFromPages(changedPagesSubset).routes;
  } else if (opts.currentPages) {
    requiredRoutes = parseRequiredRoutesFromPages(
      opts.currentPages as Record<string, { content: string }>,
    ).routes;
  }
  if (requiredRoutes.length > 0) {
    console.log(`[manidex] REQUIRED ROUTES extracted from spec: ${requiredRoutes.length} — ${requiredRoutes.map((r) => r.path).join(', ')}`);
    emit('required_routes', { count: requiredRoutes.length, paths: requiredRoutes.map((r) => r.path) });
  }
  const requiredRoutesBlock = requiredRoutes.length > 0
    ? `\n\n── REQUIRED ROUTES (${requiredRoutes.length}) ──\n\nThe spec declares the following route files MUST exist. For each one, check whether it's already on disk (Glob/Read). If absent, CREATE it with Write. If present, verify it matches the description and Edit it if not. These are INSTRUCTIONS, not documentation of existing files.\n\n${requiredRoutes.map((r) => `- ${r.path} — ${r.description}`).join('\n')}\n`
    : '';

  if (incremental) {
    const diff = computePageDiff(opts.previousPages!, opts.currentPages!);
    changedPagesForEmit = diff;

    if (diff.length === 0) {
      // This shouldn't happen — if pages are identical, the compilation
      // cache at the route level should have caught this already. But
      // if it does happen (e.g. whitespace-only edit bumping sha),
      // just tell the agent nothing changed and exit early with a
      // minimal BUILD_SUMMARY. The agent will no-op and we upsert the
      // same codex_files as before (minus the magic key, which the
      // route re-injects).
      userPrompt = `The Manifex spec's manifest_sha changed from <previous> to ${manifestSha.slice(0, 12)}, but no doc page content differs between the two versions. This is likely a whitespace or metadata bump that doesn't require any code changes.

Do NOT modify any files. Your working directory already contains the correct codebase. Finish immediately with:

BUILD_SUMMARY: no-op, spec page content unchanged.`;
      systemPromptVariant = SYSTEM_PROMPT_MANIDEX_INCREMENTAL;
    } else {
      // Build a change-focused diff block. For each changed page, if
      // both full BEFORE and AFTER fit in the soft budget, send them
      // in full. Otherwise, extract the divergent hunk (first line
      // that differs through last line that differs, plus ±CONTEXT
      // lines on each side) and send that. This is the fix for the
      // "4KB head truncation" bug surfaced by governor: appending to
      // the end of a long page produced identical head-slice windows
      // in BEFORE and AFTER, and the agent correctly refused to
      // hallucinate a change it couldn't see.
      const PER_PAGE_FULL_BUDGET = 12_000;  // if both sides total < this, send full
      const CONTEXT_LINES = 6;
      const HUNK_HARD_CAP = 32_000;         // per-side cap on hunk output, very generous

      const buildPageDiffBlock = (page: ChangedPage): string => {
        const { before, after, kind } = page;
        // Added/removed pages: show the full surviving side. For
        // added, BEFORE is a placeholder anyway; for removed, AFTER is.
        if (kind === 'added' || kind === 'removed') {
          return `BEFORE:\n${before.slice(0, HUNK_HARD_CAP)}${before.length > HUNK_HARD_CAP ? '\n[… truncated]' : ''}\n\nAFTER:\n${after.slice(0, HUNK_HARD_CAP)}${after.length > HUNK_HARD_CAP ? '\n[… truncated]' : ''}`;
        }
        // Short enough: send both in full.
        if (before.length + after.length <= PER_PAGE_FULL_BUDGET) {
          return `BEFORE:\n${before}\n\nAFTER:\n${after}`;
        }
        // Hunk extraction: find first line that differs by walking
        // forward, last line that differs by walking backward from
        // both ends. This handles appends (first_diff == bLines.len),
        // prepends (last_diff == first_diff -ish), mid-page edits,
        // and large-region rewrites. CONTEXT lines on each side give
        // the agent enough surroundings to locate the change in the
        // full spec without restating the whole page.
        const bLines = before.split('\n');
        const aLines = after.split('\n');
        let firstDiff = 0;
        while (
          firstDiff < bLines.length &&
          firstDiff < aLines.length &&
          bLines[firstDiff] === aLines[firstDiff]
        ) {
          firstDiff++;
        }
        let bEnd = bLines.length - 1;
        let aEnd = aLines.length - 1;
        while (
          bEnd >= firstDiff &&
          aEnd >= firstDiff &&
          bLines[bEnd] === aLines[aEnd]
        ) {
          bEnd--;
          aEnd--;
        }
        // bEnd/aEnd now point at the LAST divergent line on each side
        // (or firstDiff - 1 if the other side ran out).
        const bWindowStart = Math.max(0, firstDiff - CONTEXT_LINES);
        const bWindowEnd = Math.min(bLines.length, bEnd + 1 + CONTEXT_LINES);
        const aWindowStart = Math.max(0, firstDiff - CONTEXT_LINES);
        const aWindowEnd = Math.min(aLines.length, aEnd + 1 + CONTEXT_LINES);

        const bHunkLines = bLines.slice(bWindowStart, bWindowEnd);
        const aHunkLines = aLines.slice(aWindowStart, aWindowEnd);
        let bHunk = bHunkLines.join('\n');
        let aHunk = aHunkLines.join('\n');
        // Per-side hard cap. Very generous (32KB); only fires on
        // pathological whole-page rewrites. Truncates from the END
        // of the hunk because the divergence is at the start of the
        // hunk by construction.
        if (bHunk.length > HUNK_HARD_CAP) {
          bHunk = bHunk.slice(0, HUNK_HARD_CAP) + '\n[… hunk truncated]';
        }
        if (aHunk.length > HUNK_HARD_CAP) {
          aHunk = aHunk.slice(0, HUNK_HARD_CAP) + '\n[… hunk truncated]';
        }

        const bPrefix = bWindowStart > 0 ? `[… ${bWindowStart} unchanged lines above]\n` : '';
        const bSuffix = bWindowEnd < bLines.length ? `\n[… ${bLines.length - bWindowEnd} unchanged lines below]` : '';
        const aPrefix = aWindowStart > 0 ? `[… ${aWindowStart} unchanged lines above]\n` : '';
        const aSuffix = aWindowEnd < aLines.length ? `\n[… ${aLines.length - aWindowEnd} unchanged lines below]` : '';

        return `BEFORE (divergent region, ±${CONTEXT_LINES} lines context, lines ${bWindowStart + 1}-${bWindowEnd} of ${bLines.length}):
${bPrefix}${bHunk}${bSuffix}

AFTER (divergent region, ±${CONTEXT_LINES} lines context, lines ${aWindowStart + 1}-${aWindowEnd} of ${aLines.length}):
${aPrefix}${aHunk}${aSuffix}`;
      };

      const diffBlocks = diff.map((p) => `## ${p.path} — ${p.title} (${p.kind})

${buildPageDiffBlock(p)}`).join('\n\n---\n\n');

      userPrompt = `The Manifex codebase in your working directory is already scaffolded. The user just made a narrow edit to the spec. Apply the corresponding code change as a surgical edit — minimal, scoped, reviewable. Think git commit.

Changed spec pages (${diff.length}):

${diffBlocks}
${requiredRoutesBlock}
Your job:
1. Identify which source files correspond to the changed page${diff.length === 1 ? '' : 's'}. Use Glob/Grep to find them by content; don't guess.
2. Read the files. Understand their current state.
3. Apply the minimal edit that brings the code in line with the new doc content. Prefer Edit over Write.
4. For any REQUIRED ROUTES path above: Glob/Read to check if it exists. If absent, CREATE it with Write using the bullet's prose description as the spec. If present, verify it matches and Edit if not. Missing REQUIRED ROUTES are bugs to fix, not notes to ignore.
5. Leave every unrelated file byte-for-byte identical. Do not "also refactor while you're here".
6. Finish with "BUILD_SUMMARY: <one sentence>".

manifest_sha: ${manifestSha.slice(0, 12)}`;
      systemPromptVariant = SYSTEM_PROMPT_MANIDEX_INCREMENTAL;
    }
  } else {
    // Cold path — full spec, scaffold framing.
    userPrompt = `A Manifex documentation spec is below. Your working directory is ${cwd}. Your goal: bring the code in that directory into alignment with the spec. The directory is empty — scaffold the project from scratch.

Write setup.sh (idempotent installer) and run.sh (starts the dev server in the background and returns immediately). Do NOT run setup.sh, do NOT run run.sh, do NOT npm install, do NOT start the dev server yourself. A downstream Manidex runner picks those up after you finish. Finish with a one-sentence BUILD_SUMMARY.
${requiredRoutesBlock}
manifest_sha: ${manifestSha}

=== SPEC BEGIN ===
${specMd}
=== SPEC END ===`;
    systemPromptVariant = SYSTEM_PROMPT_MANIDEX;
  }

  const started = Date.now();
  let iteration = 0;
  let finalText = '';

  const q = query({
    prompt: userPrompt,
    options: {
      systemPrompt: systemPromptVariant,
      cwd,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      env: childEnv,
    },
  });

  try {
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        iteration++;
        emit('iteration', { n: iteration });
        const content = (msg as { message?: { content?: unknown[] } }).message?.content || [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            emit('assistant_text', { iteration, text: block.text });
            finalText = block.text;
          } else if (block.type === 'tool_use') {
            const rawName = typeof block.name === 'string' ? block.name : 'unknown';
            emit('tool_use', {
              id: String(block.id || ''),
              iteration,
              name: rawName,
              input: block.input,
            });
          }
        }
      } else if (msg.type === 'user') {
        // user messages carry tool_result blocks from the built-in tools.
        const content = (msg as { message?: { content?: unknown[] } }).message?.content || [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result') {
            const isErr = Boolean(block.is_error);
            // Extract first text block's content for the summary.
            let summary = '';
            const inner = block.content;
            if (Array.isArray(inner)) {
              for (const part of inner as Array<Record<string, unknown>>) {
                if (part.type === 'text' && typeof part.text === 'string') {
                  summary = part.text.split('\n')[0].slice(0, 160);
                  break;
                }
              }
            } else if (typeof inner === 'string') {
              summary = inner.split('\n')[0].slice(0, 160);
            }
            emit('tool_result', {
              id: String(block.tool_use_id || ''),
              iteration,
              ok: !isErr,
              summary,
            });
          }
        }
      } else if (msg.type === 'result') {
        // Final message — SDK reports usage + cost + subtype.
        const r = msg as { subtype?: string; num_turns?: number; total_cost_usd?: number; usage?: unknown };
        if (r.subtype && r.subtype !== 'success') {
          emit('error', { message: `claude-agent-sdk result subtype=${r.subtype}`, stage: 'loop' });
        }
        // Prefer the SDK's reported turn count when available.
        if (typeof r.num_turns === 'number' && r.num_turns > iteration) {
          iteration = r.num_turns;
        }
      } else if (msg.type === 'system') {
        // init / api_retry / etc. — emit for observability but don't
        // gate the loop on them.
        const subtype = (msg as { subtype?: string }).subtype;
        if (subtype === 'init') {
          const init = msg as { apiProvider?: string; apiKeySource?: string; tokenSource?: string; model?: string };
          emit('backend_init', {
            provider: init.apiProvider,
            apiKeySource: init.apiKeySource,
            tokenSource: init.tokenSource,
            model: init.model,
          });
        }
      }
    }
  } finally {
    try { q.close(); } catch {}
  }

  // Walk the temp dir, serialize the file tree into a plain object,
  // then wipe the dir. The /generate route upserts the codex_files
  // map into manifex_compilations keyed on (manifest_sha, compiler_version).
  const { files: codexFiles, totalBytes, elided } = await walkAndSerialize(cwd);
  if (elided.length > 0) {
    console.warn(`[manidex] ${elided.length} oversized files elided from codex_files: ${elided.slice(0, 5).join(', ')}${elided.length > 5 ? '…' : ''}`);
  }
  try { await fs.rm(cwd, { recursive: true, force: true }); } catch {}

  // Compute diff metrics against the previous compilation — only
  // meaningful when the incremental path fired. Filter both sides
  // to non-meta keys so the comparison is file-to-file.
  let modifiedFiles: number | undefined;
  let preservedFiles: number | undefined;
  const totalFiles = Object.keys(codexFiles).filter(
    (k) => !k.startsWith(MANIDEX_META_KEY_PREFIX),
  ).length;

  if (incremental && opts.previousCodexFiles) {
    const prev = opts.previousCodexFiles;
    let modified = 0;
    let preserved = 0;
    for (const [relPath, content] of Object.entries(codexFiles)) {
      if (relPath.startsWith(MANIDEX_META_KEY_PREFIX)) continue;
      const prevContent = prev[relPath];
      if (typeof prevContent !== 'string' || prevContent !== content) {
        modified++;
      } else {
        preserved++;
      }
    }
    modifiedFiles = modified;
    preservedFiles = preserved;
    const prevCount = Object.keys(prev).filter((k) => !k.startsWith(MANIDEX_META_KEY_PREFIX)).length;
    const removed = Object.keys(prev).filter(
      (k) => !k.startsWith(MANIDEX_META_KEY_PREFIX) && !(k in codexFiles),
    ).length;
    console.log(`[manidex:incremental] diff vs previous: modified=${modified} preserved=${preserved} removed=${removed} total_prev=${prevCount} total_new=${totalFiles} changed_pages=${changedPagesForEmit.length}`);
  }

  return {
    iterations: iteration,
    final_text: finalText || '(no summary)',
    duration_ms: Date.now() - started,
    codex_files: codexFiles,
    total_bytes: totalBytes,
    modified_files: modifiedFiles,
    preserved_files: preservedFiles,
    total_files: totalFiles,
    incremental,
  };
}

// ───────────────────────────────────────────────────────────────────
// runDocGenerationLoop — Manidex /prompt backend.
//
// Replaces lib/modal.ts's shallow+deep tool_choice path when
// MANIFEX_LLM_BACKEND=claude-agent-sdk. Uses the Agent SDK's built-in
// Read/Write/Edit tools to let Claude rewrite the 7 spec pages as
// plain markdown files in a throwaway temp dir, then reads them back
// and builds a DocGenResult in the shape the /prompt route expects.
//
// Why this instead of porting tool_choice calls (option 1 / 2 / 3):
// - Claude Agent SDK's query() is designed for agent loops, not
//   single-call tool-forced output. Forcing structured output through
//   the MCP custom-tool path is ~100 lines per call site × 4 call
//   sites and high risk.
// - Agent loop + free-form file writes + post-hoc validation is what
//   /generate already does successfully. One code shape for both
//   /prompt and /generate on the Manidex side.
// - Jesse explicitly accepted the tradeoffs: slower (30-90s single
//   pass instead of 15-30s shallow + 60-180s deep), ~5% format risk,
//   no shallow/deep UX split. Acceptable for local single-user dev.
// ───────────────────────────────────────────────────────────────────

export interface DocGenPage {
  title: string;
  content: string;
}

export interface DocGenTreeNode {
  path: string;
  title: string;
  children?: DocGenTreeNode[];
}

export interface DocGenCurrentState {
  pages: Record<string, DocGenPage>;
  tree: DocGenTreeNode[];
}

export interface DocGenResult {
  pages: Record<string, DocGenPage>;
  tree: DocGenTreeNode[];
  diff_summary: string;
  changed_pages: string[];
  iterations: number;
  duration_ms: number;
}

// Canonical 7-page spec shape the editor expects. Used when the
// current manifest_state.tree is empty or missing pages.
const DEFAULT_SPEC_TREE: DocGenTreeNode[] = [
  { path: 'overview', title: 'Overview' },
  { path: 'environment', title: 'Environment' },
  { path: 'how-it-works', title: 'How It Works' },
  { path: 'pages-and-layout', title: 'Pages and Layout' },
  { path: 'look-and-feel', title: 'Look and Feel' },
  { path: 'data-and-storage', title: 'Data and Storage' },
  { path: 'tests', title: 'Tests' },
];

const DOC_GEN_SYSTEM_PROMPT = `You are the Manidex spec editor. A user has asked you to revise a 7-page spec for a web app. Each page is a single markdown file in your working directory, named <path>.md (overview.md, environment.md, how-it-works.md, pages-and-layout.md, look-and-feel.md, data-and-storage.md, tests.md).

Your working directory already contains the CURRENT versions of these files as the user's starting point. Your job is to apply the user's requested edit and leave the directory with the NEW versions.

Workflow:
1. Use Read to open the current page files you need to inspect. You do not need to read every page — only the ones relevant to the user's edit.
2. Use Write or Edit to change the files. Narrow edits are preferred: if the user only asked to change the Overview, don't rewrite the other six pages. Leave unchanged pages exactly as you found them on disk.
3. Do NOT create any files other than these 7: overview.md, environment.md, how-it-works.md, pages-and-layout.md, look-and-feel.md, data-and-storage.md, tests.md.
4. Do NOT run Bash for anything other than ls, cat, wc, head, tail, grep (inspection only). No writes via bash, no network calls, no mutation outside the cwd.
5. Each page file's content should be the full markdown for that page, starting with a single H1 heading that matches the page title (e.g. "# Overview"). Use standard markdown — headings, lists, code blocks, tables. ASCII art is allowed in fenced code blocks for architecture diagrams.
6. When you are done, write a one-line file named .diff_summary containing a short human summary of what changed (e.g. "Changed dark mode styling in Look and Feel."). No more than 160 chars.

Rules:
- You MUST leave all 7 page files present in the working directory when you finish. If a page is not mentioned by the user's request, read it and leave it on disk unchanged.
- You MUST NOT rewrite a page that the user did not ask about. Narrow edits keep the diff reviewable.
- You MUST honor any REQUIRED SHAPE fenced code blocks already present in the current pages. Do not modify REQUIRED SHAPE blocks unless the user explicitly asks you to.
- Finish with a one-sentence text response starting with "DOC_SUMMARY:" describing what changed.

Style:
- Writing tone is concrete, product-owner voice. Declarative sentences. Each page starts with an H1 matching the spec tree title.
- Lists beat walls of prose when describing pages, steps, or tests.
- Keep each page under ~15KB unless the page is explicitly architecture-heavy.

You are NOT running the agent or building any code — you are only editing markdown. No setup.sh, no run.sh, no package.json in this directory. Those are /generate's concern, not /prompt's.`;

export async function runDocGenerationLoop(
  sessionId: string,
  currentState: DocGenCurrentState,
  userPrompt: string,
  emit: BuildAgentEmit,
): Promise<DocGenResult> {
  const backend = (process.env.MANIFEX_LLM_BACKEND || 'anthropic-sdk').trim();
  if (backend !== 'claude-agent-sdk') {
    throw new Error(`runDocGenerationLoop only supports MANIFEX_LLM_BACKEND=claude-agent-sdk, got "${backend}"`);
  }

  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  // Normalize tree: use current tree if populated, else the default 7.
  const tree: DocGenTreeNode[] = (currentState.tree && currentState.tree.length > 0)
    ? currentState.tree
    : DEFAULT_SPEC_TREE;

  // Build a lookup of expected page paths and their titles. These are
  // the files the agent MUST leave on disk when it finishes.
  const expectedPaths: Array<{ path: string; title: string }> = tree.map((node) => ({
    path: node.path,
    title: node.title,
  }));
  const expectedPathSet = new Set(expectedPaths.map((p) => p.path));

  const cwd = `/tmp/manidex-prompt-${sessionId}`;
  // Wipe any leftover state from a prior failed run.
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.mkdir(cwd, { recursive: true });

  // Seed the current page contents. Claude reads these, edits in place,
  // and the post-loop readback diffs against them.
  const seeded: Record<string, string> = {};
  for (const { path: p, title } of expectedPaths) {
    const existing = currentState.pages[p];
    const content = existing?.content ?? `# ${title}\n\n(empty — this page has not been written yet)\n`;
    const filePath = path.join(cwd, `${p}.md`);
    await fs.writeFile(filePath, content, 'utf-8');
    seeded[p] = content;
  }

  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN') continue;
    if (typeof v === 'string') childEnv[k] = v;
  }
  childEnv.CLAUDE_AGENT_SDK_CLIENT_APP = 'manidex-prompt/0.1';

  const expectedList = expectedPaths.map((p) => `- ${p.path}.md (title: ${p.title})`).join('\n');
  const userMessage = `Your working directory contains 7 markdown files — one per spec page — in their CURRENT state. Your task: apply the following user edit and leave the 7 files in their NEW state. Narrow edits only — leave pages the user didn't mention unchanged.

Expected files in the working directory:
${expectedList}

USER EDIT REQUEST:
${userPrompt}

When you're done, write a file called .diff_summary (one line, <=160 chars) summarizing what changed, then emit a single-sentence text response starting with "DOC_SUMMARY:".`;

  const started = Date.now();
  let iteration = 0;
  let finalText = '';

  const q = query({
    prompt: userMessage,
    options: {
      systemPrompt: DOC_GEN_SYSTEM_PROMPT,
      cwd,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      env: childEnv,
    },
  });

  try {
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        iteration++;
        emit('iteration', { n: iteration });
        const content = (msg as { message?: { content?: unknown[] } }).message?.content || [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            emit('assistant_text', { iteration, text: block.text });
            finalText = block.text;
          } else if (block.type === 'tool_use') {
            emit('tool_use', {
              id: String(block.id || ''),
              iteration,
              name: typeof block.name === 'string' ? block.name : 'unknown',
              input: block.input,
            });
          }
        }
      } else if (msg.type === 'user') {
        const content = (msg as { message?: { content?: unknown[] } }).message?.content || [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result') {
            const isErr = Boolean(block.is_error);
            let summary = '';
            const inner = block.content;
            if (Array.isArray(inner)) {
              for (const part of inner as Array<Record<string, unknown>>) {
                if (part.type === 'text' && typeof part.text === 'string') {
                  summary = part.text.split('\n')[0].slice(0, 160);
                  break;
                }
              }
            } else if (typeof inner === 'string') {
              summary = inner.split('\n')[0].slice(0, 160);
            }
            emit('tool_result', {
              id: String(block.tool_use_id || ''),
              iteration,
              ok: !isErr,
              summary,
            });
          }
        }
      } else if (msg.type === 'result') {
        const r = msg as { subtype?: string; num_turns?: number };
        if (r.subtype && r.subtype !== 'success') {
          emit('error', { message: `claude-agent-sdk result subtype=${r.subtype}`, stage: 'loop' });
        }
        if (typeof r.num_turns === 'number' && r.num_turns > iteration) {
          iteration = r.num_turns;
        }
      } else if (msg.type === 'system') {
        const subtype = (msg as { subtype?: string }).subtype;
        if (subtype === 'init') {
          const init = msg as { apiProvider?: string; apiKeySource?: string; tokenSource?: string; model?: string };
          emit('backend_init', {
            provider: init.apiProvider,
            apiKeySource: init.apiKeySource,
            tokenSource: init.tokenSource,
            model: init.model,
          });
        }
      }
    }
  } finally {
    try { q.close(); } catch {}
  }

  // Read back all 7 expected files. Missing files fall back to the
  // seeded content (the agent elected not to touch them — fine).
  const newPages: Record<string, DocGenPage> = {};
  const changedPages: string[] = [];
  const missingPages: string[] = [];
  for (const { path: p, title } of expectedPaths) {
    const filePath = path.join(cwd, `${p}.md`);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      // Agent deleted or never wrote this file. Fall back to seed.
      missingPages.push(p);
      content = seeded[p] || `# ${title}\n`;
    }
    newPages[p] = { title, content };
    if (content !== seeded[p]) {
      changedPages.push(p);
    }
  }

  // Pull the diff summary the agent was asked to write. Missing is OK
  // — fall back to finalText or a generic sentence.
  let diffSummary = '';
  try {
    diffSummary = (await fs.readFile(path.join(cwd, '.diff_summary'), 'utf-8')).trim();
  } catch {}
  if (!diffSummary) {
    const m = finalText.match(/DOC_SUMMARY:\s*(.+)/i);
    diffSummary = m ? m[1].trim().slice(0, 200) : (changedPages.length > 0
      ? `Updated ${changedPages.length} page${changedPages.length === 1 ? '' : 's'}.`
      : 'No changes.');
  }

  if (missingPages.length > 0) {
    console.warn(`[runDocGenerationLoop] agent left ${missingPages.length} expected files missing, fell back to seed: ${missingPages.join(', ')}`);
  }

  // Cleanup temp dir unless explicitly kept for debugging.
  if (!process.env.MANIDEX_KEEP_PROMPT_TMP) {
    try { await fs.rm(cwd, { recursive: true, force: true }); } catch {}
  }

  return {
    pages: newPages,
    tree,
    diff_summary: diffSummary,
    changed_pages: changedPages,
    iterations: iteration,
    duration_ms: Date.now() - started,
  };
}

// Expose the backend flag to callers so the /prompt route can decide
// whether to dispatch to the doc-generation loop or stay on the
// existing editManifest tool_choice path. Keeps the env-var check in
// one place.
export function isClaudeAgentSdkBackend(): boolean {
  return (process.env.MANIFEX_LLM_BACKEND || 'anthropic-sdk').trim() === 'claude-agent-sdk';
}
