// LLM compiler service for Manifex.
// Multi-page document editing + compilation.

import Anthropic from '@anthropic-ai/sdk';
import { sha256 } from './crypto';
import type { CompiledCodex, ManifestState, DocPage, TreeNode } from './types';
import { serializePages } from './types';

const COMPILER_VERSION = 'manifex-claude-sonnet-4-v2';
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

// ── Multi-page edit ──

const EDIT_SYSTEM = `You are editing a Manifex documentation collection that defines a web app.
The documentation is organized as multiple pages covering both product specs and technical architecture.
The documentation is canonical: every aspect of the app is defined through these docs.

You will receive ALL CURRENT PAGES and a USER REQUEST.

Rules:
- Return the COMPLETE updated page collection using the update_docs tool.
- Return ALL pages, not just the ones you changed. Unchanged pages must be included as-is.
- Update, create, rename, or delete pages as needed to fulfill the request.
- If this appears to be the FIRST REAL PROMPT (only a basic "Overview" page exists with generic starter content), scaffold a complete documentation structure:
  - Overview: rewritten for the specific app the user wants
  - Architecture: framework choice (default to vanilla JS unless user specifies otherwise), patterns, data flow
  - UI Specs: pages, components, layout, interactions
  - Styles: colors, typography, design system
  - Plus any domain-specific pages appropriate for the app (e.g. Data Model, API Reference)
- Technical pages (Architecture, Data Model) document real decisions that affect how the app is built.
- Product pages (Overview, UI Specs, Styles) describe what the app does and looks like.
- The tree array defines sidebar navigation order. Keep it logical and organized.
- Page paths use lowercase with hyphens for multi-word (e.g. "ui-specs", "data-model", "api-reference").
- Each page's content should be markdown starting with a heading.
- changed_pages should list the paths of pages you modified, created, or removed.
- diff_summary should be a brief user-friendly sentence about what changed.`;

const TREE_NODE_SCHEMA = {
  type: 'object' as const,
  properties: {
    path: { type: 'string' as const, description: 'Page path identifier (e.g. "overview", "architecture", "ui-specs")' },
    title: { type: 'string' as const, description: 'Display title for sidebar' },
    children: {
      type: 'array' as const,
      description: 'Child pages (optional)',
      items: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' as const },
          title: { type: 'string' as const },
        },
        required: ['path' as const, 'title' as const],
      },
    },
  },
  required: ['path' as const, 'title' as const],
};

export interface EditResult {
  pages: { [path: string]: DocPage };
  tree: TreeNode[];
  diff_summary: string;
  changed_pages: string[];
}

export async function editManifest(
  currentState: ManifestState,
  prompt: string,
  options: { variation?: boolean } = {}
): Promise<EditResult> {
  const serialized = serializePages(currentState);

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 16000,
    temperature: options.variation ? 0.9 : 0,
    system: EDIT_SYSTEM,
    tools: [
      {
        name: 'update_docs',
        description: 'Return the complete updated documentation collection.',
        input_schema: {
          type: 'object' as const,
          properties: {
            pages: {
              type: 'object' as const,
              description: 'Complete map of page path to { title, content }. Must include ALL pages.',
              additionalProperties: {
                type: 'object' as const,
                properties: {
                  title: { type: 'string' as const, description: 'Page title' },
                  content: { type: 'string' as const, description: 'Full markdown content of the page' },
                },
                required: ['title' as const, 'content' as const],
              },
            },
            tree: {
              type: 'array' as const,
              description: 'Sidebar navigation tree defining page order and hierarchy',
              items: TREE_NODE_SCHEMA,
            },
            diff_summary: {
              type: 'string' as const,
              description: 'Brief user-friendly summary of changes (1-2 sentences)',
            },
            changed_pages: {
              type: 'array' as const,
              description: 'List of page paths that were modified, created, or deleted',
              items: { type: 'string' as const },
            },
          },
          required: ['pages' as const, 'tree' as const, 'diff_summary' as const, 'changed_pages' as const],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'update_docs' },
    messages: [
      {
        role: 'user',
        content: `CURRENT DOCUMENTATION PAGES:\n\n${serialized}\n\nCURRENT TREE STRUCTURE:\n${JSON.stringify(currentState.tree, null, 2)}\n\n---\n\nUSER REQUEST: ${prompt}`,
      },
    ],
  });

  const toolUse = resp.content.find(b => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('LLM did not call the update_docs tool');
  }

  const input = toolUse.input as {
    pages?: { [path: string]: { title?: string; content?: string } };
    tree?: any[];
    diff_summary?: string;
    changed_pages?: string[];
  };

  if (!input.pages || typeof input.pages !== 'object') {
    throw new Error('LLM returned no pages');
  }
  if (!input.tree || !Array.isArray(input.tree)) {
    throw new Error('LLM returned no tree');
  }

  // Validate and clean pages
  const pages: { [path: string]: DocPage } = {};
  for (const [path, page] of Object.entries(input.pages)) {
    if (page && typeof page.title === 'string' && typeof page.content === 'string') {
      pages[path] = { title: page.title, content: page.content };
    }
  }

  if (Object.keys(pages).length === 0) {
    throw new Error('LLM returned empty pages collection');
  }

  // Validate tree — ensure all referenced paths exist in pages
  function validateTree(nodes: any[]): TreeNode[] {
    return nodes
      .filter((n: any) => n && typeof n.path === 'string' && typeof n.title === 'string')
      .map((n: any) => {
        const node: TreeNode = { path: n.path, title: n.title };
        if (n.children && Array.isArray(n.children) && n.children.length > 0) {
          node.children = validateTree(n.children);
        }
        return node;
      });
  }

  const tree = validateTree(input.tree);

  return {
    pages,
    tree,
    diff_summary: input.diff_summary || `Edit: ${prompt.slice(0, 60)}`,
    changed_pages: Array.isArray(input.changed_pages) ? input.changed_pages : [],
  };
}

