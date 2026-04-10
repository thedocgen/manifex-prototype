// Stub for Modal compiler service calls.
// Phase 1: returns hardcoded responses.
// Phase 3+: real Modal calls.

import { sha256 } from './crypto';
import type { CompiledCodex } from './types';

const MODAL_URL = process.env.MANIFEX_COMPILER_URL || '';

export async function editManifest(currentManifest: string, prompt: string): Promise<{ new_manifest: string; diff_summary: string }> {
  // Phase 1 stub: append the prompt as a new bullet under "## Pages"
  if (!MODAL_URL) {
    const lines = currentManifest.split('\n');
    const pagesIdx = lines.findIndex(l => l.trim() === '## Pages');
    if (pagesIdx !== -1) {
      lines.splice(pagesIdx + 1, 0, `- ${prompt}`);
    } else {
      lines.push('', '## Pages', `- ${prompt}`);
    }
    return {
      new_manifest: lines.join('\n'),
      diff_summary: `Added: "${prompt}"`,
    };
  }

  // Real call (phase 3+)
  const resp = await fetch(`${MODAL_URL}/edit_manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_manifest: currentManifest, prompt }),
  });
  if (!resp.ok) throw new Error(`edit_manifest failed: ${resp.status}`);
  return resp.json();
}

export async function compileManifestToCodex(manifest: string): Promise<CompiledCodex> {
  // Phase 1 stub: produce a trivial HTML page from manifest text
  if (!MODAL_URL) {
    const files = {
      'index.html': `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Manifex App</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main>
    <h1>Manifex Preview</h1>
    <pre id="manifest"></pre>
  </main>
  <script src="app.js"></script>
</body>
</html>`,
      'styles.css': `body { font-family: system-ui; padding: 2rem; background: #fafafa; color: #111; }
h1 { font-size: 2rem; }
pre { white-space: pre-wrap; background: #fff; padding: 1rem; border-radius: 8px; border: 1px solid #ddd; }`,
      'app.js': `document.getElementById('manifest').textContent = ${JSON.stringify(manifest)};`,
    };
    const codex_sha = sha256(JSON.stringify(files));
    return {
      files,
      codex_sha,
      compiler_version: 'stub-0.1',
    };
  }

  const resp = await fetch(`${MODAL_URL}/compile_manifest_to_codex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  if (!resp.ok) throw new Error(`compile failed: ${resp.status}`);
  return resp.json();
}
