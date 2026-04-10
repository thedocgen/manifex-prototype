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

// Use Anthropic tool-use mode for guaranteed structured output instead of JSON-mode
// (which can truncate with raw max_tokens limits and produce unparseable strings)
export async function compileManifestToCodex(manifest: string): Promise<CompiledCodex> {
  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 16000,
    temperature: 0,
    system: COMPILE_SYSTEM,
    tools: [
      {
        name: 'emit_codex',
        description: 'Emit the compiled codex as three files.',
        input_schema: {
          type: 'object' as const,
          properties: {
            index_html: { type: 'string' as const, description: 'Complete HTML5 document. Reference styles.css via <link> and app.js via <script>.' },
            styles_css: { type: 'string' as const, description: 'CSS for the app.' },
            app_js: { type: 'string' as const, description: 'Vanilla JavaScript (no frameworks).' },
          },
          required: ['index_html', 'styles_css', 'app_js'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'emit_codex' },
    messages: [
      {
        role: 'user',
        content: `MANIFEST:\n\n${manifest}\n\nCall the emit_codex tool with the three files.`,
      },
    ],
  });

  // Find the tool_use block
  const toolUse = resp.content.find(b => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('LLM did not call the emit_codex tool');
  }

  const input = toolUse.input as { index_html?: string; styles_css?: string; app_js?: string };
  if (!input.index_html || !input.styles_css || !input.app_js) {
    throw new Error(`Compiler tool input missing keys. Got: ${Object.keys(input).join(', ')}`);
  }

  const files = {
    'index.html': input.index_html,
    'styles.css': input.styles_css,
    'app.js': input.app_js,
  };

  const codex_sha = sha256(JSON.stringify(files));
  return {
    files,
    codex_sha,
    compiler_version: COMPILER_VERSION,
  };
}
