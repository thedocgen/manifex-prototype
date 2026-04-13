import { NextResponse } from 'next/server';
import { getSession, getCachedCompilation, putCachedCompilation, getSecrets } from '@/lib/store';
import { compileManifestToCodex, COMPILER_VERSION } from '@/lib/modal';
import { inlineCodex } from '@/lib/codex';
import { syncDevbox, type DevboxState } from '@/lib/devbox';
import type { ManifestState, CompiledCodex, ManifexSession } from '@/lib/types';

// Best-effort fire-and-forget devbox sync. Called after every successful
// render path. Never blocks the render response — devbox sync failures are
// logged and ignored, the user still gets their compiled output back via
// the normal JSON path. The iframe in the editor reloads via SSE when the
// /__sync POST lands on the devbox.
function pushToDevboxIfPresent(session: ManifexSession, html: string): void {
  const devbox: DevboxState | null | undefined = (session.manifest_state as any)?.devbox;
  if (!devbox?.url) return;
  syncDevbox(devbox.url, html).then(r => {
    if (r.ok) console.log(`[render] devbox sync ok ${devbox.url} (${r.bytes} bytes)`);
    else console.warn(`[render] devbox sync failed ${devbox.url}: ${r.error}`);
  }).catch(() => {});
}

const STYLES_PAGE_PATHS = ['styles', 'look-and-feel', 'look_and_feel'];

/**
 * Parse a Look-and-Feel / Styles page for color definitions and return
 * a CSS custom-properties block.  Matches lines like:
 *   - Primary: #1e293b
 *   - Background: #ffffff / #f8fafc
 */
