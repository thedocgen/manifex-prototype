// LLM compiler service for Manifex.
// Originally planned as Modal app — for prototype, calls Anthropic directly
// from Next.js API routes. Same interface, can swap to Modal later.

import Anthropic from '@anthropic-ai/sdk';
import { sha256 } from './crypto';
import type { CompiledCodex } from './types';

const COMPILER_VERSION = 'manifex-claude-sonnet-4-v1';
const MODEL = 'claude-sonnet-4-5-20250929';

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY not set');
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

const EDIT_MANIFEST_SYSTEM = `You are editing a Manifex manifest — natural-language documentation that defines a web app.
The manifest is canonical: every change to the app happens via doc edits.

You will receive the CURRENT MANIFEST and a USER REQUEST. Return the COMPLETE updated manifest as markdown.

Rules:
- Make ONLY the change the user requested. Do not add unrelated content.
- Preserve the existing structure (Overview, Pages, Styles sections).
- Keep the tone natural — this is documentation, not code.
- Return ONLY the new markdown content. No explanations, no commentary, no code fences around the whole thing.
- The first line should remain a top-level heading (# ...).`;

const COMPILE_SYSTEM = `You are a deterministic compiler from natural-language documentation to runnable web code.
Compile a Manifex manifest into a single-page web app with three files.

Output format (STRICT):
Return a JSON object with exactly three string keys: "index.html", "styles.css", "app.js".

Rules:
- index.html: complete HTML5 document. Reference styles.css and app.js via <link> and <script>.
- styles.css: CSS for the app described in the manifest.
- app.js: vanilla JavaScript (no frameworks, no build step, no imports).
- Be deterministic: identical input should produce equivalent output.
- Match what the manifest describes — use page names, section titles, and styling guidance from the doc.
- Return ONLY the JSON object. No explanation, no code fences, no commentary.`;

export async function editManifest(
  currentManifest: string,
  prompt: string,
  options: { variation?: boolean } = {}
): Promise<{ new_manifest: string; diff_summary: string }> {
  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 4096,
    temperature: options.variation ? 0.9 : 0,
    system: EDIT_MANIFEST_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `CURRENT MANIFEST:\n\n${currentManifest}\n\n---\n\nUSER REQUEST: ${prompt}`,
      },
    ],
  });

  const textBlock = resp.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content');
  }

  const new_manifest = textBlock.text.trim();

  // Generate a short diff summary by asking for it inline (cheaper than a 2nd call)
  // For now: derive from the prompt
  const diff_summary = `Edit: ${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}`;

  return { new_manifest, diff_summary };
}

export async function compileManifestToCodex(manifest: string): Promise<CompiledCodex> {
  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 8192,
    temperature: 0,
    system: COMPILE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `MANIFEST:\n\n${manifest}\n\nReturn the JSON object with index.html, styles.css, app.js.`,
      },
    ],
  });

  const textBlock = resp.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM returned no text content');
  }

  // Parse JSON — strip code fences if present
  let raw = textBlock.text.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '');
  }

  let files: any;
  try {
    files = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse compiler JSON: ${(e as Error).message}\nRaw: ${raw.slice(0, 200)}`);
  }

  if (!files['index.html'] || !files['styles.css'] || !files['app.js']) {
    throw new Error(`Compiler JSON missing required keys. Got: ${Object.keys(files).join(', ')}`);
  }

  const codex_sha = sha256(JSON.stringify(files));
  return {
    files: {
      'index.html': files['index.html'],
      'styles.css': files['styles.css'],
      'app.js': files['app.js'],
    },
    codex_sha,
    compiler_version: COMPILER_VERSION,
  };
}