// ── Compiler ──

function buildCompilerSystem(state: ManifestState): string {
  // Check if architecture page specifies a framework
  const archPage = state.pages['architecture'] || state.pages['tech'] || state.pages['technical'];
  let frameworkHint = 'vanilla JavaScript (no frameworks, no build step, no imports)';

  if (archPage) {
    const content = archPage.content.toLowerCase();
    if (content.includes('react')) frameworkHint = 'React (loaded via CDN script tags, no build step, use React.createElement or htm tagged templates)';
    else if (content.includes('vue')) frameworkHint = 'Vue 3 (loaded via CDN script tag, use Options API or Composition API with setup())';
    else if (content.includes('svelte')) frameworkHint = 'vanilla JavaScript that mimics Svelte-like reactivity patterns (no build step available)';
    else if (content.includes('alpine')) frameworkHint = 'Alpine.js (loaded via CDN script tag)';
    else if (content.includes('jquery')) frameworkHint = 'jQuery (loaded via CDN script tag)';
  }

  return `You are a deterministic compiler from multi-page documentation to runnable web code.
You will receive a complete documentation collection describing a web app. Compile it into a single-page web app with three files.

Output format (STRICT — use the emit_codex tool):
Return exactly three string fields: index_html, styles_css, app_js.

Rules:
- Read ALL documentation pages to understand the full app spec.
- Technical pages (Architecture, Data Model, API Reference) define HOW to build. Follow their decisions.
- Product pages (Overview, UI Specs, Styles) define WHAT to build. Match their descriptions.
- Use ${frameworkHint} for the implementation.
- index.html: complete HTML5 document. Reference styles.css and app.js via <link> and <script>.
- styles.css: CSS for the app, following the Styles documentation.
- app.js: application logic following the Architecture and UI Specs documentation.
- Be deterministic: identical input should produce equivalent output.
- If documentation pages conflict, prefer the more specific page (e.g. UI Specs overrides Overview).`;
}

export async function compileManifestToCodex(state: ManifestState): Promise<CompiledCodex> {
  const serialized = serializePages(state);
  const systemPrompt = buildCompilerSystem(state);

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 16000,
    temperature: 0,
    system: systemPrompt,
    tools: [
      {
        name: 'emit_codex',
        description: 'Emit the compiled codex as three files.',
        input_schema: {
          type: 'object' as const,
          properties: {
            index_html: { type: 'string' as const, description: 'Complete HTML5 document.' },
            styles_css: { type: 'string' as const, description: 'CSS for the app.' },
            app_js: { type: 'string' as const, description: 'Application JavaScript.' },
          },
          required: ['index_html' as const, 'styles_css' as const, 'app_js' as const],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'emit_codex' },
    messages: [
      {
        role: 'user',
        content: `DOCUMENTATION PAGES:\n\n${serialized}\n\nCompile this into a working web app. Call the emit_codex tool with the three files.`,
      },
    ],
  });

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

  return {
    files,
    codex_sha: sha256(JSON.stringify(files)),
    compiler_version: COMPILER_VERSION,
  };
}