function extractCssVariables(stylesContent: string): string {
  const lines = stylesContent.split('\n');
  const vars: string[] = [];
  for (const line of lines) {
    // Match a name followed by ": #hex". Tolerates leading "- ", "* ", numbered
    // bullets, bold/italic markers, inline code ticks. Examples that match:
    //   - Primary: #1e293b
    //   * **Background:** #ffffff
    //   1. `accent`: #f97316
    //   Primary color: #1e293b / #0f172a
    const m = line.match(/^[\s\-*+\d.)\]]*[`*_]*([A-Za-z][A-Za-z0-9 \-_]*?)[`*_]*\s*:\s*(#[0-9a-fA-F]{3,8})/);
    if (m) {
      const name = m[1]
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');
      if (!name) continue;
      vars.push(`  --manifex-${name}: ${m[2]};`);

      // Check for a secondary value after " / "
      const secondary = line.match(/\/\s*(#[0-9a-fA-F]{3,8})/);
      if (secondary) {
        vars.push(`  --manifex-${name}-alt: ${secondary[1]};`);
      }
    }
  }
  if (vars.length === 0) return '';
  return `:root {\n${vars.join('\n')}\n}`;
}

/**
 * Determine whether the only pages that changed between two manifest states
 * are style/look-and-feel pages.  Returns the combined styles content if true,
 * or null if a full recompile is needed.
 */
function detectStyleOnlyChange(
  current: ManifestState,
  cachedManifest: ManifestState
): string | null {
  const allPaths = new Set([
    ...Object.keys(current.pages),
    ...Object.keys(cachedManifest.pages),
  ]);

  let stylesContent: string | null = null;
  for (const path of allPaths) {
    const curPage = current.pages[path];
    const cachedPage = cachedManifest.pages[path];

    // Page unchanged — skip
    if (
      curPage && cachedPage &&
      curPage.content === cachedPage.content &&
      curPage.title === cachedPage.title
    ) {
      continue;
    }

    // Something changed — is it a styles page?
    if (STYLES_PAGE_PATHS.includes(path)) {
      stylesContent = curPage?.content ?? '';
    } else {
      // A non-style page changed — full recompile needed
      return null;
    }
  }

  return stylesContent;
}

/**
 * Inject a <style> block of CSS custom properties into compiled HTML,
 * placing it right before </head>.
 */
function injectCssVariables(html: string, cssBlock: string): string {
  if (!cssBlock) return html;
  const tag = `<style data-manifex-vars>\n${cssBlock}\n</style>`;
  if (html.includes('</head>')) {
    return html.replace('</head>', `${tag}\n</head>`);
  }
  // Fallback: prepend
  return tag + '\n' + html;
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Defensive guard: refuse to compile while a non-draft pending proposal
  // is open. Otherwise the compile runs against the OLD manifest_state and
  // the user's just-generated content gets bypassed silently — they see
  // the starter "New Project" placeholder in the iframe instead of their
  // app. The UI also gates the Build button, but this catches every
  // direct-API path (curl, retry hooks, future automation, etc.) too.
  if (session.pending_attempt && !session.pending_attempt.draft) {
    return NextResponse.json({
      error: 'You have proposed changes waiting. Click "Looks good" to accept them before building.',
      reason: 'pending_not_accepted',
    }, { status: 409 });
  }

  const manifestSha = session.manifest_state.sha;

  // Check exact cache first
  let compiled = await getCachedCompilation(manifestSha, COMPILER_VERSION);
  if (compiled) {
    console.log(`[render] cache HIT for sha ${manifestSha.slice(0, 12)}`);
    const inlined = inlineCodex(compiled.files);
    pushToDevboxIfPresent(session, inlined);
    return NextResponse.json({
      codex: compiled,
      inlined_html: inlined,
      manifest_sha: manifestSha,
    });
  }

  // --- Incremental CSS-only path ---
  // Look for any recent compilation to use as a base for style-only diffs.
  // We scan compilations for each page-set that differs only in styles pages.
  // Practically: check the session history for the most recent sha that has a
  // cached compilation, then see if the diff is style-only.
  let cssOnlyResult: { compiled: CompiledCodex; inlinedHtml: string } | null = null;

  if (session.history.length > 0) {
    // Walk history newest-first to find a cached base
    for (let i = session.history.length - 1; i >= 0; i--) {
      const prevState = session.history[i];
      const prevCompiled = await getCachedCompilation(prevState.sha, COMPILER_VERSION);
      if (!prevCompiled) continue;

      const stylesContent = detectStyleOnlyChange(session.manifest_state, prevState);
      if (stylesContent !== null) {
        const cssBlock = extractCssVariables(stylesContent);
        if (!cssBlock) {
          console.log(`[render] style-only change but no extractable color vars — full recompile`);
          break;
        }
        console.log(`[render] style-only change detected, skipping LLM recompile`);
        const baseInlined = inlineCodex(prevCompiled.files);
        const patchedHtml = injectCssVariables(baseInlined, cssBlock);

        // Build a new CompiledCodex with the patched CSS injected into index.html
        const patchedFiles = { ...prevCompiled.files };
        patchedFiles['index.html'] = injectCssVariables(
          prevCompiled.files['index.html'],
          cssBlock
        );

        const patchedCodex: CompiledCodex = {
          files: patchedFiles,
          codex_sha: manifestSha,
          compiler_version: COMPILER_VERSION,
        };

        // Cache this so future hits are instant
        await putCachedCompilation(manifestSha, COMPILER_VERSION, patchedCodex);

        cssOnlyResult = { compiled: patchedCodex, inlinedHtml: patchedHtml };
      }
      break; // Only check the most recent cached ancestor
    }
  }

  if (cssOnlyResult) {
    pushToDevboxIfPresent(session, cssOnlyResult.inlinedHtml);
    return NextResponse.json({
      codex: cssOnlyResult.compiled,
      inlined_html: cssOnlyResult.inlinedHtml,
      manifest_sha: manifestSha,
    });
  }

  // --- Full compilation path ---
  console.log(`[render] cache MISS for sha ${manifestSha.slice(0, 12)}, compiling…`);
  // Fetch project secrets for injection
  const secrets = await getSecrets(session.project_id);
  try {
    compiled = await compileManifestToCodex(session.manifest_state, Object.keys(secrets).length > 0 ? secrets : undefined);
  } catch (e: any) {
    const msg: string = e?.message || 'unknown';
    const status: number = e?.status || 500;
    let userMessage = 'Could not build your app right now.';
    let kind = 'unknown';
    if (status === 429 || /rate.?limit/i.test(msg)) { kind = 'rate_limit'; userMessage = 'The compiler is rate-limited. Try building again in a moment.'; }
    else if (status === 401 || /api.?key/i.test(msg)) { kind = 'auth'; userMessage = 'The Anthropic API key is missing or invalid.'; }
    else if (/overload|529/i.test(msg)) { kind = 'overload'; userMessage = 'The compiler is overloaded. Try again in a few seconds.'; }
    else if (/timeout|ECONNRESET|fetch/i.test(msg)) { kind = 'network'; userMessage = 'Lost connection to the compiler. Check your internet and try again.'; }
    console.error('[render] compile failed:', kind, msg);
    return NextResponse.json({ error: userMessage, kind, detail: msg }, { status });
  }
  await putCachedCompilation(manifestSha, COMPILER_VERSION, compiled);

  const inlined = inlineCodex(compiled.files);
  pushToDevboxIfPresent(session, inlined);

  return NextResponse.json({
    codex: compiled,
    inlined_html: inlined,
    manifest_sha: manifestSha,
  });
}
